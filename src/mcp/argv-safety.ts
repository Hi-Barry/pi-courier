/**
 * /mcp add 的上游 argv 语义镜像与回执脱敏(spec #246 → #360 入籍 mcp 域)。
 *
 * 这是安全载荷:正确性 = 密钥不泄漏,依赖对 pi 上游解析器行为的持续镜像
 * (dist/extensions/mcp/cli.js 的 parseOptions known 表与 Unknown option
 * 整 token 回显),连续 5 个修复工单(#246 评审 + sec-mcp-secret-redaction
 * 系列)都在加镜像精度 —— 这份知识需要单一住处。pi-rpc.ts 的 COMPAT 层
 * 是"上游私有行为"的总住处(stdin 直写/私有 send/错误哨兵),本模块是其
 * 在 mcp 域的分支;上游重构时两处都查。
 */
/** add 的带值 flag(值取下一 token)。清单对齐 pi 1.0.0
 *  dist/extensions/mcp/cli.js:212-227 的 parseOptions known 表 —— 漏掉
 *  任何一个都会把它的值当成服务器名(flag 出现在名字之前时回执/审计记错名)。 */
const MCP_ADD_VALUED_FLAGS = new Set([
  "--url",
  "--env",
  "--header",
  "--cwd",
  "--description",
  "--exposure",
  // pi 1.0 的 HTTP/OAuth 选项(与 --url 同族,带值):
  "--bearer-token-env-var",
  "--oauth-client-id",
  "--oauth-client-secret",
  "--oauth-callback-port",
  "--oauth-client-name",
]);

/** scanMcpAddArgv 的产出:服务器名、脱敏名单(--env/--header
 *  /--oauth-client-secret 的值)、v1 不支持的 --local 是否出现。 */
export interface McpAddScan {
  name: string | undefined;
  secrets: string[];
  localFlag: boolean;
}

/** 把一个值与其拆分形态都收进脱敏名单:整串 + 首个分隔符之后的值部分
 *  (原样与 trim 两种形态)。pi 的报错可能只引用值部分、回显也可能丢了
 *  前导空格,只遮整串会漏(spec #246 回执安全纪律)。 */
function pushSecretFragments(secrets: string[], value: string, separator: string): void {
  secrets.push(value);
  const at = value.indexOf(separator);
  if (at < 0) return;
  const rest = value.slice(at + 1);
  if (rest.length > 0) secrets.push(rest);
  const trimmed = rest.trim();
  if (trimmed.length > 0 && trimmed !== rest) secrets.push(trimmed);
}

/** 按空格形态的同一规则把一个 flag 的值收进脱敏名单(--env/--header 拆分
 *  形态、--oauth-client-secret 整值);空格形态与连写形态共用,不认的
 *  flag 原样 no-op(未知 flag 不猜,透传给 pi 裁决)。 */
function collectValueSecrets(secrets: string[], token: string, value: string): void {
  if (token === "--env") {
    // K=V 形态(pi parsePairs 实际按 = 切):整串与「= 之后的值」
    // 都进脱敏名单 —— pi 的报错可能只引用值部分,只遮整串会漏
    // (spec #246 回执安全纪律)。
    pushSecretFragments(secrets, value, "=");
  } else if (token === "--header") {
    // = 切割照旧(pi 对 --header 同样要求 KEY=VALUE);冒号形态
    // (curl 风格 K:V)pi 会拒绝并整串回显,但值部分单独出现在
    // 其它诊断/旧版 pi 模型回显里时只遮整串会漏 —— 冒号切割的
    // 值部分(含 trim 形态)一并进名单(工单 sec-mcp-secret-redaction)。
    pushSecretFragments(secrets, value, "=");
    pushSecretFragments(secrets, value, ":");
  } else if (token === "--oauth-client-secret") {
    // 整个值就是密钥本体,无子结构可切(工单 sec-mcp-secret-redaction)。
    secrets.push(value);
  }
}

/**
 * 扫描 add argv:第一个位置参数 = 服务器名;--env/--header
 * /--oauth-client-secret 的值进脱敏名单(审计与回执都不落值,spec #246
 * 回执安全纪律);遇 `--` 即停 —— 其后是透传的本地命令,flag 语义(含
 * --local/--env)不再适用。未知 flag 不猜,透传给 pi 裁决。
 */
export function scanMcpAddArgv(argv: readonly string[]): McpAddScan {
  let name: string | undefined;
  const secrets: string[] = [];
  let localFlag = false;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token === "--") break;
    if (token === "--local") {
      localFlag = true;
      continue;
    }
    if (MCP_ADD_VALUED_FLAGS.has(token)) {
      const value = argv[i + 1];
      if (value !== undefined) {
        collectValueSecrets(secrets, token, value);
        i += 1;
      }
      continue;
    }
    if (token.startsWith("--")) {
      // 连写形态 --flag=value:pi parseOptions 对 -- 开头 token 按整个 arg
      // 查 known 表、连写从不拆分(cli.js:89-101)—— 已知 flag 连写(name
      // 变 url=https://x)与 typo/大小写不符 flag(--enva=K=sk-…)一律
      // `Unknown option <整 token>.` 连值整串回显(stderr 尾部 → 回执),
      // 值必须入名单:值 + 值片段(=/: 切割,K=V/K:V 结构的值部分单独
      // 回显也遮)一律收;三个密钥 flag 再按各自规则补切割(--env =、
      // --header =+:、--oauth-client-secret 整值)。空格形态维持不收 ——
      // pi 对未知空格 flag 只回显 flag 名、值不出现(cli.js:100),现状
      // 安全。只补脱敏,argv 原样透传不动。
      const eq = token.indexOf("=");
      if (eq >= 0) {
        const value = token.slice(eq + 1);
        if (value.length > 0) {
          pushSecretFragments(secrets, value, "=");
          pushSecretFragments(secrets, value, ":");
          collectValueSecrets(secrets, token.slice(0, eq), value);
        }
      }
      continue;
    }
    if (name === undefined) name = token;
  }
  return { name, secrets, localFlag };
}

/** 回执脱敏:--env/--header/--oauth-client-secret 的值绝不回显
 *  (整串精确替换,空值跳过)。 */
export function redactMcpSecrets(message: string, secrets: readonly string[]): string {
  // 按长度降序替换:不同 flag 的值/值片段可能互为子串(如 --env K=Bearer 撞
  // --header 'Authorization: Bearer <token>'),按名单原序先替换短片段会把
  // 长整串/长片段打碎、后续匹配不上,token 残段漏遮;降序保证被包含者先遮
  // (评审 sec-mcp-secret-redaction 实证)。拷贝排序,不动调用方名单。
  const ordered = [...secrets].sort((a, b) => b.length - a.length);
  let out = message;
  for (const secret of ordered) {
    if (secret.length > 0) out = out.split(secret).join("***");
  }
  return out;
}
