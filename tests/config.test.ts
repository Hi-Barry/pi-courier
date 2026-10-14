import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

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
    vi.doMock('os', async () => {
      const actual = await vi.importActual<typeof import('os')>('os');
      return { ...actual, homedir: () => tmpDir };
    });
    return await import('../src/config');
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

  // POSIX mode bits: libuv reports only 0666/0444 for regular files/dirs on
  // Windows — these assertions are meaningless there (see src/config.ts).
  it.skipIf(process.platform === "win32")('creates .pi directory with 700 permissions', async () => {
    const { saveConfig } = await importConfig();
    saveConfig({});

    const stats = statSync(join(tmpDir, '.pi'));
    expect(stats.mode & 0o777).toBe(0o700);
  });

  it.skipIf(process.platform === "win32")('writes config file with 600 permissions', async () => {
    const { saveConfig } = await importConfig();
    saveConfig({});

    const stats = statSync(join(tmpDir, '.pi', 'pi-courier.json'));
    expect(stats.mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform === "win32")('tightens a pre-existing loose config file to 600 (audit batch 1 票8)', async () => {
    mkdirSync(join(tmpDir, '.pi'), { recursive: true });
    const configPath = join(tmpDir, '.pi', 'pi-courier.json');
    writeFileSync(configPath, '{"legacy": true}', { mode: 0o644 });
    expect(statSync(configPath).mode & 0o777).toBe(0o644);

    const { saveConfig } = await importConfig();
    saveConfig({ debug: true });

    expect(statSync(configPath).mode & 0o777).toBe(0o600);
    expect(statSync(join(tmpDir, '.pi')).mode & 0o777).toBe(0o700);
  });

  it('ConfigStore.update survives an injected persist failure without throwing (audit batch 1 票8)', async () => {
    // .pi exists as a regular FILE → saveConfig's writeFileSync throws.
    writeFileSync(join(tmpDir, '.pi'), 'not a directory');
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
    const piDir = join(tmpDir, '.pi');
    mkdirSync(piDir, { recursive: true });
    writeFileSync(join(piDir, 'pi-courier.json'), '{invalid json!!!');

    const { loadConfig } = await importConfig();
    // Should not throw, returns empty config
    const config = loadConfig();
    expect(config).toEqual({});
  });

  it('still applies env vars when config file is corrupted', async () => {
    const piDir = join(tmpDir, '.pi');
    mkdirSync(piDir, { recursive: true });
    writeFileSync(join(piDir, 'pi-courier.json'), 'not json');

    process.env.PI_MATRIX_HOMESERVER = 'https://matrix.example.com';
    process.env.PI_MATRIX_ACCESS_TOKEN = 'syt-env';

    const { loadConfig } = await importConfig();
    const config = loadConfig();
    expect(config.matrix?.accessToken).toBe('syt-env');
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
    mkdirSync(join(tmpDir, '.pi'), { recursive: true });
    writeFileSync(
      join(tmpDir, '.pi', 'pi-courier.json'),
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
    mkdirSync(join(tmpDir, '.pi'), { recursive: true });
    writeFileSync(join(tmpDir, '.pi', 'pi-courier.json'), '[1,2,3]', 'utf-8');
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
    vi.doMock('os', async () => {
      const actual = await vi.importActual<typeof import('os')>('os');
      return { ...actual, homedir: () => tmpDir };
    });
    return await import('../src/config');
  }

  // POSIX mode bits: meaningless on Windows (libuv reports 0666/0444 only).
  it.skipIf(process.platform === "win32")('persists updates to disk with 600 permissions and no format change', async () => {
    const { ConfigStore } = await importConfig();
    const piDir = join(tmpDir, '.pi');
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
    expect(existsSync(join(tmpDir, '.pi'))).toBe(false);
  });

  it('without an initial object it loads once from disk', async () => {
    const piDir = join(tmpDir, '.pi');
    mkdirSync(piDir, { recursive: true });
    writeFileSync(join(piDir, 'pi-courier.json'), JSON.stringify({ workdir: '/from/disk' }));

    const { ConfigStore } = await importConfig();
    const store = new ConfigStore();

    expect(store.get().workdir).toBe('/from/disk');
    // Later disk edits are NOT re-read (loaded once at construction).
    writeFileSync(join(piDir, 'pi-courier.json'), JSON.stringify({ workdir: '/changed' }));
    expect(store.get().workdir).toBe('/from/disk');
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

  it('adoptManagementRoom: 未配置时追加为首个条目', async () => {
    const { adoptManagementRoom } = await import('../src/config');
    expect(adoptManagementRoom({}, '!dm:server')).toEqual({ managementRooms: ['!dm:server'] });
  });

  it('adoptManagementRoom: 空列表追加', async () => {
    const { adoptManagementRoom } = await import('../src/config');
    expect(adoptManagementRoom({ managementRooms: [] }, '!dm:server')).toEqual({
      managementRooms: ['!dm:server'],
    });
  });

  it('adoptManagementRoom: 已有管理房时拒绝再写(架构候选4:不变量结构化,原 append 靠调用方纪律维持)', async () => {
    const { adoptManagementRoom } = await import('../src/config');
    expect(adoptManagementRoom({ managementRooms: ['!a:server'] }, '!dm:server')).toEqual({});
  });

  it('adoptManagementRoom: 重复收养同一房间幂等 — 返回空 patch,不产生重复条目', async () => {
    const { adoptManagementRoom } = await import('../src/config');
    expect(adoptManagementRoom({ managementRooms: ['!dm:server'] }, '!dm:server')).toEqual({});
    expect(adoptManagementRoom({ managementRooms: ['!a:server', '!dm:server'] }, '!dm:server')).toEqual({});
  });

  it('adoptManagementRoom: 返回 patch 形状,可与其它字段展开合并为一次原子 update', async () => {
    const { adoptManagementRoom } = await import('../src/config');
    const cfg = { managementRooms: [] as string[], space: { enabled: true } as Record<string, unknown> };
    const patch = {
      ...adoptManagementRoom(cfg, '!dm:server'),
      space: { ...cfg.space, managementInvitedUsers: ['matrix:@u:server'] },
    };
    expect(patch).toEqual({
      managementRooms: ['!dm:server'],
      space: { enabled: true, managementInvitedUsers: ['matrix:@u:server'] },
    });
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
    vi.doMock('os', async () => {
      const actual = await vi.importActual<typeof import('os')>('os');
      return { ...actual, homedir: () => tmpDir };
    });
    vi.doMock('node:os', async () => {
      const actual = await vi.importActual<typeof import('node:os')>('node:os');
      return { ...actual, homedir: () => tmpDir };
    });
    return await import('../src/config');
  }

  it('normalizes ~, relative paths and blank values (absolute out)', async () => {
    const cfg = await importConfig();
    expect(cfg.customAvatarPath(undefined)).toBeUndefined();
    expect(cfg.customAvatarPath('')).toBeUndefined();
    expect(cfg.customAvatarPath('   ')).toBeUndefined();
    expect(cfg.customAvatarPath('~/pix/face.png')).toBe(join(tmpDir, 'pix/face.png'));
    expect(cfg.customAvatarPath('avatars/face.png')).toBe(join(tmpDir, '.pi', 'avatars/face.png'));
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
    expect(cfg.projectAvatarPath({ workdir: '/w', avatar: 'a.png' })).toBe(join(tmpDir, '.pi', 'a.png'));
    expect(cfg.projectAvatarPath(undefined)).toBeUndefined();
  });
});
