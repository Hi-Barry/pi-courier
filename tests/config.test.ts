import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('config', () => {
  let tmpDir: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'pi-courier-config-'));
    delete process.env.PI_TELEGRAM_TOKEN;
    delete process.env.PI_WHATSAPP_AUTH_PATH;
    delete process.env.PI_SLACK_BOT_TOKEN;
    delete process.env.PI_SLACK_APP_TOKEN;
    delete process.env.PI_DISCORD_TOKEN;
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
