/**
 * This bridge's own version, read from package.json at the project root
 * (parent of the dist/ directory this file is compiled into). Shared by the
 * CLI banner and the project-welcome identity line (票 #210 评审:单一来源,
 * 不许第二份读取逻辑)。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export function readBridgeVersion(): string | undefined {
  try {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8")) as {
      version?: string;
    };
    return pkg.version || undefined;
  } catch {
    return undefined;
  }
}
