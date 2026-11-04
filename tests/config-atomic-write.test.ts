/**
 * saveConfig 原子写的失败分支覆盖(sec-atomic-config-write 评审):
 *
 * 1. POSIX short write:ulimit -f 1 下实测 fs.writeSync(4096) 返回 1024、
 *    不抛错、fsync 成功 —— saveConfig 必须循环写满,写不进(返回 <=0 或
 *    抛错)绝不把截断 payload rename 上位。
 * 2. rename 失败回退直接写:Windows 杀毒/索引器瞬时持有目标文件时 rename
 *    报 EPERM,回退分支是该场景的主保险(e9f47df 的教训:Windows 专属
 *    路径无人看管)。
 * 3. 回退写也失败:回退以 O_TRUNC 打开即截断,写失败(ENOSPC/EIO/锁)会把
 *    「完好但没换上」恶化成「截断损毁」—— saveConfig 先快照原字节,失败时
 *    落 .broken 备份并尽力写回,原错误照抛(响亮失败契约不变)。
 * 4. 备份先于截断(评审第 4 轮):直写窗口内 kill -9/掉电不抛错,catch 里的
 *    备份永远没机会跑 —— .broken 必须在 O_TRUNC 之前落盘;快照读不出来
 *    (EACCES)时响亮拒绝,宁可这轮保存失败也不无备份截断。
 * 5. target 是符号链接(dotfiles 管理形态):rename 会替换链接本体而非写穿,
 *    第一次原子保存就会让用户的链接静默消失 —— lstat 出 symlink 则跳过
 *    rename 直接写穿,保留链接与真身。
 *
 * mock 策略:builtin namespace 属性不可配置,vi.spyOn(fs, 'writeSync') 在
 * ESM 下直接 TypeError(已实测),故用文件级 vi.mock('node:fs') 部分 mock
 * —— factory 透传全部真实实现,只把 writeSync/renameSync/writeFileSync/
 * readFileSync 换成可切换的委托口。独立成文件:config.test.ts 的其余用例
 * 继续走完全真实的 fs。若 CI 上该 mock 对 src/config 内部 import 失效
 * (config.test.ts 注释记载过 doMock('os') 的前科),fake 不会被触发:
 * calls===1 / warn 缺失会让断言显式变红,不会假绿。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveLayout } from '../src/paths';

/** mock 委托口 + 真实实现引用(vi.hoisted:vi.mock factory 只能引用提升变量)。 */
const fsOverride = vi.hoisted(() => ({
  writeSync: undefined as
    | ((fd: number, buf: Buffer, offset?: number, length?: number) => number)
    | undefined,
  renameSync: undefined as ((oldPath: string, newPath: string) => void) | undefined,
  realWriteSync: undefined as
    | ((fd: number, buf: Buffer, offset?: number, length?: number) => number)
    | undefined,
  writeFileSync: undefined as
    | ((file: string, data: string | Buffer, options?: { mode?: number }) => void)
    | undefined,
  realWriteFileSync: undefined as
    | ((file: string, data: string | Buffer, options?: { mode?: number }) => void)
    | undefined,
  readFileSync: undefined as
    | ((
        file: string,
        options?: BufferEncoding | { encoding?: BufferEncoding; flag?: string } | null,
      ) => Buffer | string)
    | undefined,
  realReadFileSync: undefined as
    | ((
        file: string,
        options?: BufferEncoding | { encoding?: BufferEncoding; flag?: string } | null,
      ) => Buffer | string)
    | undefined,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  fsOverride.realWriteSync = actual.writeSync;
  fsOverride.realWriteFileSync = actual.writeFileSync;
  fsOverride.realReadFileSync = actual.readFileSync;
  return {
    ...actual,
    // saveConfig 走 buffer 形式重载 writeSync(fd, buf, offset, length);
    // Parameters<> 会取到 string 重载,故显式声明。
    writeSync: (...args: [fd: number, buf: Buffer, offset?: number, length?: number]) =>
      fsOverride.writeSync ? fsOverride.writeSync(...args) : actual.writeSync(...args),
    renameSync: (...args: [oldPath: string, newPath: string]) =>
      fsOverride.renameSync ? fsOverride.renameSync(...args) : actual.renameSync(...args),
    writeFileSync: (...args: [file: string, data: string | Buffer, options?: { mode?: number }]) =>
      fsOverride.writeFileSync ? fsOverride.writeFileSync(...args) : actual.writeFileSync(...args),
    readFileSync: (
      ...args: [file: string, options?: BufferEncoding | { encoding?: BufferEncoding; flag?: string } | null]
    ) => (fsOverride.readFileSync ? fsOverride.readFileSync(...args) : actual.readFileSync(...args)),
  };
});

function expectedConfigDir(home: string): string {
  return process.platform === 'win32' ? join(home, '.pi') : join(home, '.config', 'pi-courier');
}

describe('saveConfig 原子写失败分支(short write / rename 回退)(sec-atomic-config-write)', () => {
  let tmpDir: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'pi-courier-atomic-'));
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    fsOverride.writeSync = undefined;
    fsOverride.renameSync = undefined;
    fsOverride.writeFileSync = undefined;
    fsOverride.readFileSync = undefined;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function importConfig() {
    // 布局显式注入(测试缝,同 tests/config.test.ts):不依赖 builtin mock。
    const cfg = await import('../src/config');
    cfg.setRuntimeLayoutForTests(
      resolveLayout({ platform: process.platform, homedir: tmpDir, env: {} }),
      tmpDir,
    );
    return cfg;
  }

  const PAYLOAD = {
    workdir: '/loop/w',
    matrix: { homeserverUrl: 'https://m.example.com', accessToken: 'syt-loop' },
  };

  it('short write 后循环续写:单次 writeSync 只落一半字节时补齐,文件完整', async () => {
    let calls = 0;
    fsOverride.writeSync = (fd, buf, offset, length) => {
      calls++;
      if (calls === 1) {
        // 模拟 POSIX short write:第一次只真实落一半字节
        return fsOverride.realWriteSync!(fd, buf, 0, Math.floor(buf.length / 2));
      }
      return fsOverride.realWriteSync!(fd, buf, offset, length); // 续写走真实实现
    };

    const { saveConfig } = await importConfig();
    saveConfig(PAYLOAD);

    expect(calls).toBeGreaterThan(1); // 确实走了续写,而非一次写完
    const onDisk = JSON.parse(readFileSync(join(expectedConfigDir(tmpDir), 'pi-courier.json'), 'utf-8'));
    expect(onDisk).toEqual(PAYLOAD);
    // 成功路径无临时文件残留
    expect(readdirSync(expectedConfigDir(tmpDir)).filter((e) => e.includes('.tmp-'))).toEqual([]);
  });

  it('short write 补不上(write 返回 0,ENOSPC 极端形态):抛错、绝不 rename 截断 payload、原配置字节原样', async () => {
    mkdirSync(expectedConfigDir(tmpDir), { recursive: true });
    const configPath = join(expectedConfigDir(tmpDir), 'pi-courier.json');
    const original = '{"matrix":{"accessToken":"syt-keep"}}';
    writeFileSync(configPath, original, { mode: 0o600 });

    let calls = 0;
    fsOverride.writeSync = (fd, buf) => {
      calls++;
      if (calls === 1) {
        return fsOverride.realWriteSync!(fd, buf, 0, Math.floor(buf.length / 2)); // 先落一半
      }
      return 0; // 之后磁盘写不进:不抛错、不前进(ENOSPC 极端形态)
    };

    const { saveConfig } = await importConfig();
    expect(() => saveConfig(PAYLOAD)).toThrow(/Short write/);

    // 原配置一个字节都没动:写残的 temp 被 finally 清理,从未 rename 上位
    expect(readFileSync(configPath, 'utf-8')).toBe(original);
    expect(readdirSync(expectedConfigDir(tmpDir)).filter((e) => e.includes('.tmp-'))).toEqual([]);
  });

  it('rename 失败(Windows EPERM 场景)回退直接写:落盘成功、打 warn、无 .tmp 残留', async () => {
    fsOverride.renameSync = () => {
      throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
    };
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { saveConfig } = await importConfig();
    try {
      saveConfig({ workdir: '/fallback/w' });

      const piDir = expectedConfigDir(tmpDir);
      // 回退路径直接写目标,内容完整落盘
      expect(JSON.parse(readFileSync(join(piDir, 'pi-courier.json'), 'utf-8'))).toEqual({ workdir: '/fallback/w' });
      // 回退有响亮告警,不是静默降级
      expect(warnSpy.mock.calls.map(String).join('\n')).toContain('falling back to direct write');
      // 首次保存(target 本就不存在):快照 ENOENT 照常直写,无原字节可备份也不误建
      expect(existsSync(join(piDir, 'pi-courier.json.broken'))).toBe(false);
      // 未被 rename 消费的 temp 在 finally 里清掉
      expect(readdirSync(piDir).filter((e) => e.includes('.tmp-'))).toEqual([]);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('rename 失败且回退写也失败(O_TRUNC 截断后 EIO):.broken 保住原字节并写回,原配置可找回', async () => {
    mkdirSync(expectedConfigDir(tmpDir), { recursive: true });
    const configPath = join(expectedConfigDir(tmpDir), 'pi-courier.json');
    const original = '{"matrix":{"accessToken":"syt-keep"}}';
    writeFileSync(configPath, original, { mode: 0o600 });

    fsOverride.renameSync = () => {
      throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
    };
    // 回退直写以 'w' 打开即截断:现实里 ENOSPC/杀软独占锁中途干预就发生在这个
    // 窗口,target 此刻已是 0 字节。fake 对「第一次写 target」先真实截断再抛
    // EIO 复刻该形态;.broken 备份(已提前落盘)与 preserve 阶段的写回放行真实实现。
    let targetWrites = 0;
    fsOverride.writeFileSync = (file, data, options) => {
      if (String(file) === configPath) {
        targetWrites++;
        if (targetWrites === 1) {
          fsOverride.realWriteFileSync!(configPath, Buffer.alloc(0), options); // 截断发生
          throw Object.assign(new Error('EIO: i/o error, write'), { code: 'EIO' });
        }
      }
      return fsOverride.realWriteFileSync!(file, data, options); // .broken 备份/preserve 写回放行
    };
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { saveConfig } = await importConfig();
    try {
      // 响亮失败契约不变:回退失败的错误照抛(setup 直接调 saveConfig 要炸出声)
      expect(() => saveConfig({ workdir: '/w' })).toThrow(/EIO|i\/o error/);

      // 原字节两处可找回:.broken 备份(新增文件,最可能成功)+ 写回的 config.json
      expect(readFileSync(join(expectedConfigDir(tmpDir), 'pi-courier.json.broken'), 'utf-8')).toBe(original);
      expect(readFileSync(configPath, 'utf-8')).toBe(original);
      // 未被 rename 消费的 temp 照旧清理
      expect(readdirSync(expectedConfigDir(tmpDir)).filter((e) => e.includes('.tmp-'))).toEqual([]);
    } finally {
      errSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it('rename 失败回退直写成功:.broken 已在 O_TRUNC 之前落盘且内容为原字节(崩溃窗口封死)', async () => {
    mkdirSync(expectedConfigDir(tmpDir), { recursive: true });
    const configPath = join(expectedConfigDir(tmpDir), 'pi-courier.json');
    const brokenPath = join(expectedConfigDir(tmpDir), 'pi-courier.json.broken');
    const original = '{"matrix":{"accessToken":"syt-keep"}}';
    writeFileSync(configPath, original, { mode: 0o600 });

    fsOverride.renameSync = () => {
      throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
    };
    // 钉住时序:target 被 O_TRUNC 直写的那一刻(等价于进程恰在此窗口内被
    // kill -9/掉电,后续 catch 永远没机会跑),.broken 必须已经在盘上 ——
    // 备份先于截断,原字节不再只存在于内存快照里。
    let brokenOnDiskAtTruncate: boolean | undefined;
    fsOverride.writeFileSync = (file, data, options) => {
      if (String(file) === configPath) {
        brokenOnDiskAtTruncate = existsSync(brokenPath);
      }
      return fsOverride.realWriteFileSync!(file, data, options);
    };

    const { saveConfig } = await importConfig();
    saveConfig({ workdir: '/w' });

    // O_TRUNC 发生时备份已在盘上(顺序反了这条会红)
    expect(brokenOnDiskAtTruncate).toBe(true);
    // 保存照常成功落盘
    expect(JSON.parse(readFileSync(configPath, 'utf-8'))).toEqual({ workdir: '/w' });
    // 原字节在 .broken 可找回
    expect(readFileSync(brokenPath, 'utf-8')).toBe(original);
    expect(readdirSync(expectedConfigDir(tmpDir)).filter((e) => e.includes('.tmp-'))).toEqual([]);
  });

  it('快照读取 EACCES:响亮拒绝直写抛错,target 字节原样(宁可这轮保存失败也不无备份截断)', async () => {
    mkdirSync(expectedConfigDir(tmpDir), { recursive: true });
    const configPath = join(expectedConfigDir(tmpDir), 'pi-courier.json');
    const original = '{"matrix":{"accessToken":"syt-keep"}}';
    writeFileSync(configPath, original, { mode: 0o600 });

    fsOverride.renameSync = () => {
      throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
    };
    // 快照读不出来(EACCES 等非 ENOENT 错误):直写以 O_TRUNC 打开即截断,
    // 没有备份就动 target 等于裸奔 —— 必须在截断之前响亮失败。
    // 注入 fake 而非 chmod 0o000:CI 以 root 跑时绕过 DAC,权限挡不住 root。
    fsOverride.readFileSync = (file, options) => {
      if (String(file) === configPath) {
        throw Object.assign(new Error('EACCES: permission denied, open'), { code: 'EACCES' });
      }
      return fsOverride.realReadFileSync!(file, options);
    };

    const { saveConfig } = await importConfig();
    expect(() => saveConfig({ workdir: '/w' })).toThrow(/Refusing to overwrite config without backup/);

    // target 一个字节没动:拒绝发生在 O_TRUNC 之前
    expect(fsOverride.realReadFileSync!(configPath, 'utf-8')).toBe(original);
    expect(existsSync(join(expectedConfigDir(tmpDir), 'pi-courier.json.broken'))).toBe(false);
    expect(readdirSync(expectedConfigDir(tmpDir)).filter((e) => e.includes('.tmp-'))).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('target 是符号链接(dotfiles 写穿形态):跳过 rename,链接本体保留、真身更新', async () => {
    const piDir = expectedConfigDir(tmpDir);
    mkdirSync(piDir, { recursive: true });
    const realFile = join(piDir, 'real-config.json');
    const configPath = join(piDir, 'pi-courier.json');
    const original = '{"matrix":{"accessToken":"syt-keep"}}';
    writeFileSync(realFile, original, { mode: 0o600 });
    symlinkSync(realFile, configPath);

    const { saveConfig } = await importConfig();
    saveConfig(PAYLOAD);

    // 链接本体没有被 rename 换掉:仍是符号链接且仍指向真身
    // (若走了 rename,这里会变成普通文件,断言显式变红)
    expect(lstatSync(configPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(configPath)).toBe(realFile);
    // 写穿:真身更新为新配置,经链接读同样拿到新配置
    expect(JSON.parse(readFileSync(realFile, 'utf-8'))).toEqual(PAYLOAD);
    expect(JSON.parse(readFileSync(configPath, 'utf-8'))).toEqual(PAYLOAD);
    // 写穿同样先落 .broken:O_TRUNC 直写前的原字节可找回
    expect(readFileSync(join(piDir, 'pi-courier.json.broken'), 'utf-8')).toBe(original);
    expect(readdirSync(piDir).filter((e) => e.includes('.tmp-'))).toEqual([]);
  });

  it('合法配置加载不产生 .broken 备份(防 mock 文件干扰的锚:本文件默认全真实透传)', async () => {
    const { saveConfig, loadConfig } = await importConfig();
    saveConfig({ workdir: '/ok' });
    loadConfig();
    expect(existsSync(join(expectedConfigDir(tmpDir), 'pi-courier.json.broken'))).toBe(false);
  });
});
