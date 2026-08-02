/**
 * pi extension entry — makes pi-courier discoverable in the pi
 * package catalog (pi.dev/packages) and installable via `pi install`.
 *
 * The bridge itself runs as a standalone app (an RPC client of pi); this
 * extension only registers a `/pi-courier` command that shows how to use it.
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
  "pi-courier — 通过 Matrix 远程使用 pi(消息桥接)。",
  "",
  "安装: npm install -g pi-courier",
  "配置: pi-courier setup",
  "运行: pi-courier run(前台)或 pi-courier enable(systemd 开机自启)",
  "仓库: https://github.com/Hi-Barry/pi-courier",
].join("\n");

export default function register(pi: PiApi): void {
  pi.registerCommand("pi-courier", {
    description: "Show how to use pi-courier (run pi from Matrix)",
    handler: async (_args, ctx) => {
      ctx.ui.notify(USAGE, "info");
      console.log(USAGE);
    },
  });
}
