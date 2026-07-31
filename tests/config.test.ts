import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('config', () => {
  let tmpDir: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'msg-bridge-config-'));
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

  it('saves and loads config roundtrip', async () => {
    const { loadConfig, saveConfig } = await importConfig();

    saveConfig({ telegram: { token: 'test-token' }, autoConnect: true, debug: false });
    const loaded = loadConfig();

    expect(loaded.telegram?.token).toBe('test-token');
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

    const stats = statSync(join(tmpDir, '.pi', 'msg-bridge.json'));
    expect(stats.mode & 0o777).toBe(0o600);
  });

  it('env vars override file values for the same transport', async () => {
    const { loadConfig, saveConfig } = await importConfig();

    saveConfig({ telegram: { token: 'file-token' }, autoConnect: true });
    process.env.PI_TELEGRAM_TOKEN = 'env-token';

    const loaded = loadConfig();
    expect(loaded.telegram?.token).toBe('env-token');
    // Non-overridden fields survive
    expect(loaded.autoConnect).toBe(true);
  });

  it('loads all transport env vars', async () => {
    process.env.PI_TELEGRAM_TOKEN = 'tg-token';
    process.env.PI_WHATSAPP_AUTH_PATH = '/wa/auth';
    process.env.PI_SLACK_BOT_TOKEN = 'xoxb-test';
    process.env.PI_SLACK_APP_TOKEN = 'xapp-test';
    process.env.PI_DISCORD_TOKEN = 'dc-token';

    const { loadConfig } = await importConfig();
    const config = loadConfig();

    expect(config.telegram?.token).toBe('tg-token');
    expect(config.whatsapp?.authPath).toBe('/wa/auth');
    expect(config.slack?.botToken).toBe('xoxb-test');
    expect(config.slack?.appToken).toBe('xapp-test');
    expect(config.discord?.token).toBe('dc-token');
  });

  it('handles corrupted config file gracefully', async () => {
    const piDir = join(tmpDir, '.pi');
    mkdirSync(piDir, { recursive: true });
    writeFileSync(join(piDir, 'msg-bridge.json'), '{invalid json!!!');

    const { loadConfig } = await importConfig();
    // Should not throw, returns empty config
    const config = loadConfig();
    expect(config).toEqual({});
  });

  it('still applies env vars when config file is corrupted', async () => {
    const piDir = join(tmpDir, '.pi');
    mkdirSync(piDir, { recursive: true });
    writeFileSync(join(piDir, 'msg-bridge.json'), 'not json');

    process.env.PI_TELEGRAM_TOKEN = 'env-token';

    const { loadConfig } = await importConfig();
    const config = loadConfig();
    expect(config.telegram?.token).toBe('env-token');
  });

  it('requires both Slack tokens for slack config', async () => {
    // Only bot token — should not set slack
    process.env.PI_SLACK_BOT_TOKEN = 'xoxb-test';

    const { loadConfig } = await importConfig();
    expect(loadConfig().slack).toBeUndefined();
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
