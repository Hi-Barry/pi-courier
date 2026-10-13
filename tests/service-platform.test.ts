/**
 * Platform guard for the systemd-backed service subcommands (evaluation
 * 2026-10-13): the decision itself lives in systemd-hint (pure, parameterized
 * on the platform), the refusal copy is i18n'd — both locales pinned here.
 */
import { afterEach, describe, expect, it } from "vitest";
import { serviceManagementSupported } from "../src/systemd-hint.js";
import { setLocale, t } from "../src/i18n/index.js";

describe("serviceManagementSupported", () => {
  it("accepts linux only", () => {
    expect(serviceManagementSupported("linux")).toBe(true);
  });

  it("rejects every other platform", () => {
    expect(serviceManagementSupported("win32")).toBe(false);
    expect(serviceManagementSupported("darwin")).toBe(false);
    expect(serviceManagementSupported("freebsd")).toBe(false);
  });
});

describe("service-guard copy (i18n, both locales)", () => {
  afterEach(() => setLocale("zh"));

  it("refusal names the subcommand and the alternatives (zh + en)", () => {
    setLocale("zh");
    const zh = t("cli.service.unsupportedPlatform", { cmd: "enable" });
    expect(zh).toContain("仅支持 Linux");
    expect(zh).toContain("enable");
    expect(zh).toContain("pi-courier run");

    setLocale("en");
    const en = t("cli.service.unsupportedPlatform", { cmd: "enable" });
    expect(en).toContain("Linux-only");
    expect(en).toContain("enable");
    expect(en).toContain("Task Scheduler");
  });

  it("update skip note exists in both locales", () => {
    setLocale("zh");
    expect(t("cli.update.serviceSkipped")).toContain("跳过 systemd 服务检查");
    setLocale("en");
    expect(t("cli.update.serviceSkipped")).toContain("skipping the systemd service checks");
  });
});
