# 给执行 agent 的 Prompt（B1 本工具字符串 + Tier3 注释）

> 直接把下面代码块的内容粘给执行 agent。它自包含关键护栏；完整背景见 START_HERE.md / EXECUTION_TASKLIST.md。

```text
你是 ywcoder-cli「品牌去标识」工程的执行 agent。仓库根目录就是当前工作目录，
分支 feature/brand-replacement。先读 note/BRAND_MIGRATION_2026-06-07/START_HERE.md
和 EXECUTION_TASKLIST.md 了解背景，再按下面规则干活。

## 你的任务（只做这两块，别越界）
A) Tier3 注释 sweep：源码注释（// 行、/* */、* 开头行）里的品牌词。
B) B1 本工具字符串：UI/帮助/提示等字符串字面量里、指「本工具」的品牌词。

## 替换规则（大小写敏感）
- `Claude Code` → `YwCoder`
- `OpenClaude` / `Open Claude` → `YwCoder`
- `CLAUDE.md` → `YWCODER.md`，`CLAUDE.local.md` → `YWCODER.local.md`
- 裸 `Claude`（单独的 Claude，指本助手/工具）：**仅在注释里**改成 `YwCoder`；
  **字符串里的裸 Claude 不要动**（那是 B2，留给人工）。

## 🚫 硬护栏：命中下列任意一项，整处**不改**（功能性/生态，改了会坏）
@anthropic-ai ；claude-3 / claude-sonnet / claude-opus / claude-haiku / claude-<任意版本号> ；
ANTHROPIC_<大写> ；CLAUDE_CODE_<大写> ；anthropics/ ；claude.ai ；code.claude.com ；
docs.claude ；Claude-User（User-Agent）；.claude/ 目录路径 ；claudeai-proxy ；us.anthropic.* ；
符号名 AnthropicBedrock/Vertex/Foundry、AnthropicError/Usage、isAnthropic*、
isFirstPartyAnthropic*、*StreamToAnthropic、McpClaudeAIProxy* 等（函数/类/变量名一律不动）；
provider 描述 "Anthropic native API"（与 "OpenAI-compatible" 同类）；
src/utils/claudemd.ts 和 src/utils/config.ts 里的 CLAUDE.md 字面量（这是旧文件回退名，必须保留）。

## ⚠️ 外部产品判断（B1 关键）
有些 `Claude Code` 指的是**外部 Anthropic 产品/服务**，不是本工具，改成 YwCoder 会语义错误：
Claude Desktop（桌面端）、Claude 订阅/subscription、官方插件市场/marketplace、
Claude Code on the web / CCR、claude-code-action（GitHub Action）、stickers/贴纸、passes/邀请、
overage/订阅用量 等。
判据：把这句里的 Claude/Claude Code 换成「本工具/YwCoder」后语义是否仍正确？
- 正确 → 改。
- 不正确（指外部产品/公司/模型）→ **不要改**，把该处「文件:行号 + 原文 + 原因」追加到
  note/BRAND_MIGRATION_2026-06-07/HUMAN_REVIEW_NEEDED.md，交人工。
- 任何拿不准的 → 同样记 HUMAN_REVIEW_NEEDED，**不要猜**。

## 工作流程（小步快跑）
0. 先确认基线绿：`bun run build && bun test --max-concurrency=1`（应 571 pass / 0 fail）。
1. 先做 Tier3（注释，最安全）：按文件/目录小批量改，每批后跑 `bun run build && bun test
   --max-concurrency=1`，绿了再继续；红了立即回退最后一次编辑。
2. 再做 B1（字符串）：逐文件处理，按上面规则改本工具引用、跳过外部产品（记 review）。
   同样每批 build+test 保持绿。
3. 提交：中文 commit message，**不加 Co-Authored-By**；只 `git add -u`
   （绝不提交 dcywzc-ywcoder-*.tgz 和 scripts/process_brand_worklist.ts 这两个未跟踪文件）。
   建议按"Tier3 注释一批 / B1 一批"分多次提交，message 写清范围。
4. 可选加速：scripts/process_brand_worklist.ts 可批处理，但**先重生成 worklist**（旧的已过期），
   且确保脚本护栏与上面一致；裸 Claude 字符串别交脚本盲扫。

## 验收（做完自查）
- `bun run build && bun test --max-concurrency=1` 全绿。
- 跑 dist 扫描，确认 B1 目标已减少、剩余都能用护栏解释：
  KEEP='claude-[0-9a-z]|ANTHROPIC_|anthropics/|claude\.ai|code\.claude\.com|Claude-User|@anthropic|us\.anthropic|CLAUDE_CODE_|\.claude|AnthropicBedrock|AnthropicError|isAnthropic|ToAnthropic|Anthropic native|Anthropic API'
  bun run build && grep -oE '.{30}(Claude Code|OpenClaude).{30}' dist/cli.mjs | grep -viE "$KEEP" | sort -u
  （剩余应为：外部产品语境=已记 review，或禁用功能残留=可由后续处理；不应有"本工具"类未改项。）
- 把本轮改了哪些、跳过哪些（HUMAN_REVIEW_NEEDED 新增条目）简要汇报。

## 红线（别做）
- 不碰 B2 字符串里的裸 Claude、不碰护栏项、不碰 .claude/ 目录、不改功能逻辑、不改测试去迁就。
- 不确定就记 HUMAN_REVIEW_NEEDED，停在那一处，不要自作主张。
```
