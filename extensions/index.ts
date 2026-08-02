/**
 * pi extension entry — makes @barryfan2045/pi-remote discoverable in the pi
 * package catalog (pi.dev/packages) and installable via `pi install`.
 *
 * The bridge itself runs as a standalone app (an RPC client of pi); this
 * extension only registers a `/pi-remote` command that shows how to use it.
 * It is fully self-contained (no imports) so it survives pi's production
 * installs (`npm install --omit=dev`).
 */

/**
 * Minimal structural type for the pi ExtensionAPI we use.
 * (Avoids importing @earendil-works/pi-ai in the shipped extension.)
 */
interface PiApi {
  registerCommand(
    name: string,
    options: {
      description?: string;
      handler: (args: string, ctx: { ui: { notify: (message: string, type?: string) => void } }) => Promise<void>;
    },
  ): void;
}

const USAGE = [
  "pi-remote — 通过 Matrix/Telegram/WhatsApp/Slack/Discord 远程使用 pi。",
  "",
  "安装: npm install -g @barryfan2045/pi-remote",
  "配置: pi-remote setup",
  "运行: pi-remote run(前台)或 pi-remote enable(systemd 开机自启)",
  "仓库: https://github.com/Hi-Barry/pi-remote",
].join("\n");

export default function register(pi: PiApi): void {
  pi.registerCommand("pi-remote", {
    description: "Show how to use pi-remote (run pi from messengers)",
    handler: async (_args, ctx) => {
      ctx.ui.notify(USAGE, "info");
      console.log(USAGE);
    },
  });
}
