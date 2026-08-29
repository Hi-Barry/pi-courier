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

  it('creates .pi directory with 700 permissions', async () => {
    const { saveConfig } = await importConfig();
    saveConfig({});

    const stats = statSync(join(tmpDir, '.pi'));
    expect(stats.mode & 0o777).toBe(0o700);
  });

  it('writes config file with 600 permissions', async () => {
    const { saveConfig } = await importConfig();
    saveConfig({});

    const stats = statSync(join(tmpDir, '.pi', 'pi-courier.json'));
    expect(stats.mode & 0o777).toBe(0o600);
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

  it('persists updates to disk with 600 permissions and no format change', async () => {
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
