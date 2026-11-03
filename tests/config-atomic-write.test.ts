/**
 * saveConfig 原子写的两个失败分支覆盖(sec-atomic-config-write 评审):
 *
 * 1. POSIX short write:ulimit -f 1 下实测 fs.writeSync(4096) 返回 1024、
 *    不抛错、fsync 成功 —— saveConfig 必须循环写满,写不进(返回 <=0 或
 *    抛错)绝不把截断 payload rename 上位。
 * 2. rename 失败回退直接写:Windows 杀毒/索引器瞬时持有目标文件时 rename
 *    报 EPERM,回退分支是该场景的主保险(e9f47df 的教训:Windows 专属
 *    路径无人看管)。
 *
 * mock 策略:builtin namespace 属性不可配置,vi.spyOn(fs, 'writeSync') 在
 * ESM 下直接 TypeError(已实测),故用文件级 vi.mock('node:fs') 部分 mock
 * —— factory 透传全部真实实现,只把 writeSync/renameSync 换成可切换的
 * 委托口。独立成文件:config.test.ts 的其余用例继续走完全真实的 fs。
 * 若 CI 上该 mock 对 src/config 内部 import 失效(config.test.ts 注释记载
 * 过 doMock('os') 的前科),fake 不会被触发:calls===1 / warn 缺失会让
 * 断言显式变红,不会假绿。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  fsOverride.realWriteSync = actual.writeSync;
  return {
    ...actual,
    // saveConfig 走 buffer 形式重载 writeSync(fd, buf, offset, length);
    // Parameters<> 会取到 string 重载,故显式声明。
    writeSync: (...args: [fd: number, buf: Buffer, offset?: number, length?: number]) =>
      fsOverride.writeSync ? fsOverride.writeSync(...args) : actual.writeSync(...args),
    renameSync: (...args: [oldPath: string, newPath: string]) =>
      fsOverride.renameSync ? fsOverride.renameSync(...args) : actual.renameSync(...args),
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
      // 未被 rename 消费的 temp 在 finally 里清掉
      expect(readdirSync(piDir).filter((e) => e.includes('.tmp-'))).toEqual([]);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('合法配置加载不产生 .broken 备份(防 mock 文件干扰的锚:本文件默认全真实透传)', async () => {
    const { saveConfig, loadConfig } = await importConfig();
    saveConfig({ workdir: '/ok' });
    loadConfig();
    expect(existsSync(join(expectedConfigDir(tmpDir), 'pi-courier.json.broken'))).toBe(false);
  });
});
