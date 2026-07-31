import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('lock', () => {
  let tmpDir: string;
  const g = global as any;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'msg-bridge-lock-'));
    delete g.__msgBridgeInstanceId;
    delete g.__msgBridgeConnected;
    delete g.__msgBridgeOwner;
    vi.resetModules();
  });

  afterEach(() => {
    delete g.__msgBridgeConnected;
    delete g.__msgBridgeOwner;
    delete g.__msgBridgeInstanceId;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function importLock(lockDir: string) {
    vi.doMock('os', async () => {
      const actual = await vi.importActual<typeof import('os')>('os');
      return { ...actual, homedir: () => lockDir };
    });
    return await import('../src/lock');
  }

  it('acquires lock and writes lock file', async () => {
    const { acquireLock } = await importLock(tmpDir);
    expect(acquireLock()).toBe(true);
    expect(g.__msgBridgeConnected).toBe(true);

    // Verify lock file content
    const lockPath = join(tmpDir, '.pi', 'msg-bridge.lock');
    const content = readFileSync(lockPath, 'utf-8');
    const [pid, owner] = content.split(':');
    expect(parseInt(pid, 10)).toBe(process.pid);
    expect(owner).toBe(g.__msgBridgeInstanceId);
  });

  it('allows same instance to re-acquire (idempotent)', async () => {
    const { acquireLock } = await importLock(tmpDir);
    expect(acquireLock()).toBe(true);
    expect(acquireLock()).toBe(true);
  });

  it('release clears global state and removes lock file', async () => {
    const { acquireLock, releaseLock } = await importLock(tmpDir);
    acquireLock();

    releaseLock();
    expect(g.__msgBridgeConnected).toBe(false);
    expect(g.__msgBridgeOwner).toBeUndefined();
    expect(existsSync(join(tmpDir, '.pi', 'msg-bridge.lock'))).toBe(false);
  });

  it('acquire → release → re-acquire works', async () => {
    const { acquireLock, releaseLock } = await importLock(tmpDir);

    expect(acquireLock()).toBe(true);
    releaseLock();
    expect(g.__msgBridgeConnected).toBe(false);

    // Should be able to re-acquire after release
    expect(acquireLock()).toBe(true);
    expect(g.__msgBridgeConnected).toBe(true);
    expect(existsSync(join(tmpDir, '.pi', 'msg-bridge.lock'))).toBe(true);
  });

  it('blocks a different instance in the same process (layer 1)', async () => {
    const { acquireLock } = await importLock(tmpDir);
    acquireLock();

    // Import a fresh module to get a different instanceId
    vi.resetModules();
    delete g.__msgBridgeInstanceId;
    const lock2 = await importLock(tmpDir);

    // Layer 1: g.__msgBridgeConnected is true, owner doesn't match new instanceId
    expect(lock2.acquireLock()).toBe(false);
  });

  it('overwrites stale lock from dead process (layer 2)', async () => {
    const piDir = join(tmpDir, '.pi');
    mkdirSync(piDir, { recursive: true });
    // Use PID 2^30 — well above any real PID on Linux/macOS
    writeFileSync(join(piDir, 'msg-bridge.lock'), '1073741824:stale-owner');

    const { acquireLock } = await importLock(tmpDir);
    expect(acquireLock()).toBe(true);
  });

  it('blocks when a live process holds the lock (layer 2)', async () => {
    const piDir = join(tmpDir, '.pi');
    mkdirSync(piDir, { recursive: true });
    // Use current PID with a different owner — simulates another instance in
    // a different process that happens to be alive
    writeFileSync(join(piDir, 'msg-bridge.lock'), `${process.pid}:other-instance`);

    // Layer 1 passes (no global flag set).
    // Layer 2: same PID, different owner → blocked.
    const { acquireLock } = await importLock(tmpDir);
    expect(acquireLock()).toBe(false);
  });

  it('releaseLock is a no-op for non-owner', async () => {
    const { acquireLock, releaseLock } = await importLock(tmpDir);
    acquireLock();

    const realOwner = g.__msgBridgeOwner;
    g.__msgBridgeOwner = 'someone-else';
    releaseLock();

    // Lock should still be held
    g.__msgBridgeOwner = realOwner;
    expect(g.__msgBridgeConnected).toBe(true);
    expect(existsSync(join(tmpDir, '.pi', 'msg-bridge.lock'))).toBe(true);
  });

  it('creates .pi directory if missing', async () => {
    const { acquireLock } = await importLock(tmpDir);
    expect(existsSync(join(tmpDir, '.pi'))).toBe(false);

    acquireLock();
    expect(existsSync(join(tmpDir, '.pi'))).toBe(true);
  });
});
