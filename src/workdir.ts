/**
 * First-run workdir resolution.
 *
 * Priority: CLI --workdir > config.workdir > interactive prompt (TTY only,
 * silent default otherwise) > ~/Projects. The resolved value is persisted
 * through the injected ConfigStore — `store.update` writes the disk AND the
 * in-memory copy in one step, so `/pmctl` relative-path resolution and the
 * management-room help text see the right directory immediately, without a
 * restart. This module deliberately depends on nothing heavier than the
 * config store so it stays unit-testable.
 */

import * as readline from "node:readline";
import { defaultProjectsRoot } from "./config.js";
import type { ConfigStore } from "./config.js";

export type WorkdirPrompt = () => Promise<string | undefined>;

/** Interactive prompt; undefined outside a TTY (silent default, as under
 *  systemd where no terminal answers). */
async function promptWorkdir(fallback: string): Promise<string | undefined> {
  if (!process.stdin.isTTY) return undefined;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question(`未配置工作目录。请输入 pi 工作目录 [默认 ${fallback}]: `, (a) => resolve(a.trim()));
    });
    return answer || undefined;
  } finally {
    rl.close();
  }
}

export async function resolveWorkdir(
  cliWorkdir: string | undefined,
  store: ConfigStore,
  prompt?: WorkdirPrompt,
  /** Called after the store persist, so the module itself stays log-free. */
  onPersist?: (workdir: string) => void
): Promise<string> {
  if (cliWorkdir) return cliWorkdir;

  const configWorkdir = store.get().workdir;
  if (configWorkdir) return configWorkdir;

  const fallback = defaultProjectsRoot();
  let workdir = fallback;

  const ask = prompt ?? (() => promptWorkdir(fallback));
  const answer = await ask();
  if (answer) workdir = answer;

  store.update({ workdir });
  onPersist?.(workdir);
  return workdir;
}
