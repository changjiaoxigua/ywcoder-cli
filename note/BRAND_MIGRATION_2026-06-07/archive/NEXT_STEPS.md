# 下一步执行计划（2026-06-08 定稿）

> 决策面已全清（D1–D6 完成、D7 暂缓）。剩余均为机械执行 + 交付。
> **核心判据（实测打包产物得出）**：暴露面是**字符串字面量**，不是"UI vs 内部"。
> - 🔴 字符串字面量 → 进 dist/cli.mjs、发往 LLM 网关、可能进日志 → **必扫**
> - 🟢 注释 → 被 build 剥离，不进 bundle、不传后端 → **可缓**
> - 🟡 含 Claude 的符号名 → CI minify 混淆局部、导出名残留 → 中等

---

## Phase A — 批次2 guide agent ✅ 已完成（commit 15b899e）
禁用并 tree-shaking 移出打包产物；dist 中 `claude-code-guide` / `Claude Agent SDK` / `formerly the Anthropic API` 均归零。

## Phase B — 长尾字符串 sweep（交小模型 / process_brand_worklist.ts）

当前残留（src 非测试，排除 keep-list）：`Claude Code` 90、裸 `Claude` 616、`OpenClaude` 2、`CLAUDE.md`→YWCODER 文本 99。

### B1 — 低风险（先做）
- 目标：`Claude Code`(90)、`OpenClaude`(2)、`CLAUDE.md/CLAUDE.local.md`→`YWCODER.md/YWCODER.local.md`(99) 的**字符串与文本**。
- 规则成熟（见 HANDOFF_SMALL_AGENT.md，已更新 CLAUDE.md 迁移规则）。
- 步骤：①**重生成 worklist**（旧的在 D4-b/D5 前生成已过期）②跑 `scripts/process_brand_worklist.ts` ③人工抽查 HUMAN_REVIEW_NEEDED.md ④build+test。

### B2 — 裸 `Claude`（616，高风险，精细护栏）
- **优先级排序**（按暴露面）：
  1. 🔴 日志字符串（`console.*` / logger / debug）含 "Claude"
  2. 🔴 系统/Agent 提示字符串（发往网关，后端可见）
  3. 🔴 UI / 错误信息字符串
  4. 🟢 纯注释里的裸 Claude（不进 bundle，最后做或不做）
- **护栏（必须留，不改）**：事实性 Anthropic 公司引用、`claude-*` 模型名、keep-list（`Claude-User` UA、`.claude/`、`ANTHROPIC_*`、`anthropics/`、`claude.ai`、`code.claude.com`）、含 Claude 的功能性符号名（除非确认安全）。
- **判据**：句中 "Claude" 能否换成"YwCoder/本工具"而语义正确？能→改；指 Anthropic 公司/模型/外部产品→留。
- 建议：先只过**字符串字面量**（1–3 类），注释（4）单独低优先批次。

## Phase C — 回归守卫 + 终审（我做）
1. **扫打包产物**（比扫源码更准——这是真实暴露面）：
   ```bash
   bun run build
   grep -oE '.{0,15}(Claude|Anthropic|OpenClaude).{0,15}' dist/cli.mjs \
     | grep -viE 'claude-[0-9a-z]|ANTHROPIC_|anthropics/|claude\.ai|code\.claude\.com|Claude-User|McpClaudeAIProxy|ClaudeConfigDir' \
     | sort | uniq -c | sort -rn
   ```
   逐条确认剩余的都是 keep-list / 符号名。
2. 可选：把该 dist grep 加进 CI（`security:pr-scan` 或新脚本），防回流。
3. 全分支独立复核（general-purpose reviewer 或 `/code-review ultra`）。

## Phase D — 交付（按 workflow 约定）
feature 分支收尾 → **CI 打包（.tgz）→ 内网测试通过 → 合并 main**。

---

## 建议执行顺序
**B1（低风险，快）→ Phase C 扫 dist（看 B2 到底还剩多少真暴露）→ B2（按 dist 暴露清单精准打击，而非盲扫 616）→ 终审 → 交付。**

> 关键优化：Phase C 的 **dist 扫描**应在 B2 **之前**先跑一次——很多裸 Claude 在注释里（不进 dist），真正需要改的字符串可能远少于 616。先看 dist 暴露清单，再精准改，避免在注释上浪费精力 + 误伤。
