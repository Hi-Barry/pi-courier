import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { resolveLayout } from '../src/paths';
import { tmpdir } from 'os';

/** 配置目录按平台分支(spec #258 票03 布局冻结):win32 = ~/.pi,其余平台
 *  = ~/.config/pi-courier。测试断言经它计算,与布局解析保持同构。 */
function expectedConfigDir(home: string): string {
  return process.platform === 'win32' ? join(home, '.pi') : join(home, '.config', 'pi-courier');
}

describe('config', () => {
  let tmpDir: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'pi-courier-config-'));
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function importConfig() {
    // 布局显式注入(测试缝):不依赖 builtin mock —— CI 上 vi.doMock('os')
    // 对 src/config 内部 import 会失效,读到真实 HOME(诊断已确认)。
    const cfg = await import('../src/config');
    cfg.setRuntimeLayoutForTests(
      resolveLayout({ platform: process.platform, homedir: tmpDir, env: {} }),
      tmpDir
    );
    return cfg;
  }

  it('returns empty config when no file exists', async () => {
    const { loadConfig } = await importConfig();
    expect(loadConfig()).toEqual({});
  });

  it('env overrides matrix + trusted users + workdir + logLevel', async () => {
    process.env.PI_MATRIX_HOMESERVER = 'https://env.example.com';
    process.env.PI_MATRIX_ACCESS_TOKEN = 'syt-env-token';
    process.env.PI_MATRIX_ENCRYPTION = 'false';
    process.env.PI_MATRIX_TRUSTED_USERS = '@barry:matrix.example.com, @alice:matrix.example.com';
    process.env.PI_WORKDIR = '/env/work';
    process.env.PI_LOG_LEVEL = 'debug';
    const { loadConfig } = await importConfig();

    const cfg = loadConfig();
    expect(cfg.matrix).toEqual({
      homeserverUrl: 'https://env.example.com',
      accessToken: 'syt-env-token',
      encryption: false,
    });
    expect(cfg.auth?.trustedUsers).toEqual([
      'matrix:@barry:matrix.example.com',
      'matrix:@alice:matrix.example.com',
    ]);
    expect(cfg.auth?.adminUserId).toBe('matrix:@barry:matrix.example.com');
    expect(cfg.workdir).toBe('/env/work');
    expect(cfg.logLevel).toBe('debug');
  });

  it('env trusted users without matrix leaves file config intact', async () => {
    const { loadConfig, saveConfig } = await importConfig();
    saveConfig({ matrix: { homeserverUrl: 'https://file.example.com', accessToken: 'syt-file' }, workdir: '/file/work' });
    process.env.PI_MATRIX_TRUSTED_USERS = '@barry:matrix.example.com';
    const cfg = loadConfig();
    expect(cfg.matrix?.homeserverUrl).toBe('https://file.example.com');
    expect(cfg.auth?.trustedUsers).toEqual(['matrix:@barry:matrix.example.com']);
    expect(cfg.workdir).toBe('/file/work');
  });

  it('saves and loads config roundtrip', async () => {
    const { loadConfig, saveConfig } = await importConfig();

    saveConfig({ matrix: { homeserverUrl: 'https://m.example.com', accessToken: 'syt-1' }, autoConnect: true, debug: false });
    const loaded = loadConfig();

    expect(loaded.matrix?.accessToken).toBe('syt-1');
    expect(loaded.autoConnect).toBe(true);
    expect(loaded.debug).toBe(false);
  });

  it('saves and loads proxy settings roundtrip (spec #201 票 #202)', async () => {
    const { loadConfig, saveConfig } = await importConfig();

    saveConfig({ proxy: 'http://outbound:10809', noProxy: ['intra.example.com', '10.0.0.0/8'] });
    const loaded = loadConfig();

    expect(loaded.proxy).toBe('http://outbound:10809');
    expect(loaded.noProxy).toEqual(['intra.example.com', '10.0.0.0/8']);
  });

  // POSIX mode bits: libuv reports only 0666/0444 for regular files/dirs on
  // Windows — these assertions are meaningless there (see src/config.ts).
  it.skipIf(process.platform === "win32")('creates .pi directory with 700 permissions', async () => {
    const { saveConfig } = await importConfig();
    saveConfig({});

    const stats = statSync(expectedConfigDir(tmpDir));
    expect(stats.mode & 0o777).toBe(0o700);
  });

  it.skipIf(process.platform === "win32")('writes config file with 600 permissions', async () => {
    const { saveConfig } = await importConfig();
    saveConfig({});

    const stats = statSync(join(expectedConfigDir(tmpDir), 'pi-courier.json'));
    expect(stats.mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform === "win32")('tightens a pre-existing loose config file to 600 (audit batch 1 票8)', async () => {
    mkdirSync(expectedConfigDir(tmpDir), { recursive: true });
    const configPath = join(expectedConfigDir(tmpDir), 'pi-courier.json');
    writeFileSync(configPath, '{"legacy": true}', { mode: 0o644 });
    expect(statSync(configPath).mode & 0o777).toBe(0o644);

    const { saveConfig } = await importConfig();
    saveConfig({ debug: true });

    expect(statSync(configPath).mode & 0o777).toBe(0o600);
    expect(statSync(expectedConfigDir(tmpDir)).mode & 0o777).toBe(0o700);
  });

  it('ConfigStore.update survives an injected persist failure without throwing (audit batch 1 票8)', async () => {
    // The config DIR exists as a regular FILE → saveConfig's writeFileSync
    // throws(ENOTDIR)。configDir = 布局解析(票03);先建它的父目录再落文件。
    mkdirSync(dirname(expectedConfigDir(tmpDir)), { recursive: true });
    writeFileSync(expectedConfigDir(tmpDir), 'not a directory');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const { ConfigStore } = await importConfig();
      const store = new ConfigStore({ debug: true });
      expect(() => store.update({ logLevel: 'debug' })).not.toThrow();
      // The in-memory copy stays authoritative despite the disk failure.
      expect(store.get().logLevel).toBe('debug');
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('env vars override file values for the same transport', async () => {
    const { loadConfig, saveConfig } = await importConfig();

    saveConfig({ matrix: { homeserverUrl: 'https://m.example.com', accessToken: 'syt-file' }, autoConnect: true });
    process.env.PI_MATRIX_HOMESERVER = 'https://env.example.com';
    process.env.PI_MATRIX_ACCESS_TOKEN = 'syt-env';

    const loaded = loadConfig();
    expect(loaded.matrix?.accessToken).toBe('syt-env');
    expect(loaded.matrix?.homeserverUrl).toBe('https://env.example.com');
    // Non-overridden fields survive
    expect(loaded.autoConnect).toBe(true);
  });

  it('loads all transport env vars', async () => {
    process.env.PI_MATRIX_HOMESERVER = 'https://matrix.example.com';
    process.env.PI_MATRIX_ACCESS_TOKEN = 'syt-test';

    const { loadConfig } = await importConfig();
    const config = loadConfig();

    expect(config.matrix?.homeserverUrl).toBe('https://matrix.example.com');
    expect(config.matrix?.accessToken).toBe('syt-test');
  });

  it('handles corrupted config file gracefully', async () => {
    const piDir = expectedConfigDir(tmpDir);
    mkdirSync(piDir, { recursive: true });
    writeFileSync(join(piDir, 'pi-courier.json'), '{invalid json!!!');

    const { loadConfig } = await importConfig();
    // Should not throw, returns empty config
    const config = loadConfig();
    expect(config).toEqual({});
  });

  it('still applies env vars when config file is corrupted', async () => {
    const piDir = expectedConfigDir(tmpDir);
    mkdirSync(piDir, { recursive: true });
    writeFileSync(join(piDir, 'pi-courier.json'), 'not json');

    process.env.PI_MATRIX_HOMESERVER = 'https://matrix.example.com';
    process.env.PI_MATRIX_ACCESS_TOKEN = 'syt-env';

    const { loadConfig } = await importConfig();
    const config = loadConfig();
    expect(config.matrix?.accessToken).toBe('syt-env');
  });

  // ── 原子写与坏配置保全(sec-atomic-config-write)────────────────────
  it('saveConfig 原子落盘:成功后无 .tmp 残留,内容完整可解析', async () => {
    const { saveConfig } = await importConfig();
    saveConfig({ workdir: '/atomic/w' });

    const piDir = expectedConfigDir(tmpDir);
    // 临时文件只应存在于写窗口内:成功路径上必须已被 rename 消费掉。
    expect(readdirSync(piDir).filter((e) => e.includes('.tmp-'))).toEqual([]);
    expect(JSON.parse(readFileSync(join(piDir, 'pi-courier.json'), 'utf-8'))).toEqual({ workdir: '/atomic/w' });
  });

  it.skipIf(process.platform === 'win32')('saveConfig 写入失败(目录只读)时抛错、原配置字节原样、不留 .tmp 残留', async () => {
    mkdirSync(expectedConfigDir(tmpDir), { recursive: true });
    const configPath = join(expectedConfigDir(tmpDir), 'pi-courier.json');
    const original = '{"matrix":{"accessToken":"syt-keep"}}';
    writeFileSync(configPath, original, { mode: 0o600 });

    const { saveConfig } = await importConfig();
    // 只读目录:temp 文件创建必失败(旧实现会在这里直接截断原文件——
    // writeFileSync 打开目标即清空;原子写下目标在 rename 前不被触碰)。
    chmodSync(expectedConfigDir(tmpDir), 0o500);
    try {
      expect(() => saveConfig({ workdir: '/x' })).toThrow();
      expect(readFileSync(configPath, 'utf-8')).toBe(original);
      expect(readdirSync(expectedConfigDir(tmpDir)).filter((e) => e.includes('.tmp-'))).toEqual([]);
    } finally {
      chmodSync(expectedConfigDir(tmpDir), 0o700); // 还原,让 afterEach 能清理
    }
  });

  it('loadConfig 遇坏 JSON:原文件字节保留为 .broken 备份;后续 update 覆写后仍可找回', async () => {
    const piDir = expectedConfigDir(tmpDir);
    mkdirSync(piDir, { recursive: true });
    const configPath = join(piDir, 'pi-courier.json');
    // 截断在写窗口内的残缺 JSON(旧原子性缺陷的典型产物)
    const corrupt = '{"matrix":{"accessToken":"syt-ledger","homeserverUrl":"https://m.example.com"';
    writeFileSync(configPath, corrupt, 'utf-8');

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { ConfigStore } = await importConfig();
      const store = new ConfigStore(); // 构造时 loadConfig:解析失败 → 备份 + 空配置
      store.update({ workdir: '/fresh' }); // 残缺配置覆写 config.json(旧行为:原字节就此丢失)

      // 原始字节完整保留在 .broken
      expect(readFileSync(join(piDir, 'pi-courier.json.broken'), 'utf-8')).toBe(corrupt);
      // config.json 已被新配置替换(读-改-写链路不受影响)
      expect(JSON.parse(readFileSync(configPath, 'utf-8'))).toEqual({ workdir: '/fresh' });
      expect(warnSpy.mock.calls.map(String).join('\n')).toContain('.broken');
      expect(errSpy).toHaveBeenCalled(); // 原有 "Failed to load config file" 行为不变
    } finally {
      errSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it('.broken 备份固定名覆盖写,不随启动次数累积', async () => {
    const piDir = expectedConfigDir(tmpDir);
    mkdirSync(piDir, { recursive: true });
    writeFileSync(join(piDir, 'pi-courier.json'), 'bad one', 'utf-8');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { loadConfig } = await importConfig();
      loadConfig();
      writeFileSync(join(piDir, 'pi-courier.json'), 'bad two', 'utf-8');
      loadConfig(); // 第二次坏加载 → 覆盖同一备份

      expect(readFileSync(join(piDir, 'pi-courier.json.broken'), 'utf-8')).toBe('bad two');
      expect(readdirSync(piDir).filter((e) => e.includes('.broken'))).toEqual(['pi-courier.json.broken']);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('合法配置加载不产生 .broken 备份(备份只属坏 JSON 解析路径)', async () => {
    const { saveConfig, loadConfig } = await importConfig();
    saveConfig({ workdir: '/ok' });
    loadConfig();
    expect(existsSync(join(expectedConfigDir(tmpDir), 'pi-courier.json.broken'))).toBe(false);
  });

  it('requires both Matrix home server and access token for matrix config', async () => {
    // Only homeserver — should not set matrix
    process.env.PI_MATRIX_HOMESERVER = 'https://matrix.example.com';

    const { loadConfig } = await importConfig();
    expect(loadConfig().matrix).toBeUndefined();
  });

  it('saves and loads hideToolCalls config', async () => {
    const { loadConfig, saveConfig } = await importConfig();

    saveConfig({ hideToolCalls: true, autoConnect: true });
    const loaded = loadConfig();

    expect(loaded.hideToolCalls).toBe(true);
    expect(loaded.autoConnect).toBe(true);
  });

  it('hideToolCalls defaults to undefined (not hidden)', async () => {
    const { loadConfig } = await importConfig();
    expect(loadConfig().hideToolCalls).toBeUndefined();
  });
  it('projects 畸形条目(null/标量)加载时清洗剔除并警告,不炸启动(审计稳定性批 票15)', async () => {
    mkdirSync(expectedConfigDir(tmpDir), { recursive: true });
    writeFileSync(
      join(expectedConfigDir(tmpDir), 'pi-courier.json'),
      JSON.stringify({
        projects: {
          '!good:server': { name: 'ok' },
          '!null:server': null,
          '!scalar:server': 'oops',
        },
        workdir: '/tmp/w',
      }),
      'utf-8',
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { loadConfig } = await importConfig();
      const cfg = loadConfig();
      expect(cfg.workdir).toBe('/tmp/w');
      expect(Object.keys(cfg.projects ?? {}).sort()).toEqual(['!good:server']);
      expect(warnSpy.mock.calls.map(String).join('\n')).toContain('not an object');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('配置根为数组时整体忽略文件内容,加载不抛(审计稳定性批 票15)', async () => {
    mkdirSync(expectedConfigDir(tmpDir), { recursive: true });
    writeFileSync(join(expectedConfigDir(tmpDir), 'pi-courier.json'), '[1,2,3]', 'utf-8');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { loadConfig } = await importConfig();
      expect(loadConfig()).toEqual({});
      expect(warnSpy.mock.calls.map(String).join('\n')).toContain('not an object');
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('ConfigStore', () => {
  let tmpDir: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'pi-courier-store-'));
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function importConfig() {
    // 布局显式注入(测试缝):不依赖 builtin mock —— CI 上 vi.doMock('os')
    // 对 src/config 内部 import 会失效,读到真实 HOME(诊断已确认)。
    const cfg = await import('../src/config');
    cfg.setRuntimeLayoutForTests(
      resolveLayout({ platform: process.platform, homedir: tmpDir, env: {} }),
      tmpDir
    );
    return cfg;
  }

  // POSIX mode bits: meaningless on Windows (libuv reports 0666/0444 only).
  it.skipIf(process.platform === "win32")('persists updates to disk with 600 permissions and no format change', async () => {
    const { ConfigStore } = await importConfig();
    const piDir = expectedConfigDir(tmpDir);
    const path = join(piDir, 'pi-courier.json');

    const store = new ConfigStore({ autoConnect: true });
    store.update({ managementRooms: ['!r:server'] });

    const stat = statSync(path);
    expect(stat.mode & 0o777).toBe(0o600);
    const onDisk = JSON.parse(readFileSync(path, 'utf-8'));
    // Both fields survive — an update never drops unrelated config.
    expect(onDisk.autoConnect).toBe(true);
    expect(onDisk.managementRooms).toEqual(['!r:server']);
  });

  it('interleaved updates never lose a concurrent writer\'s field', async () => {
    const { ConfigStore } = await importConfig();
    const store = new ConfigStore();

    // Simulates the old race: writer A and writer B each computed a patch
    // from the same base state, then both persisted.
    store.update({ multiProject: true });
    store.update({ managementRooms: ['!r:server'] });

    expect(store.get().multiProject).toBe(true);
    expect(store.get().managementRooms).toEqual(['!r:server']);
  });

  it('a writer that snapshots before an await cannot erase fields written during it', async () => {
    const { ConfigStore } = await importConfig();
    const store = new ConfigStore({ hideToolCalls: true });

    // The old whole-file-overwrite pattern held a full config snapshot
    // across an await (e.g. management-room branding's setRoomName) and
    // then saved it — erasing anything another writer persisted during the
    // await. update() merges into the CURRENT in-memory state instead.
    const staleSnapshot = store.get();
    await Promise.resolve(); // writer B's turn during writer A's await
    store.update({ multiProject: true });
    store.update({ managementRooms: [...(staleSnapshot.managementRooms ?? []), '!r:server'] });

    expect(store.get().multiProject).toBe(true); // survives the late writer
    expect(store.get().hideToolCalls).toBe(true);
    expect(store.get().managementRooms).toEqual(['!r:server']);
  });

  it('constructed with an initial object it never touches the disk', async () => {
    const { ConfigStore } = await importConfig();
    const store = new ConfigStore({ projects: { '!p:server': { workdir: '/w' } } });

    expect(store.get().projects?.['!p:server'].workdir).toBe('/w');
    expect(existsSync(expectedConfigDir(tmpDir))).toBe(false);
  });

  it('without an initial object it loads once from disk', async () => {
    const piDir = expectedConfigDir(tmpDir);
    mkdirSync(piDir, { recursive: true });
    writeFileSync(join(piDir, 'pi-courier.json'), JSON.stringify({ workdir: '/from/disk' }));

    const { ConfigStore } = await importConfig();
    const store = new ConfigStore();

    expect(store.get().workdir).toBe('/from/disk');
    // Later disk edits are NOT re-read (loaded once at construction).
    writeFileSync(join(piDir, 'pi-courier.json'), JSON.stringify({ workdir: '/changed' }));
    expect(store.get().workdir).toBe('/from/disk');
  });

  it('adoptManagementRoom: 未配置/空列表时收养为首个条目(域入口,读-改-写收进 store)', async () => {
    const { ConfigStore } = await importConfig();
    const empty = new ConfigStore({});
    expect(empty.adoptManagementRoom('!dm:server')).toBe(true);
    expect(empty.get().managementRooms).toEqual(['!dm:server']);

    const blank = new ConfigStore({ managementRooms: [] });
    expect(blank.adoptManagementRoom('!dm:server')).toBe(true);
    expect(blank.get().managementRooms).toEqual(['!dm:server']);
  });

  it('adoptManagementRoom: 已有管理房拒绝再写(架构候选4 不变量);重复收养幂等不产生重复条目', async () => {
    const { ConfigStore } = await importConfig();
    const store = new ConfigStore({ managementRooms: ['!a:server'] });
    expect(store.adoptManagementRoom('!dm:server')).toBe(false);
    expect(store.get().managementRooms).toEqual(['!a:server']);
    // 收养已列内的房间同样拒绝(列表非空即拒),无重复条目
    expect(store.adoptManagementRoom('!a:server')).toBe(false);
    expect(store.get().managementRooms).toEqual(['!a:server']);
  });

  it('updateSpace: 对象 patch 浅合并进现有 space,兄弟字段不丢', async () => {
    const { ConfigStore } = await importConfig();
    const store = new ConfigStore({ space: { enabled: true, roomId: '!s:server' } });
    store.updateSpace({ invitedUsers: ['matrix:@u:server'] });
    expect(store.get().space).toEqual({
      enabled: true,
      roomId: '!s:server',
      invitedUsers: ['matrix:@u:server'],
    });
  });

  it('updateSpace: 函数式 patch 基于此刻权威 space —— 两个先后追加不互相覆盖', async () => {
    const { ConfigStore } = await importConfig();
    const store = new ConfigStore({});
    store.updateSpace((space) => {
      const patch: Record<string, string[]> = {};
      patch.invitedUsers = [...(space.invitedUsers ?? []), 'matrix:@a:server'];
      return patch;
    });
    store.updateSpace((space) => {
      const patch: Record<string, string[]> = {};
      patch.invitedUsers = [...(space.invitedUsers ?? []), 'matrix:@b:server'];
      return patch;
    });
    expect(store.get().space?.invitedUsers).toEqual(['matrix:@a:server', 'matrix:@b:server']);
  });
});

describe('config 派生函数族 — 管理房间(spec #99 票6 / issue #102)', () => {
  it('managementRoomId: 未配置返回 undefined', async () => {
    const { managementRoomId } = await import('../src/config');
    expect(managementRoomId({})).toBeUndefined();
  });

  it('managementRoomId: 空列表返回 undefined(= 还没有管理房)', async () => {
    const { managementRoomId } = await import('../src/config');
    expect(managementRoomId({ managementRooms: [] })).toBeUndefined();
  });

  it('managementRoomId: 取首个 — 公开语义是单管理房,"取首个"是有意为之', async () => {
    const { managementRoomId } = await import('../src/config');
    expect(managementRoomId({ managementRooms: ['!a:server', '!b:server'] })).toBe('!a:server');
    expect(managementRoomId({ managementRooms: ['!mgmt:server'] })).toBe('!mgmt:server');
  });
});

describe('config 派生函数族 — bashOutputLimit(默认 30000,64KB 钳制)', () => {
  it('缺省回落默认值 30000', async () => {
    const { bashOutputLimit, BASH_OUTPUT_LIMIT_DEFAULT, BASH_OUTPUT_LIMIT_MAX } = await import('../src/config');
    expect(BASH_OUTPUT_LIMIT_DEFAULT).toBe(30000);
    expect(BASH_OUTPUT_LIMIT_MAX).toBe(64 * 1024);
    expect(bashOutputLimit({})).toBe(30000);
    expect(bashOutputLimit({ bashOutputLimit: undefined })).toBe(30000);
  });

  it('合法值原样通过', async () => {
    const { bashOutputLimit } = await import('../src/config');
    expect(bashOutputLimit({ bashOutputLimit: 1 })).toBe(1);
    expect(bashOutputLimit({ bashOutputLimit: 50000 })).toBe(50000);
  });

  it('超过 64KB 硬顶钳制到 65536(Matrix 单事件上限,再大回帖必被 homeserver 拒)', async () => {
    const { bashOutputLimit } = await import('../src/config');
    expect(bashOutputLimit({ bashOutputLimit: 65537 })).toBe(65536);
    expect(bashOutputLimit({ bashOutputLimit: 1_000_000 })).toBe(65536);
  });

  it('手编杂值白名单归一:非正数/非有限数按缺省处理,小数取整', async () => {
    const { bashOutputLimit } = await import('../src/config');
    expect(bashOutputLimit({ bashOutputLimit: 0 })).toBe(30000);
    expect(bashOutputLimit({ bashOutputLimit: -5 })).toBe(30000);
    expect(bashOutputLimit({ bashOutputLimit: Number.NaN })).toBe(30000);
    expect(bashOutputLimit({ bashOutputLimit: Number.POSITIVE_INFINITY })).toBe(30000);
    expect(bashOutputLimit({ bashOutputLimit: 100.9 })).toBe(100);
  });
});

describe('config 派生函数族 — toolCallArgLimit(默认 100,硬顶 500 钳制)', () => {
  it('缺省回落默认值 100', async () => {
    const { toolCallArgLimit, TOOL_CALL_ARG_LIMIT_DEFAULT, TOOL_CALL_ARG_LIMIT_MAX } = await import('../src/config');
    expect(TOOL_CALL_ARG_LIMIT_DEFAULT).toBe(100);
    expect(TOOL_CALL_ARG_LIMIT_MAX).toBe(500);
    expect(toolCallArgLimit({})).toBe(100);
    expect(toolCallArgLimit({ toolCallArgLimit: undefined })).toBe(100);
  });

  it('合法值原样通过', async () => {
    const { toolCallArgLimit } = await import('../src/config');
    expect(toolCallArgLimit({ toolCallArgLimit: 1 })).toBe(1);
    expect(toolCallArgLimit({ toolCallArgLimit: 300 })).toBe(300);
    expect(toolCallArgLimit({ toolCallArgLimit: 500 })).toBe(500);
  });

  it('超过硬顶按 500 使用(超限配置直接忽略)', async () => {
    const { toolCallArgLimit } = await import('../src/config');
    expect(toolCallArgLimit({ toolCallArgLimit: 501 })).toBe(500);
    expect(toolCallArgLimit({ toolCallArgLimit: 1_000_000 })).toBe(500);
  });

  it('手编杂值白名单归一:小于 1/非有限数按缺省处理,不小于 1 的小数取整', async () => {
    const { toolCallArgLimit } = await import('../src/config');
    expect(toolCallArgLimit({ toolCallArgLimit: 0 })).toBe(100);
    expect(toolCallArgLimit({ toolCallArgLimit: -5 })).toBe(100);
    expect(toolCallArgLimit({ toolCallArgLimit: 0.9 })).toBe(100);
    expect(toolCallArgLimit({ toolCallArgLimit: Number.NaN })).toBe(100);
    expect(toolCallArgLimit({ toolCallArgLimit: Number.POSITIVE_INFINITY })).toBe(100);
    expect(toolCallArgLimit({ toolCallArgLimit: 1.9 })).toBe(1);
    expect(toolCallArgLimit({ toolCallArgLimit: 100.9 })).toBe(100);
  });
});

describe('config 派生函数族 — bashTimeoutMinutes(默认 10,分钟,spec #218 票 #220)', () => {
  it('缺省回落默认值 10 分钟', async () => {
    const { bashTimeoutMinutes, BASH_TIMEOUT_MINUTES_DEFAULT } = await import('../src/config');
    expect(BASH_TIMEOUT_MINUTES_DEFAULT).toBe(10);
    expect(bashTimeoutMinutes({})).toBe(10);
    expect(bashTimeoutMinutes({ bashTimeoutMinutes: undefined })).toBe(10);
  });

  it('合法值取整通过;不设硬顶(超长任务是配置存在的意义)', async () => {
    const { bashTimeoutMinutes } = await import('../src/config');
    expect(bashTimeoutMinutes({ bashTimeoutMinutes: 1 })).toBe(1);
    expect(bashTimeoutMinutes({ bashTimeoutMinutes: 120 })).toBe(120);
    expect(bashTimeoutMinutes({ bashTimeoutMinutes: 10.9 })).toBe(10);
  });

  it('手编杂值白名单归一:非正数/非有限数/亚分钟小数(<1 会 floor 成 0ms 假超时)按缺省处理', async () => {
    const { bashTimeoutMinutes } = await import('../src/config');
    expect(bashTimeoutMinutes({ bashTimeoutMinutes: 0 })).toBe(10);
    expect(bashTimeoutMinutes({ bashTimeoutMinutes: -1 })).toBe(10);
    expect(bashTimeoutMinutes({ bashTimeoutMinutes: 0.5 })).toBe(10);
    expect(bashTimeoutMinutes({ bashTimeoutMinutes: Number.NaN })).toBe(10);
    expect(bashTimeoutMinutes({ bashTimeoutMinutes: Number.POSITIVE_INFINITY })).toBe(10);
  });
});

describe('custom avatar path derive (spec #84 v5)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'pi-courier-avatar-path-'));
    vi.resetModules();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function importConfig() {
    // 布局显式注入(测试缝):不依赖 builtin mock —— CI 上 vi.doMock('os')
    // 对 src/config 内部 import 会失效,读到真实 HOME(诊断已确认)。
    const cfg = await import('../src/config');
    cfg.setRuntimeLayoutForTests(
      resolveLayout({ platform: process.platform, homedir: tmpDir, env: {} }),
      tmpDir
    );
    return cfg;
  }

  it('normalizes ~, relative paths and blank values (absolute out)', async () => {
    const cfg = await importConfig();
    expect(cfg.customAvatarPath(undefined)).toBeUndefined();
    expect(cfg.customAvatarPath('')).toBeUndefined();
    expect(cfg.customAvatarPath('   ')).toBeUndefined();
    expect(cfg.customAvatarPath('~/pix/face.png')).toBe(join(tmpDir, 'pix/face.png'));
    // 相对路径基准 = configDir(票03:基准跟随配置目录迁移,存量配置零破坏)。
    expect(cfg.customAvatarPath('avatars/face.png')).toBe(
      join(expectedConfigDir(tmpDir), 'avatars/face.png'),
    );
    expect(cfg.customAvatarPath('/abs/face.png')).toBe('/abs/face.png');
    // surrounding whitespace is trimmed, the inner value survives
    expect(cfg.customAvatarPath('  /abs/face.png  ')).toBe('/abs/face.png');
  });

  it('maps whitelisted extensions to mimetypes and rejects others', async () => {
    const cfg = await importConfig();
    expect(cfg.customAvatarMime('/a.png')).toBe('image/png');
    expect(cfg.customAvatarMime('/a.PNG')).toBe('image/png');
    expect(cfg.customAvatarMime('/a.jpg')).toBe('image/jpeg');
    expect(cfg.customAvatarMime('/a.jpeg')).toBe('image/jpeg');
    expect(cfg.customAvatarMime('/a.webp')).toBe('image/webp');
    expect(cfg.customAvatarMime('/a.gif')).toBe('image/gif');
    expect(cfg.customAvatarMime('/a.txt')).toBeUndefined();
    expect(cfg.customAvatarMime('/noext')).toBeUndefined();
  });

  it('exposes the three consumer accessors over the shared rule', async () => {
    const cfg = await importConfig();
    expect(cfg.spaceAvatarPath({ spaceAvatar: ' /x/p.png ' })).toBe('/x/p.png');
    expect(cfg.spaceAvatarPath({})).toBeUndefined();
    expect(cfg.botAvatarPath({ botAvatar: '~/f.png' })).toBe(join(tmpDir, 'f.png'));
    expect(cfg.botAvatarPath({})).toBeUndefined();
    expect(cfg.projectAvatarPath({ workdir: '/w', avatar: 'a.png' })).toBe(
      join(expectedConfigDir(tmpDir), 'a.png'),
    );
    expect(cfg.projectAvatarPath(undefined)).toBeUndefined();
  });
});
