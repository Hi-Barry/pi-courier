/**
 * Project-welcome copy home: the single assembly point for the "project is
 * online" card posted into a brand-new project room (spec #208 票2/#210).
 * Mirrors management-room.ts: all copy comes from the i18n tables (locale is
 * fixed at startup); the builder is a pure function so the version/model
 * degradation matrix stays unit-testable, and version lookup is best-effort —
 * a missing entry just drops its segment of the identity line.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { t } from "./i18n/index.js";

export interface WelcomeFacts {
  projectName: string;
  /** `${provider}/${id}` read from the started session's state; absent = omit the model line. */
  model?: string;
  piVersion?: string;
  courierVersion?: string;
}

export function buildProjectWelcome(facts: WelcomeFacts): string {
  const hasStack = Boolean(facts.piVersion && facts.courierVersion);
  const params = {
    name: facts.projectName,
    piVersion: facts.piVersion ?? "",
    courierVersion: facts.courierVersion ?? "",
    model: facts.model ?? "",
  };
  const identity = facts.model
    ? hasStack
      ? t("welcome.project.identity.full", params)
      : t("welcome.project.identity.modelOnly", params)
    : hasStack
      ? t("welcome.project.identity.versionsOnly", params)
      : t("welcome.project.identity.bare", params);
  return [
    t("welcome.project.header", params),
    identity,
    t("welcome.project.capabilities"),
    t("welcome.project.try"),
    t("welcome.project.helpHint"),
  ].join("\n\n");
}

/** Versions for the welcome identity line — best-effort on both entries. */
export async function welcomeVersions(): Promise<{ piVersion?: string; courierVersion?: string }> {
  return { piVersion: await piCodingAgentVersion(), courierVersion: courierVersion() };
}

/** pi coding agent's own VERSION export (lazy import — same shape as the
 *  pi-rpc seam; the package is a peer dependency, so it may be unreadable
 *  only in a broken install, which degrades the copy instead of crashing). */
async function piCodingAgentVersion(): Promise<string | undefined> {
  try {
    const mod = await import("@earendil-works/pi-coding-agent");
    return mod.VERSION || undefined;
  } catch {
    return undefined;
  }
}

/** This bridge's own version from package.json at the project root (the
 *  cli.ts pattern: parent of the dist/ directory this file is compiled into). */
function courierVersion(): string | undefined {
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
