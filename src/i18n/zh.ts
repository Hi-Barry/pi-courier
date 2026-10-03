/**
 * 中文文案表(基准表)。
 *
 * 红线(spec issue #83):
 *  • 0.2.x 的历史中文文案逐字入表,tests/ 下的中文断言以它为锚。两处
 *    有意例外:配对码提示在 0.2.x 是英文孤例,现随 locale 走(中文用户
 *    首次见到中文提示);setup 向导标题固定双语(语言尚未确定);
 *  • MessageKey 由本表定义,en.ts 以 Record<MessageKey, string> 对齐,
 *    两表缺 key/多 key 都是编译错误;
 *  • 插值占位符 {name},由 t() 替换;文案里不要出现字面 { }(现网无此文案)。
 */
const zh = {
  // ── common ────────────────────────────────────────────────────────────
  "common.cancel": "取消",
  "common.on": "开",
  "common.off": "关",
  "common.enabled": "开启",
  "common.disabled": "关闭",
  "common.yes": "是",
  "common.no": "否",
  "common.truncated": "…(已截断)",
  "common.noOutput": "(无输出)",
  "common.exitCode": "退出码: {code}",
  "common.listSep": "、",

  // ── cmd(/命令回复,command-map.ts)───────────────────────────────────
  "cmd.new.ok": "✅ 已开始新会话",
  "cmd.new.cancelled": "⚠️ 新会话被扩展取消",
  "cmd.generic.error": "❌ 命令执行失败: {message}",
  "cmd.bash.error": "❌ bash 执行失败: {message}",
  "cmd.bash.notWritten": "(结果未写入上下文)",
  "cmd.bash.excludedNote": "(结果不写入上下文)",
  "cmd.bash.aborted": "⏹ 已中止: {command}{suffix}",
  "cmd.queue.warning": "⚠️ 队列中仍有 {count} 条消息将在下一轮生效:\n{lines}",
  "cmd.rpc.defaultName": "默认",
  "cmd.reloadAll.restarted": "✅ 已重启 {count} 个空闲进程: {names}",
  "cmd.reloadAll.none": "💤 没有需要重启的空闲进程",
  "cmd.reloadAll.skippedBusy": "⚠️ 跳过 {count} 个忙碌进程: {names}(完成后执行 /reload all)",
  "cmd.reloadAll.unreachable": "⏭️ 未启动/不可达(下次启动自动读取新配置): {names}",
  "cmd.queue.localEmptyUpstreamHas": "📋 本地队列为空,但上游报告仍有 {count} 条待处理消息(以实际执行为准)。",
  "cmd.queue.empty": "📋 队列为空:没有排队中的 steering / followUp 消息。",
  "cmd.queue.header": "📋 当前消息队列:",
  "cmd.queue.steering": "steering({count} 条,注入当前运行):",
  "cmd.queue.followUp": "followUp({count} 条,后续轮次执行):",
  "cmd.queue.mismatch": "ℹ️ 上游报告待处理 {upstream} 条(本地镜像 {mirror} 条),以实际执行为准。",
  "cmd.sessions.emptyDir": "会话目录为空",
  "cmd.sessions.noDir": "找不到会话目录",
  "cmd.sessions.empty": "📭 {reason}: {dir}",
  "cmd.sessions.list": "📚 会话(最近修改优先):\n{lines}\n\n用 /switch <序号> 切换。",
  "cmd.compact.ok": "✅ 已压缩",
  "cmd.compact.tokens": "  tokens: {before} → 压缩后(见摘要)",
  "cmd.compact.summary": "\n摘要: {summary}",
  "cmd.stop.ok": "🛑 已停止所有任务,等待下一步指示。",
  "cmd.queue.enqueued": "📥 已排队:不打断当前任务,将在空闲后自动执行。",
  "cmd.interrupt.usage": "用法: /interrupt <新指令> — 打断当前任务并立即下发新指令。",
  "cmd.interrupt.idle": "▶️ 当前没有运行中的任务,已直接下发新指令。",
  "cmd.interrupt.done": "🛑 已打断,新指令已发出。",
  "cmd.last.none": "💤 没有可复述的回复(本会话还没有 assistant 输出)。",
  "cmd.cyclemodel.none": "❌ 没有可轮换的模型(启动未限定模型列表?)。用 /model <provider/id> 直接指定。",
  "cmd.cyclemodel.ok": "✅ 已切换模型: {model}(思考: {thinking})",
  "cmd.cyclethinking.none": "❌ 没有可轮换的思考级别。",
  "cmd.cyclethinking.ok": "✅ 思考级别已轮换为: {level}",
  "cmd.autocompact.usage":
    "当前自动压缩: {state}\n用法: /autocompact on|off(实例级生效:写入 pi 全局设置,一个项目房间切换影响全部项目)",
  "cmd.autocompact.ok": "✅ 自动压缩已{state}(实例级生效)。",
  "cmd.autoretry.usage":
    "用法: /autoretry on|off\n(上游未暴露当前状态查询;实例级生效:写入 pi 全局设置,一个项目房间切换影响全部项目)",
  "cmd.autoretry.ok": "✅ 自动重试已{state}(实例级生效)。",
  "cmd.switch.streaming": "⚠️ 当前任务流式进行中,请先 /stop 再切换会话。",
  "cmd.switch.usage": "用法: /switch <序号> — 切换到 /sessions 列表中的会话。",
  "cmd.switch.outOfRange": "❌ 序号超出范围: {index}(用 /sessions 查看当前列表)。",
  "cmd.switch.cancelled": "⚠️ 切换会话被扩展取消",
  "cmd.switch.ok": "✅ 已切换会话: {file}",
  "cmd.attach.ok":
    "🔗 已开启会话镜像(本房间 ↔ TUI 双端同步)。\n" +
    "终端里跑这条命令附加同一会话:\n" +
    "`{command}`\n\n" +
    "• TUI 里收发的消息会实时转发到本房间;\n" +
    "• TUI 用完后回本房间发消息,上下文自动接上(空闲时自动接力);\n" +
    "• 会话目录: {dir}\n" +
    "• 结束镜像用 /detach。",
  "cmd.attach.noSession": "💤 当前还没有会话文件(先发一条消息开启会话),稍后再 /attach。",
  "cmd.attach.unavailable": "❌ 会话镜像在当前部署不可用。",
  "cmd.detach.ok": "✅ 已关闭会话镜像。TUI 的消息不再转发到本房间。",
  "cmd.detach.notActive": "💤 当前没有开启的会话镜像。",
  "cmd.reload.allUnavailable": "❌ /reload all 不可用(当前部署未启用多进程枚举)。",
  "cmd.reload.allInProgress": "🔄 正在逐个重启全部 pi 进程(空闲才重启,忙碌跳过)…",
  "cmd.reload.inProgress": "🔄 正在重启 pi 进程(扩展/技能/配置将重新加载)…",
  "cmd.reload.ok": "✅ pi 已重启,模型: {model}",
  "cmd.reload.failed": "❌ 重启失败: {message}",
  "cmd.model.none": "没有可用模型(未配置 provider?)",
  "cmd.model.currentMarker": " ← 当前",
  "cmd.model.list": "可用模型:\n{list}\n\n用法: /model <provider/model-id>",
  "cmd.model.notFound": "❌ 找不到模型 \"{id}\"。用 /models 查看可用列表。",
  "cmd.model.ok": "✅ 已切换模型: {model}",
  "cmd.thinking.usage": "当前思考级别: {level}\n可用级别: off, minimal, low, medium, high, xhigh, max\n用法: /thinking <level>",
  "cmd.thinking.ok": "✅ 思考级别已设为: {level}",
  "cmd.session.sessionId": "📊 会话: {id}",
  "cmd.session.messages": "消息数: {count}",
  "cmd.session.tokens": "tokens: {count}",
  "cmd.session.cost": "费用: {cost}",
  "cmd.status.ok": "⚙️ 模型: {model}\n流式中: {streaming}",
  "cmd.name.usage": "用法: /name <会话名>",
  "cmd.name.ok": "✅ 会话已命名: {name}",
  "cmd.export.ok": "✅ 已导出: {path}",
  "cmd.bash.usage": "用法: /bash <shell 命令> — 在 pi 的工作目录执行并写入上下文",
  "cmd.bashstop.none": "💤 没有在跑的 bash 命令。",
  "cmd.bashstop.running": "(已跑 {elapsed})",
  "cmd.bashstop.ok": "⏹ 已请求中止 {count} 条在跑命令:\n{lines}\n各命令已捕获的输出随后回帖。",
  "cmd.help.piCommands":
    "**Pi 命令**(通过 RPC 执行):\n" +
    "• `/new` — 新会话\n" +
    "• `/compact [说明]` — 压缩上下文\n" +
    "• `/model` / `/model <provider/id>` — 查看/切换模型\n" +
    "• `/models` — 列出可用模型\n" +
    "• `/thinking [level]` — 查看/设置思考级别\n" +
    "• `/cyclemodel` / `/cyclethinking` — 轮换到下一个模型 / 思考级别\n" +
    "• `/autocompact on|off` — 自动压缩开关(实例级生效:写入 pi 全局设置,一个项目房间切换影响全部项目)\n" +
    "• `/autoretry on|off` — 自动重试开关(实例级生效,同上)\n" +
    "• `/sessions` — 列出最近会话(按修改时间)\n" +
    "• `/switch <序号>` — 切换到 /sessions 列出的会话(流式中需先 /stop)\n" +
    "• `/attach` — 开启 TUI ↔ Matrix 会话镜像(回复附加命令,终端跑它即可双端同步)\n" +
    "• `/detach` — 关闭会话镜像\n" +
    "• `/last` — 复述 agent 最近一次回复\n" +
    "• `/session` — 会话统计与费用\n" +
    "• `/status` — 当前模型与状态\n" +
    "• `/name <名字>` — 会话命名\n" +
    "• `/export [路径]` — 导出会话 HTML\n" +
    "• `/bash <命令>` — 执行 shell 命令(写入上下文)\n" +
    "• `! <命令>` — 快捷执行 shell 命令(≈ TUI 的 `!`,结果写入上下文;感叹号后需空格)\n" +
    "• `!! <命令>` — 同上,但结果不写入上下文(≈ TUI 的 `!!`)\n" +
    "• `/bashstop` — 列出并中止在跑的 bash 命令(`!`/`!!`/`/bash` 通用)\n" +
    "• `/queue [文本]` — 无参:查看队列;带文本:排队不打断当前任务(≈ Alt+Enter)\n" +
    "• `/interrupt <新指令>` — 打断当前任务并立即下发新指令(一条消息完成)\n" +
    "• `/stop` — 立即停止所有任务(≈ TUI 的 Esc;别名 `/abort`)\n" +
    "• `/reload` — 重启 pi 进程(装插件/改配置后使用);`/reload all` — 重启本实例全部进程(空闲才重启,忙碌跳过)\n" +
    "• `/login [provider [oauth|api_key]]` — 无参:可登录 provider 列表;带参:无头登录(仅管理员 + 管理房间)\n" +
    "• `/logout <provider>` — 删除 provider 凭据(仅管理员 + 管理房间)\n" +
    "• `/auth` — 查看已保存的 provider 凭据(仅管理员 + 管理房间)\n" +
    "• `/pmctl new <名称> <路径>` — 创建项目(管理房间)\n" +
    "• `/pmctl list` — 项目列表\n" +
    "• `/pmctl show|rm|mv|rename` — 项目详情/删除/迁移/重命名(管理房间;\n" +
    "  rm 需二次确认,确认后停止进程并退出房间)",
  "cmd.help.passthrough": "**透传**: `/skill:名称`、提示词模板、扩展命令会直接执行;普通文本发给模型。",

  // ── router(管道回执,message-router.ts)──────────────────────────────
  "common.unknownError": "未知错误",
  "router.turn.failed": "❌ 本轮失败: {message}",
  "router.attach.inject": "用户发来附件(请用 read 工具查看):",
  "router.attach.saved": "📎 附件已保存: {path}({bytes})\n下一条消息发送时会自动附上它。",
  "router.payload.unsupported": "🤷 暂不支持的消息类型({msgtype}),已忽略。文字、图片和文件都可以直接发给我。",
  "router.enable.usage": "用法: /enable <all|mentions|trusted-only>(本房间)",
  "router.enable.allAdminOnly": "❌ all 模式仅管理员可用(可采用 trusted-only 或 mentions)",
  "router.enable.ok": "✅ 本房间已启用 (mode: {mode})",
  "router.multiproject.forbidden": "❌ 无权限(仅信任用户可切换多工程模式)",
  "router.multiproject.currentOn": "多工程模式(开启)",
  "router.multiproject.currentOff": "单工程模式(关闭)",
  "router.multiproject.noChange": "当前已是{current},无需切换。",
  "router.multiproject.switched": "✅ 已{state}多工程模式。\n重启生效:运行 `pi-courier restart`({detail})",
  "router.multiproject.detailOn": "重启后将启用管理房间/项目房间 /pmctl",
  "router.multiproject.detailOff": "重启后所有房间直接连默认 pi",
  "router.multiproject.usage": "当前: {current}\n\n用法:\n/multiproject on  — 开启多工程(重启生效)\n/multiproject off — 关闭多工程,回到单工程(重启生效)",
  "router.login.forbidden": "❌ 无权限(仅管理员可管理 provider 登录)",
  "router.login.roomRestricted": "❌ 登录管理仅可在管理房间使用(单工程模式下与 bot 的私聊即可)",
  "router.login.logoutUsage": "用法: /logout <provider>",
  "router.bang.inProgress": "⏳ 正在执行: {command}{suffix} — 完成后回帖,/bashstop 可中止。",
  "router.prompt.failed": "❌ 无法发送给 pi: {message}",
  "router.rpc.startFailed": "❌ 无法启动 pi 进程: {message}",
  "router.retry.inProgress": "⚠️ 调用失败,正在重试 {attempt}/{max}: {error}",
  "router.retry.exhausted": "❌ 自动重试耗尽: {error}",
  "router.extensionError": "⚠️ 扩展错误 ({path}): {error}",

  // ── mirror(TUI ↔ Matrix 会话镜像,session-mirror.ts / router)─────────
  "mirror.user": "🖥 **TUI** › {text}",
  "mirror.fork.warning":
    "⚠️ 检测到会话分叉(TUI 与 Matrix 同时写入了同一会话,或 TUI 切换了树分支)。\n" +
    "为避免接错上下文,自动接力已暂停;消息仍会继续转发显示。\n" +
    "处理:在 TUI 里用 /tree 选回主分支,或重新 /attach。",
  "mirror.relay.failed": "⚠️ 会话上下文自动接力失败(消息仍会发出,但可能不含 TUI 的最新对话): {message}",

  // ── xq(扩展 UI 提问机,extension-questions.ts)───────────────────────
  "xq.untitled": "(无标题)",
  "xq.confirm.how": "回复 y / n(发送「取消」放弃)",
  "xq.select.how": "回复序号选择(发送「取消」放弃)",
  "xq.input.how": "直接回复内容作为答案(发送「取消」放弃)",
  "xq.confirm.invalid": "⚠️ 请回复 y 或 n(发送「取消」放弃)",
  "xq.select.invalid": "⚠️ 请回复 1 到 {max} 之间的序号(发送「取消」放弃)",
  "xq.notify": "扩展通知: {message}",
  "xq.expired": "⌛ 问题「{title}」超时未答,已按取消处理",
  "xq.answer.lost": "❌ 答案无法回传给 pi(进程可能已退出)",
  "xq.answer.cancelled": "已取消",
  "xq.answer.ok": "✅ 已回应",

  // ── auth(配对/管理命令/无头登录)────────────────────────────────────
  "auth.help.admin":
    "**Bridge 管理命令**: `/help`(本帮助)、`/trusted`、`/revoke`、`/channels`、`/enable`、`/disable`、`/toggletools`\n" +
    "**认证**: 首次私聊 bot → bot 终端与管理房间会显示 6 位验证码 → 在收到提示的那个聊天里输入验证码即成为信任用户(第一个信任用户 = 管理员)。群聊由信任用户在群里发 `/enable <模式>` 启用。",
  "auth.pairing.noPendingHint": "ℹ️ 没有进行中的配对。如需配对,请先私信 bot,收到 6 位配对码后回复即可。",
  "auth.challenge.prompt": "🔐 请输入 bot 管理员提供的 6 位配对码 —— 就在本聊天里发送。\n⏱️ 2 分钟内有效。",
  "login.noProviders": "没有可登录的 provider。",
  "login.authenticated": "✅ 已认证({types})",
  "login.providersList": "🔐 可登录 provider({count}):\n{lines}\n\n用 /login <provider> <oauth|api_key> 开始登录。",
  "login.noCredentials": "💤 暂无已保存凭据(用 /login <provider> <oauth|api_key> 登录)。",
  "login.credentialsList": "🔐 已保存凭据 ({count}):\n{lines}",
  "login.secret.line2": "直接回复密钥内容。",
  "login.secret.line3": "⚠️ 密钥将留在房间历史,建议用后删除该消息(发送「取消」放弃)",
  "login.manualCode.how": "把浏览器授权后最终跳转到的完整 URL 直接粘贴回来(发送「取消」放弃)",
  "login.pendingInRoom": "⚠️ 本房间已有登录流程进行中(发送「取消」中止后再试)。",
  "login.unknownProvider": "❌ 未知 provider: {id}(用 /login 查看可登录列表)",
  "login.usage": "用法: /login <provider> <oauth|api_key>",
  "login.chooseMethod": "⚠️ {id} 支持多种登录方式({methods}),请指定:\n/login {id} oauth\n/login {id} api_key",
  "login.unsupportedMethod": "❌ {id} 不支持 {method} 登录(支持: {methods})",
  "login.started": "🔑 已开始 {id} {method} 登录流程,请按提示操作(任意时刻发送「取消」中止)。",
  "login.cancelled": "🛑 已取消 {id} 的登录流程",
  "login.noStoredCred": "❌ {id} 没有已保存的凭据(用 /auth 查看)",
  "login.logoutOk": "✅ 已删除 {id} 的凭据。运行中的 pi 进程仍持有旧凭据,空闲后执行 /reload all 使登出生效。",
  "login.logoutFailed": "❌ 登出失败: {message}",
  "login.readFailed": "❌ 读取凭据失败: {message}",
  "login.success": "✅ {id} 登录成功,凭据已写入 {path}",
  "login.failed": "❌ {id} 登录失败: {message}",
  "login.authUrl": "🌐 请在浏览器打开以下链接完成授权:\n{url}",
  "login.deviceCode": "🔑 设备码: {code}",
  "login.deviceCodeOpen": "请在浏览器打开 {uri} 并输入上述设备码。",
  "login.expiresMinutes": "(有效期约 {minutes} 分钟)",

  // ── mgmt / space(管理房与空间,management-room.ts / space.ts)─────────
  "common.unknownAccount": "(未知)",
  "mgmt.name": "项目管理（{name}）",
  "mgmt.groupJoinHint":
    "🤖 我已加入这个群聊,但默认不回应群消息。\n\n" +
    "启用方式:直接在群里发 /enable trusted-only\n" +
    "(或 all = 回应所有人 / mentions = 只回应 @我;仅信任用户可启用)",
  "mgmt.help":
    "🏗️ **项目管理房间**（{instanceName}）\n\n" +
    "• bot 账号: `{botAccount}`\n" +
    "• 默认工作目录: `{workdir}`\n\n" +
    "这里是本实例的管理台。直接发消息 = 在默认项目({workdir})里与 pi 对话。\n\n" +
    "📁 **项目管理**(仅本房间可用)\n" +
    "• `/pmctl new <名称> [路径]` — 创建项目(自动建私有房间并拉你进入)\n" +
    "• `/pmctl list` — 项目列表\n" +
    "• `/pmctl show|rm|mv|rename` — 项目详情/删除/迁移/重命名\n\n" +
    "⚡ **常用命令**\n" +
    "• `/stop` — 停止当前任务\n" +
    "• `/reload` — 重启 pi 进程\n" +
    "• `/help` — 完整帮助",
  "mgmt.adminPowerNote": "🛡️ 信任用户会自动获得房间管理员权限(含新建的项目房间)。",
  "space.linkFailedMgmt": "管理房间挂入空间失败(下次启动自动重试,房间仍可用): {message}",
  "space.linkFailed": "挂入空间失败(不影响项目): {message}",
  "space.avatarFailed": "头像设置失败(下次启动自动补): {message}",
  "space.badAvatarFile": "非法的头像文件名: {file}",

  // ── label(项目标签校验,project-labels.ts)───────────────────────────
  "label.empty": "项目名不能为空",
  "label.noBrackets": "项目名不能包含方括号 [ ](会破坏日志格式)",
  "label.noWhitespace": "项目名不能包含空白字符",
  "label.tooLong": "项目名最长 {max} 字符(当前 {length})",
  "label.caseClash": "项目名「{name}」与现有项目「{clash}」仅大小写不同(日志过滤按名字匹配,会混淆)",

  // ── pmctl(多工程管理,/pmctl 家族)───────────────────────────────────
  "pmctl.singleProjectMode": "❌ 当前为单工程模式,未启用项目管理。\n如需多工程:发 `/multiproject on` 并重启(pi-courier restart)。",
  "pmctl.managementRoomOnly": "❌ /pmctl 仅可在管理房间(与 bot 的私聊)使用",
  "pmctl.matrixOnly": "❌ /pmctl 不可用(仅 Matrix 部署支持)",
  "pmctl.unknownOp": "❌ 未知操作: {op}\n可用操作: new / list / show / rm / mv / rename",
  "pmctl.new.usage": "用法: /pmctl new <项目名> [路径]\n路径可选:缺省为工程根下同名目录(如 newapp → ~/Projects/newapp);也可用相对路径或绝对路径。",
  "pmctl.noInviteTarget": "❌ 缺少邀请对象(未配置信任用户)",
  "pmctl.new.elevationFailed": "⚠️ 房间已创建,但信任用户补权失败(可手动设置): {message}",
  "pmctl.new.ok": "✅ 项目「{name}」创建完成!\n\n• 房间: {room}\n• 工作目录: {workdir}\n• 已邀请你进入新房间\n\n项目对话请到新房间进行(独立上下文与工作目录)。{notes}",
  "pmctl.new.failed": "❌ 创建项目失败: {message}",
  "pmctl.empty": "暂无项目(用 /pmctl new <名称> <路径> 创建)",
  "pmctl.statusRunning": "✅ 运行中",
  "pmctl.statusStopped": "⏸️ 未启动",
  "pmctl.statusLazy": "⏸️ 未启动(lazy)",
  "pmctl.list": "**项目列表** ({count}):\n{lines}",
  "pmctl.show.usage": "用法: /pmctl show <项目名|房间ID>",
  "pmctl.notFound": "❌ 未找到项目: {target}(用 /pmctl list 查看)",
  "pmctl.show.ok": "📁 项目: {name}\n• 房间: {room}\n• 工作目录: {workdir}\n• 状态: {status}\n• 会话: {session}",
  "pmctl.rm.usage": "用法: /pmctl rm <项目名|房间ID>",
  "pmctl.rm.cancelled": "✅ 已取消删除",
  "pmctl.rm.nothingPending": "当前没有待确认的删除操作",
  "pmctl.rm.expired": "⏳ 上次确认已超时(60 秒),需重新确认。",
  "pmctl.rm.done": "🗑️ 项目「{name}」已删除\n• 已解除映射并停止进程\n• 工作目录保留: {workdir}(如需删除请自行处理)\n• 正在主动退出房间…",
  "pmctl.rm.unlinkFailed": "⚠️ 从空间移除失败(空间里可能残留条目,可手动移除): {message}",
  "pmctl.rm.leaveFailed": "⚠️ 房间退出失败(可手动退出): {message}",
  "pmctl.leaveReason": "项目已删除",
  "pmctl.rm.confirm": "⚠️ 确认删除项目「{name}」?\n\n再次发送 `/pmctl rm {name}` 确认删除。\n确认后我会停止进程并主动退出该房间。\n(发送 `/pmctl rm cancel` 取消)",
  "pmctl.mv.usage": "用法: /pmctl mv <项目名|房间ID> <新路径>(相对路径基于工程根)",
  "pmctl.mv.done": "🚚 项目「{name}」已迁移\n• 新工作目录: {workdir}\n• 会话将重新开始(旧会话保留在旧目录 .pi-session)",
  "pmctl.rename.usage": "用法: /pmctl rename <项目名|房间ID> <新名称>",
  "pmctl.rename.ok": "✏️ 项目已重命名为「{name}」",
  "pmctl.rename.roomFailed": "(房间改名失败: {message})",

  // ── attach / room / workdir / logs(传输与运行时)──────────────────────
  "attach.tooLarge": "附件过大({declared} > 上限 {max}),未保存。请压缩后重发,或让管理员调大 attachments.maxMb 配置。",
  "attach.downloadFailed": "附件下载失败: {detail}",
  "attach.noMediaUrl": "事件中没有可下载的媒体地址",
  "attach.e2eeRequired": "加密附件需要启用 E2EE(部署未开启加密或 crypto 原生库不可用)",
  "attach.downloadTimeout": "下载超时({seconds}s)",
  "attach.e2eeNativeMissing": "E2EE crypto 原生库不可用,无法解密加密附件",
  "room.notConnected": "Matrix 未连接",
  "workdir.prompt": "未配置工作目录。请输入 pi 工作目录 [默认 {fallback}]: ",
  "logs.unknownLevel": "未知日志级别: {level}(可选: debug / info / warn / error)",
  "logs.noProjects": "(当前无项目)",
  "logs.projectsNotFound": "未找到项目: {unknown}\n可用项目: {list}",

  // ── cli(命令行参数与子命令输出)────────────────────────────────────
  "cli.arg.deprecatedSetup": "⚠️  旧参数已废弃,请用 `pi-courier setup`",
  "cli.arg.deprecatedCliPath": "⚠️  旧参数已废弃,请在 ~/.pi/pi-courier.json 配置 cliPath,或设 PI_CLI_PATH",
  "cli.arg.deprecatedSessionDir": "⚠️  旧参数已废弃,请在 ~/.pi/pi-courier.json 配置 sessionDir",
  "cli.arg.deprecatedDebug": "⚠️  旧参数已废弃,请在 ~/.pi/pi-courier.json 配置 debug: true",
  "cli.arg.unknown": "⚠️  忽略未知参数: {arg}(旧参数已废弃,请用配置或子命令)",

  // ── setup(首跑向导;语言首问之后,以下全部跟随所选语言)───────────────
  "setup.title": "=== pi-courier 配置向导 ===",
  "setup.languagePrompt": "语言? [{def}] (en/zh): ",
  "setup.header": "将写入 ~/.pi/pi-courier.json(权限 600;已有配置作为默认值,直接回车沿用)\n",
  "setup.homeserver.default": "Matrix homeserver URL [默认 {def}]: ",
  "setup.homeserver.plain": "Matrix homeserver URL (如 https://matrix.example.com): ",
  "setup.homeserver.empty": "homeserver URL 不能为空",
  "setup.token.mode": "获取 token 方式 [1=用户名密码登录, 2=粘贴已有 token] (1): ",
  "setup.token.paste": "粘贴 access token (syt_...): ",
  "setup.token.empty": "token 不能为空",
  "setup.token.valid": "✅ token 有效,账号: {user}",
  "setup.token.username": "bot 用户名 (如 test2): ",
  "setup.token.password": "bot 密码: ",
  "setup.token.credsEmpty": "用户名/密码不能为空",
  "setup.token.loggingIn": "登录中…",
  "setup.token.loginOk": "✅ 登录成功,账号: {user}{device}",
  "setup.token.loginDevice": "(设备 {id})",
  "setup.token.loginFailed": "登录失败 (HTTP {status}): {body}",
  "setup.token.missingAccessToken": "登录响应缺少 access_token",
  "setup.token.whoamiFailed": "token 验证失败 (HTTP {status})",
  "setup.token.keep": "保留现有 token? [Y/n]: ",
  "setup.token.kept": "✅ 沿用现有 token,账号: {user}",
  "setup.token.hsChanged": "ℹ️  homeserver 已变更,需要重新获取 token",
  "setup.admin.prompt": "信任用户(管理员)MXID [默认 {def}]: ",
  "setup.admin.badMxid": "MXID 应以 @ 开头,如 @barry:matrix.example.com",
  "setup.rooms.prompt": "信任房间 ID(可选,回车跳过;多个逗号分隔,如 !abc:server 或 !abc:server:trusted-only): ",
  "setup.rooms.invalid": "   ⚠️ 跳过无效房间 ID: {room}(应以 ! 开头)",
  "setup.e2ee.defaultYes": "启用 E2EE 加密? [Y/n] [默认 是]: ",
  "setup.e2ee.plain": "启用 E2EE 加密? [y/N]: ",
  "setup.workdir.prompt": "pi 工作目录 [默认 {def}]: ",
  "setup.attach.dirPrompt": "附件保存目录 [默认 {def}]: ",
  "setup.attach.mbPrompt": "单个附件大小上限 MB [默认 {def}]: ",
  "setup.attach.mbInvalid": "附件大小上限应为正整数(MB)",
  "setup.instance.prompt": "实例名/机器名(默认 {def};多台部署用来区分,将显示在管理房间名): ",
  "setup.multiProject.prompt": "启用多工程模式? [y/N](多工程=管理房间+项目房间隔离,可用 /pmctl;默认 N=单工程,一个 bot 对应一个 pi): ",
  "setup.space.promptYes": "启用空间组织? [Y/n](Element 空间收纳管理/项目房间,重启后自动创建): ",
  "setup.space.promptNo": "启用空间组织? [y/N](Element 空间收纳管理/项目房间,重启后自动创建): ",
  "setup.space.stateOn": "开启(重启后创建空间并收纳管理/项目房间)",
  "setup.done.title": "\n✅ 配置已写入 ~/.pi/pi-courier.json",
  "setup.done.account": "   账号: {user}",
  "setup.done.trusted": "   信任用户: {user}",
  "setup.done.e2ee": "   E2EE: {state}",
  "setup.done.workdir": "   工作目录: {workdir}",
  "setup.done.attachments": "   附件目录: {dir}(上限 {max} MB)",
  "setup.done.instance": "   实例名: {name}(用于多台部署区分,显示在管理房间名)",
  "setup.done.multiProject": "   多工程: {state}",
  "setup.done.multiProjectOff": "关闭(单工程)",
  "setup.done.space": "   空间组织: {state}",
  "setup.done.deviceId": "   设备 ID: {id}(固定,重跑 setup 复用;想换设备就删掉此字段)",
  "setup.done.rooms": "   信任房间: {rooms}",
  "setup.done.noRooms": "无(群聊默认不回应;可后续用 /enable 添加)",
  "setup.next": "\n下一步: pi-courier enable(开机自启)或 pi-courier run(前台运行)",
  "setup.failed": "\n❌ 配置失败: {message}",

  // ── cli(子命令输出)与 systemd 总线提示 ──────────────────────────────
  "cli.usage": `pi-courier — run the pi coding agent from your messenger

用法:
  pi-courier setup     首次运行配置向导(Matrix 账号、信任用户、工作目录)
  pi-courier run       前台运行(--workdir 可覆盖配置里的工作目录)
  pi-courier enable    安装用户级 systemd 服务并开机自启、立即启动
  pi-courier start      启动服务
  pi-courier stop       停止服务
  pi-courier restart    重启服务
  pi-courier status     查看服务状态与最近日志(可带项目名过滤)
  pi-courier logs      跟踪服务日志(Ctrl+C 退出);多工程下可加项目名过滤:
                       pi-courier logs <项目> [项目...] [--level debug|info|warn|error]
  pi-courier disable   卸载服务(停止 + 取消自启 + 删除 unit 文件)
  pi-courier update    更新本项目(git pull + 安装依赖 + 重新构建)
  pi-courier -v        显示版本号(--version / version 亦可)

说明:pi 由系统独立安装与升级(npm i -g @earendil-works/pi-coding-agent),
本项目只更新自身。`,
  "cli.unknownCommand": "\n❌ 未知命令: {cmd}",
  "cli.enable.nodeTooOld": "⚠️  当前 Node 版本为 v{version},pi 的 undici 需要 Node >= 21。建议用 nvm 安装 v24 后重新执行本命令。",
  "cli.enable.unitWritten": "📝 已写入 {path}",
  "cli.enable.failed": "❌ 服务未能启用(unit 文件已写入,但 systemd 操作失败: {steps})。",
  "cli.enable.ok": "✅ 服务已启用并启动(开机自启)。",
  "cli.enable.logsHint": "   日志: journalctl --user -u {unit} -f",
  "cli.systemctl.failed": "❌ systemctl {args} 失败(退出码 {status})",
  "cli.service.notInstalled": "❌ 服务未安装。先运行 `pi-courier enable` 安装。",
  "cli.service.statusFailed": "⚠️ 服务状态查询失败(退出码 {status})——以下为 journald 历史日志,不代表服务当前在运行。",
  "cli.service.singleProjectNoFilter": "❌ 当前为单工程模式,日志不区分项目(多工程模式才打项目标签)。",
  "cli.disable.notInstalled": "❌ 服务未安装(unit 文件不存在)。",
  "cli.disable.keptUnit": "ℹ️ unit 文件已保留,修复环境后可再次 `pi-courier disable` 或直接 `pi-courier enable`。",
  "cli.disable.ok": "✅ 服务已停止并卸载。以后要恢复:`pi-courier enable`(配置不受影响)。",
  "cli.update.stopping": "🛑 停止服务…",
  "cli.update.npmUpgrade": "🔄 通过 npm 升级 pi-courier …",
  "cli.update.nativeSkipped": "   (E2EE 原生库已存在,跳过 21MB 下载)",
  "cli.update.npmFailed": "❌ npm 升级失败(退出码 {status})",
  "cli.update.gitUpgrade": "🔄 更新 pi-courier(git)…",
  "cli.update.cmdFailed": "❌ {cmd} 失败(退出码 {status})",
  "cli.update.restarting": "🔄 重新启动服务…",
  "cli.update.restarted": "✅ 服务已重新启动。",
  "cli.update.wasInactive": "\nℹ️  更新前服务未运行,已跳过启动。",
  "cli.update.startHint": "   如需启动服务: pi-courier start",
  "cli.update.done": "\n✅ 更新完成。",
  "hint.bus.ownerMismatch": "💡 检测到 XDG_RUNTIME_DIR={dir}(属主 uid {owner})指向其他用户的会话总线,而当前用户是 uid {euid}。",
  "hint.bus.connectFailed": "💡 未能连接到当前用户的 systemd 会话总线(XDG_RUNTIME_DIR={dir})。",
  "hint.bus.unset": "未设置",
  "hint.bus.unsetWithParens": "(未设置)",
  "hint.bus.tail1": "   常见原因:用 `su <用户>`(不带 -)切换用户时继承了原用户的环境,或当前 shell 缺少完整登录会话。",
  "hint.bus.tail2": "   解决:export XDG_RUNTIME_DIR=/run/user/$(id -u) 后重试,或改用 `su - <用户>` 重新切换;",
  "hint.bus.tail3": "   若 /run/user/$(id -u) 不存在,请以该用户登录一次,或由 root 执行 loginctl enable-linger <用户>。",

  // ── startup(语言配置可见性;语言功能自身的一部分,破例双语)─────────
  "startup.language.system":
    "language: {locale}(检测自系统 locale;如需固定,请在 ~/.pi/pi-courier.json 配置 \"language\" 或设 PI_LANGUAGE)",
  "startup.language.default":
    "language: {locale}(默认值;如需固定,请在 ~/.pi/pi-courier.json 配置 \"language\" 或设 PI_LANGUAGE)",
  "startup.pairingNotice": "🔐 配对码 @{username}: {code}(2 分钟内有效,发给该用户用于配对)",
} as const;

export type MessageKey = keyof typeof zh;
export default zh;
