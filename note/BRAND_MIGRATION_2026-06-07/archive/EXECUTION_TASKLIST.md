# 执行清单（交执行 agent）· 品牌去标识收尾

**目标**：让用户感知不到 Claude/Anthropic/OpenClaude；**真实暴露面 = 进打包产物 / 发往 LLM 网关 / 进日志的字符串字面量**。
**前置已完成**：D1–D6、D4-a/b/c、D5、guide agent 禁用、批次1 高频文案（见 DECISIONS.md / 已 6+ 提交）。
**本清单只做剩余长尾**。每步都 `bun run build && bun test --max-concurrency=1` 保持绿。

---

## 任务路由（谁做什么）

| 任务 | 交执行 agent ✅ / 亲自 ⚠️ / 运维 🧑 | 原因 |
|---|---|---|
| Tier 3 **注释** sweep（Claude/Claude Code/CLAUDE.md in `//`、`*`） | ✅ agent | 不进 bundle、零风险、纯机械 |
| B1 **本工具类**字符串（UI/帮助/提示里的 Claude Code/OpenClaude→YwCoder，CLAUDE.md→YWCODER 文本） | ✅ agent（带护栏） | 规则清晰、可 build/test/dist 自校验；遇"外部产品"语境→记 HUMAN_REVIEW_NEEDED 不改 |
| Phase C **dist 扫描出报告** | ✅ agent | 跑命令即可 |
| B2 **裸 Claude 字符串**（助手自指 vs 事实性 Anthropic/模型/外部产品） | ⚠️ 亲自 | 高语义判断，错改风险大 |
| agent 记到 **HUMAN_REVIEW_NEEDED** 的疑难 | ⚠️ 亲自 | 外部产品语境/功能符号/不确定项 |
| Phase C **独立终审** | ⚠️ 亲自（或起 reviewer agent） | 不自审原则 |
| **文件系统产物**运行时核查（临时目录/文件名） | ⚠️ 亲自 | 需跑程序观察，grep 漏 |
| Phase D **CI 打包 → 内网测试 → 合并 main** | 🧑 运维 | 外部流程 |

**一句话**：机械替换+强护栏+可自动验证 → agent；需语义判断/碰功能/终审 → 亲自；CI/内网/合并 → 运维。
**给 agent 的硬规则**：不确定一律记 HUMAN_REVIEW_NEEDED **不猜**；每步 `bun run build && bun test` 绿；中文 commit、不加 Co-Authored-By、`git add -u`（勿带 `*.tgz`/脚本）。

---

## 核心方法：dist 扫描驱动（自校验，优先用这个）

源码 grep 会把注释也算进来（注释不进 bundle，是噪声）。**以打包产物为准**：

```bash
bun run build
KEEP='claude-[0-9a-z]|ANTHROPIC_|anthropics/|claude\.ai|code\.claude\.com|docs\.claude|Claude-User|McpClaudeAI|ClaudeAIProxy|claudeai-proxy|@anthropic|us\.anthropic|CLAUDE_CODE_|\.claude|Anthropic API|Anthropic Console|Anthropic-|api\.anthropic|Anthropic native|Anthropic OAuth|AnthropicBedrock|AnthropicVertex|AnthropicFoundry|AnthropicError|AnthropicUsage|isAnthropic|isFirstPartyAnthropic|StreamToAnthropic|ToAnthropic|AnthropicControlled'
# 列出 dist 里真正需要处理的品牌字符串上下文
grep -oE '.{30}(Claude Code|OpenClaude| Claude |Anthropic).{30}' dist/cli.mjs \
  | grep -viE "$KEEP" | sort -u
```

对每一条命中：回到源码改掉对应字符串 → 重新 build → 该条从 dist 消失即完成。循环到清单为空（除 keep-list）。

---

## 替换规则（大小写敏感）

| 原文 | 改为 |
|---|---|
| `Claude Code` | `YwCoder` |
| `OpenClaude` / `Open Claude` | `YwCoder` |
| `CLAUDE.md` / `CLAUDE.local.md`（**仅注释/提示文本**） | `YWCODER.md` / `YWCODER.local.md` |
| 裸 `Claude`（指本助手/工具时） | `YwCoder` |

## 🚫 护栏：命中以下一律**不改**（功能性 / 生态 / keep-list）

```
@anthropic-ai   claude-3/sonnet/opus/haiku/claude-<版本号>   ANTHROPIC_<大写>
anthropics/   claude.ai   code.claude.com   docs.claude   Claude-User(UA)
CLAUDE_CODE_<大写>   .claude/ 目录   claudeai-proxy   us.anthropic.*
符号名：AnthropicBedrock/Vertex/Foundry、AnthropicError/Usage、isAnthropic*、
        isFirstPartyAnthropic*、*StreamToAnthropic、McpClaudeAIProxy* 等
src/utils/claudemd.ts、src/utils/config.ts 内的 CLAUDE.md 字面量（旧文件回退名）
provider 描述里的 "Anthropic native API"（与 "OpenAI-compatible" 同类，provider 命名）
```
**判据**：句中能否把 Claude/Anthropic 换成"YwCoder/本工具"而语义仍正确？能→改；指 Anthropic 公司/模型/外部产品/provider 协议→留。不确定→记到 `HUMAN_REVIEW_NEEDED.md`，不猜。

---

## 优先级分层（按暴露危害）

### Tier 1 🔴 活跃路径的字符串（最高危：会跑到、会发网关、会进日志）
通过 dist 扫描定位，重点文件（非禁用功能）：
- 日志：`src/services/api/client.ts` 的 `[Anthropic SDK ...]` 前缀（如要改）；`console.*` 含 Claude 的
- 提示/分类器：`src/utils/sideQuery.ts`、`src/services/rateLimitMessages.ts`、`src/services/api/errors.ts`
- 工具/UI：`src/utils/deepLink/registerProtocol.ts`、`src/utils/secureStorage/keychainPrefetch.ts`、`src/skills/bundled/scheduleRemoteAgents.ts`、`src/utils/config.ts`

### Tier 2 🟡 已禁用功能的字符串（仍进 bundle，可被 grep，但用户触发不到）
这些命令已 `isEnabled:()=>false` 但字符串仍打包。按 bundle 洁净度处理：
- `install.tsx`、`thinkback/`、`passes/`、`cost/`、`chrome/`+`claudeInChrome/`、`DesktopUpsell`、`ConsoleOAuthFlow`、`ultraplan.tsx`、`RemoteSessionDetailDialog.tsx`、`teleport.tsx`、`WorkflowMultiselectDialog.tsx`、`github-app.ts`、`tipRegistry.ts`、TranscriptSharePrompt
- 注意：部分指**外部 Anthropic 产品/订阅**（Claude Desktop、Claude 订阅、官方市场）——这类把品牌词改 YwCoder 会语义错误，应**中性化或保留**，按护栏判据处理。

### Tier 3 🟢 注释里的裸 Claude / CLAUDE.md（不进 bundle）
最低优先级，**可不做**（build 已剥离，不暴露）。若为源码整洁，最后批量过。

---

## 机械批量（可选加速）
`scripts/process_brand_worklist.ts` + 重生成的 worklist 可处理 Tier 1/2 的 `Claude Code`/`OpenClaude`/`CLAUDE.md` 部分。**先重生成 worklist**（旧的已过期），并确保脚本护栏与上表一致（尤其 CLAUDE.md 现在该迁移、claudemd.ts/config.ts 除外）。裸 Claude 因风险高，建议人工按 dist 清单过，不要交脚本盲扫。

## ⚠️ 文件系统产物（grep/dist 扫描易漏，需运行时观察）
品牌也会泄漏到**运行时生成的文件/目录名**，这类 dist 字符串扫描难以从普通 'claude' 子串中区分，需实际跑一遍观察：
- ✅ **已处理**：临时目录 `Temp\claude\`→`Temp\ywcoder\`（中心函数 `getClaudeTempDirName` + 各硬编码 `tmpdir()/claude*`，commit f97bf51）。
- **仍需运行时核查**：写入用户磁盘的其它文件/目录名、日志文件名、缓存目录、生成的配置/产物文件名等。建议实际启动跑常见操作（/copy、截图、插件、--print、sandbox），观察 `~/`、`Temp/`、项目目录下新建的文件名有无 claude/anthropic。
- 保留：`claudeInChrome` 的 `claude-mcp-browser-bridge-*`（legacy 清理引用，Chrome 已禁用）、`.claude-plugin/`（插件清单生态约定）、`.claude/` 目录（D7 暂缓）。

## 完成判据（验收）
```bash
bun run build && bun test --max-concurrency=1   # 全绿
# dist 扫描只剩 keep-list / 符号名：
grep -oE '.{15}(Claude Code|OpenClaude| Claude |Anthropic).{15}' dist/cli.mjs | grep -viE "$KEEP" | sort -u
# 期望：输出为空，或剩余均可在护栏中解释
```
完成后交回主线做 Phase C 终审 + Phase D（CI 打包 → 内网测试 → 合并 main）。
