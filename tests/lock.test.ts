import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { execFile } from 'child_process';
import { resolveLayout } from '../src/paths';

describe('lock', () => {
  let tmpDir: string;
  let lockPath: string;
  const g = global as any;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'pi-courier.lock-'));
    // 锁路径由注入缝决定(spec #258 票03):组合根传布局解析的 lockPath
    // (stateDir/pi-courier.lock)。测试用干净 env 解析,避免宿主 XDG 变量
    // 把断言路径带出临时目录;homedir 钉在 tmpDir。
    lockPath = resolveLayout({ platform: process.platform, homedir: tmpDir, env: {} }).lockPath;
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

  async function importLock() {
    // lock.ts 零项目依赖(原生 node 直跑约束),锁路径不再读 os.homedir,
    // 无需 doMock('os') —— 路径完全由调用方注入。
    return await import('../src/lock');
  }

  it('acquires lock and writes lock file', async () => {
    const { acquireLock } = await importLock();
    expect(acquireLock(lockPath)).toBe(true);
    expect(g.__msgBridgeConnected).toBe(true);

    // Verify lock file content
    const content = readFileSync(lockPath, 'utf-8');
    const [pid, owner] = content.split(':');
    expect(parseInt(pid, 10)).toBe(process.pid);
    expect(owner).toBe(g.__msgBridgeInstanceId);
  });

  it('allows same instance to re-acquire (idempotent)', async () => {
    const { acquireLock } = await importLock();
    expect(acquireLock(lockPath)).toBe(true);
    expect(acquireLock(lockPath)).toBe(true);
  });

  it('release clears global state and removes lock file', async () => {
    const { acquireLock, releaseLock } = await importLock();
    acquireLock(lockPath);

    releaseLock(lockPath);
    expect(g.__msgBridgeConnected).toBe(false);
    expect(g.__msgBridgeOwner).toBeUndefined();
    expect(existsSync(lockPath)).toBe(false);
  });

  it('acquire → release → re-acquire works', async () => {
    const { acquireLock, releaseLock } = await importLock();

    expect(acquireLock(lockPath)).toBe(true);
    releaseLock(lockPath);
    expect(g.__msgBridgeConnected).toBe(false);

    // Should be able to re-acquire after release
    expect(acquireLock(lockPath)).toBe(true);
    expect(g.__msgBridgeConnected).toBe(true);
    expect(existsSync(lockPath)).toBe(true);
  });

  it('blocks a different instance in the same process (layer 1)', async () => {
    const { acquireLock } = await importLock();
    acquireLock(lockPath);

    // Import a fresh module to get a different instanceId
    vi.resetModules();
    delete g.__msgBridgeInstanceId;
    const lock2 = await importLock();

    // Layer 1: g.__msgBridgeConnected is true, owner doesn't match new instanceId
    expect(lock2.acquireLock(lockPath)).toBe(false);
  });

  it('overwrites stale lock from dead process (layer 2)', async () => {
    mkdirSync(dirname(lockPath), { recursive: true });
    // Use PID 2^30 — well above any real PID on Linux/macOS
    writeFileSync(lockPath, '1073741824:stale-owner');

    const { acquireLock } = await importLock();
    expect(acquireLock(lockPath)).toBe(true);
  });

  it('takes over a same-PID lock (PID reuse after restart, layer 2)', async () => {
    mkdirSync(dirname(lockPath), { recursive: true });
    // Same PID with a different owner — simulates container restarts where
    // the main process is PID 1 every time and the old lock file survived
    // in the mounted volume. A process can't be a live competitor to itself.
    writeFileSync(lockPath, `${process.pid}:other-instance`);

    const { acquireLock, releaseLock } = await importLock();
    expect(acquireLock(lockPath)).toBe(true);
    releaseLock(lockPath);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('releaseLock is a no-op for non-owner', async () => {
    const { acquireLock, releaseLock } = await importLock();
    acquireLock(lockPath);

    const realOwner = g.__msgBridgeOwner;
    g.__msgBridgeOwner = 'someone-else';
    releaseLock(lockPath);

    // Lock should still be held
    g.__msgBridgeOwner = realOwner;
    expect(g.__msgBridgeConnected).toBe(true);
    expect(existsSync(lockPath)).toBe(true);
  });

  it('creates the lock directory if missing', async () => {
    const { acquireLock } = await importLock();
    const lockDir = dirname(lockPath);
    expect(existsSync(lockDir)).toBe(false);

    acquireLock(lockPath);
    expect(existsSync(lockDir)).toBe(true);
    expect(existsSync(lockPath)).toBe(true);
  });

  it('does not steal a lock whose owner is alive but unprobeable (EPERM)', async () => {
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, '424242:other-owner');

    const err: NodeJS.ErrnoException = new Error('Operation not permitted');
    err.code = 'EPERM';
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw err;
    });
    try {
      const { acquireLock } = await importLock();
      expect(acquireLock(lockPath)).toBe(false);
      // The other owner's claim is untouched — no silent takeover.
      expect(readFileSync(lockPath, 'utf-8')).toBe('424242:other-owner');
    } finally {
      killSpy.mockRestore();
    }
  });

  it('takes over a corrupt lock file (no valid ownership claim)', async () => {
    mkdirSync(dirname(lockPath), { recursive: true });
    for (const corrupt of ['', 'garbage-without-colon', 'not-a-number:owner']) {
      writeFileSync(lockPath, corrupt);
      const { acquireLock } = await importLock();
      expect(acquireLock(lockPath), `corrupt=${JSON.stringify(corrupt)}`).toBe(true);
      const { releaseLock } = await importLock();
      releaseLock(lockPath);
    }
  });

  it('fails closed when lock file mechanics fail (no silent double instance)', async () => {
    // 锁目录是一个普通文件 → writeFileSync(锁) 抛 ENOTDIR,机制失败必须
    // fail closed,不能让第二个桥以为它拥有房间。
    const fileAsDir = join(tmpDir, 'not-a-dir');
    writeFileSync(fileAsDir, 'file');
    const doomedLockPath = join(fileAsDir, 'pi-courier.lock');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { acquireLock } = await importLock();
      expect(acquireLock(doomedLockPath)).toBe(false);
      expect(g.__msgBridgeConnected).toBeUndefined();
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('release is a safe no-op when the lock file is corrupt', async () => {
    const { acquireLock, releaseLock } = await importLock();
    expect(acquireLock(lockPath)).toBe(true);
    // Corrupt the file behind the holder's back, then release: no crash, no
    // unlink (ownership can no longer be verified).
    writeFileSync(lockPath, 'corrupt');
    expect(() => releaseLock(lockPath)).not.toThrow();
    expect(g.__msgBridgeConnected).toBe(false);
  });

  it('exactly one cross-process contender wins the race', async () => {
    // file:// URL, not a bare path: ESM import() on win32 rejects "D:\…" as
    // an unsupported URL scheme (ERR_UNSUPPORTED_ESM_URL_SCHEME).
    const lockModuleUrl = new URL('../src/lock.ts', import.meta.url).href;
    const pathsModuleUrl = new URL('../src/paths.ts', import.meta.url).href;
    const runner = join(tmpDir, 'contender.mjs');
    // Winner holds the lock and stays alive (the contender process IS the
    // liveness guarantee — an exited holder is stale by design); losers
    // report immediately after seeing a live owner. 锁路径在 runner 里按
    // 布局解析(paths.ts 零依赖,可与 lock.ts 同样直跑):HOME/USERPROFILE
    // 钉到 tmpDir,XDG/APPDATA 清空或钉进 tmpDir,保证锁文件不落真实家。
    writeFileSync(
      runner,
      `const [{ resolveLayout }, m] = await Promise.all([
         import(${JSON.stringify(pathsModuleUrl)}),
         import(${JSON.stringify(lockModuleUrl)}),
       ]);
       const os = await import('os');
       const layout = resolveLayout({ platform: process.platform, homedir: os.homedir(), env: process.env });
       if (m.acquireLock(layout.lockPath)) {
         process.stdout.write("W");
         await new Promise((r) => setTimeout(r, 2000));
         m.releaseLock(layout.lockPath);
       } else {
         process.stdout.write("L");
       }`
    );
    const contenders = 6;
    const results = await Promise.all(
      Array.from({ length: contenders }, () =>
        new Promise<string>((resolve, reject) => {
          execFile(
            process.execPath,
            [runner],
            // os.homedir() follows $HOME on POSIX and $USERPROFILE on
            // Windows — pin both to the temp dir; blank the XDG trio (treated
            // as unset by resolveLayout) and pin APPDATA under tmpDir so the
            // derived lock path stays inside the temp dir on every platform.
            {
              env: {
                ...process.env,
                HOME: tmpDir,
                USERPROFILE: tmpDir,
                APPDATA: join(tmpDir, 'AppData', 'Roaming'),
                XDG_CONFIG_HOME: '',
                XDG_DATA_HOME: '',
                XDG_STATE_HOME: '',
              },
            },
            (err, stdout) => (err ? reject(err) : resolve(String(stdout)))
          );
        })
      )
    );
    expect(results.filter((r) => r === 'W')).toHaveLength(1);
    expect(results.filter((r) => r === 'L')).toHaveLength(contenders - 1);
  }, 15000);
});
