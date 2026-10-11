import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFile } from 'child_process';
import { fileURLToPath } from 'url';

describe('lock', () => {
  let tmpDir: string;
  const g = global as any;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'pi-courier.lock-'));
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
    const lockPath = join(tmpDir, '.pi', 'pi-courier.lock');
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
    expect(existsSync(join(tmpDir, '.pi', 'pi-courier.lock'))).toBe(false);
  });

  it('acquire → release → re-acquire works', async () => {
    const { acquireLock, releaseLock } = await importLock(tmpDir);

    expect(acquireLock()).toBe(true);
    releaseLock();
    expect(g.__msgBridgeConnected).toBe(false);

    // Should be able to re-acquire after release
    expect(acquireLock()).toBe(true);
    expect(g.__msgBridgeConnected).toBe(true);
    expect(existsSync(join(tmpDir, '.pi', 'pi-courier.lock'))).toBe(true);
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
    writeFileSync(join(piDir, 'pi-courier.lock'), '1073741824:stale-owner');

    const { acquireLock } = await importLock(tmpDir);
    expect(acquireLock()).toBe(true);
  });

  it('takes over a same-PID lock (PID reuse after restart, layer 2)', async () => {
    const piDir = join(tmpDir, '.pi');
    mkdirSync(piDir, { recursive: true });
    // Same PID with a different owner — simulates container restarts where
    // the main process is PID 1 every time and the old lock file survived
    // in the mounted volume. A process can't be a live competitor to itself.
    writeFileSync(join(piDir, 'pi-courier.lock'), `${process.pid}:other-instance`);

    const { acquireLock, releaseLock } = await importLock(tmpDir);
    expect(acquireLock()).toBe(true);
    releaseLock();
    expect(existsSync(join(piDir, 'pi-courier.lock'))).toBe(false);
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
    expect(existsSync(join(tmpDir, '.pi', 'pi-courier.lock'))).toBe(true);
  });

  it('creates .pi directory if missing', async () => {
    const { acquireLock } = await importLock(tmpDir);
    expect(existsSync(join(tmpDir, '.pi'))).toBe(false);

    acquireLock();
    expect(existsSync(join(tmpDir, '.pi'))).toBe(true);
  });

  it('does not steal a lock whose owner is alive but unprobeable (EPERM)', async () => {
    const piDir = join(tmpDir, '.pi');
    mkdirSync(piDir, { recursive: true });
    writeFileSync(join(piDir, 'pi-courier.lock'), '424242:other-owner');

    const err: NodeJS.ErrnoException = new Error('Operation not permitted');
    err.code = 'EPERM';
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw err;
    });
    try {
      const { acquireLock } = await importLock(tmpDir);
      expect(acquireLock()).toBe(false);
      // The other owner's claim is untouched — no silent takeover.
      expect(readFileSync(join(piDir, 'pi-courier.lock'), 'utf-8')).toBe('424242:other-owner');
    } finally {
      killSpy.mockRestore();
    }
  });

  it('takes over a corrupt lock file (no valid ownership claim)', async () => {
    const piDir = join(tmpDir, '.pi');
    mkdirSync(piDir, { recursive: true });
    for (const corrupt of ['', 'garbage-without-colon', 'not-a-number:owner']) {
      writeFileSync(join(piDir, 'pi-courier.lock'), corrupt);
      const { acquireLock } = await importLock(tmpDir);
      expect(acquireLock(), `corrupt=${JSON.stringify(corrupt)}`).toBe(true);
      const { releaseLock } = await importLock(tmpDir);
      releaseLock();
    }
  });

  it('fails closed when lock file mechanics fail (no silent double instance)', async () => {
    // .pi exists as a regular FILE → mkdirSync/writeFileSync throw.
    writeFileSync(join(tmpDir, '.pi'), 'not a directory');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { acquireLock } = await importLock(tmpDir);
      expect(acquireLock()).toBe(false);
      expect(g.__msgBridgeConnected).toBeUndefined();
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('release is a safe no-op when the lock file is corrupt', async () => {
    const { acquireLock, releaseLock } = await importLock(tmpDir);
    expect(acquireLock()).toBe(true);
    // Corrupt the file behind the holder's back, then release: no crash, no
    // unlink (ownership can no longer be verified).
    writeFileSync(join(tmpDir, '.pi', 'pi-courier.lock'), 'corrupt');
    expect(() => releaseLock()).not.toThrow();
    expect(g.__msgBridgeConnected).toBe(false);
  });

  it('exactly one cross-process contender wins the race', async () => {
    const lockModuleUrl = fileURLToPath(new URL('../src/lock.ts', import.meta.url));
    const runner = join(tmpDir, 'contender.mjs');
    // Winner holds the lock and stays alive (the contender process IS the
    // liveness guarantee — an exited holder is stale by design); losers
    // report immediately after seeing a live owner.
    writeFileSync(
      runner,
      `import(${JSON.stringify(lockModuleUrl)}).then(async (m) => {
        if (m.acquireLock()) {
          process.stdout.write("W");
          await new Promise((r) => setTimeout(r, 2000));
          m.releaseLock();
        } else {
          process.stdout.write("L");
        }
      });`
    );
    const contenders = 6;
    const results = await Promise.all(
      Array.from({ length: contenders }, () =>
        new Promise<string>((resolve, reject) => {
          execFile(
            process.execPath,
            [runner],
            // os.homedir() follows $HOME on Linux — point the contender's
            // lock dir at the temp dir, never at the real ~/.pi.
            { env: { ...process.env, HOME: tmpDir } },
            (err, stdout) => (err ? reject(err) : resolve(String(stdout)))
          );
        })
      )
    );
    expect(results.filter((r) => r === 'W')).toHaveLength(1);
    expect(results.filter((r) => r === 'L')).toHaveLength(contenders - 1);
  }, 15000);
});
