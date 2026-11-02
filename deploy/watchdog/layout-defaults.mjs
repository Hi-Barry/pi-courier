/**
 * pi-courier 看门狗 —— 平台默认布局单点(spec #258 冻结布局,与 src/paths.ts
 * 的状态根解析同语义;评审修复:原先 watchdog-core.mjs 与 matrix-alert.mjs
 * 各自复刻 defaultStateDir,收敛为本共享模块,两个脚本 import 之)。
 *
 * 本目录是零桥代码依赖的独立部署产物,不 import 桥代码,故按平台在此复刻:
 *  win32:  %APPDATA%\pi-courier\state(APPDATA 未设置/空串回退
 *          ~/AppData/Roaming,与 paths.ts 的 envRoot 缺省语义一致)
 *  darwin: ~/Library/Application Support/pi-courier/state
 *  其余:   $XDG_STATE_HOME/pi-courier(未设置/空串按缺省
 *          ~/.local/state/pi-courier 处理)
 */

import * as os from "node:os";
import * as path from "node:path";

/** 默认状态根(spec #258 冻结布局;两个看门狗脚本共用,勿再各自复刻)。 */
export function defaultStateDir() {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, "pi-courier", "state");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "pi-courier", "state");
  }
  const xdgState = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
  return path.join(xdgState, "pi-courier");
}
