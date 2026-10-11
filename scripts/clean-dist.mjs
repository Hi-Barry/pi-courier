/**
 * Cross-platform dist cleaner (audit engineering batch 票24): npm scripts must
 * not depend on a POSIX `rm -rf` — this runs anywhere Node runs (Windows
 * support). `fs.rmSync` is best-effort: an absent dist is a clean state.
 */
import { rmSync } from "node:fs";

rmSync(new URL("../dist", import.meta.url), { recursive: true, force: true });
