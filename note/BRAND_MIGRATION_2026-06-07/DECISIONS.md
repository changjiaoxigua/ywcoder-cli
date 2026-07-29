# 品牌改造 · 决策记录（D1–D6）

**定稿日期**: 2026-06-07
**原则**: 不删代码（可一行回滚）；wire/协议层不动；用户感知不到 Claude/Anthropic/OpenClaude。

---

## D5 — Anthropic 云/账号功能 → **完全隐藏 + 文档标注**

**决策**: 内网不提供这些服务，**一律禁用并完全隐藏**（命令/入口直接消失，零足迹）。逐条记入 `DISABLED_FEATURES.md`，注明"将来接 YwCoder 服务可重启用"。

**禁用方法（复用仓库现有机制，按优先级）**:
1. **构建期 feature flag** — [scripts/build.ts](../../scripts/build.ts) `feature(name) ?? false`，未列出的 flag 默认 false。多数云功能（CCR/web、KAIROS channels、SSH_REMOTE、TRANSCRIPT_CLASSIFIER、WEB_BROWSER_TOOL、BRIDGE_MODE、DAEMON…）**已经是关的**，只需核实入口确被 `feature('X')` 守住。⚠️ `BUDDY: true` 若属云功能需翻 false。
2. **Slash 命令 `isEnabled: () => false`** — 同 [stickers/index.ts:9](../../src/commands/stickers/index.ts)。用于 passes、cost、buddy、feedback、desktop、thinkback、chrome、insights、teleport 等。
3. **CLI 子命令 / UI 流程入口守卫** — main.tsx 的 `auth login/logout`、`install`、`server`、`add-from-claude-desktop`、`open`，以及 ConsoleOAuthFlow、Teleport*、TranscriptSharePrompt、DesktopUpsell：注册处/触发处 early-return 或跳过。

**待禁用清单（草稿，执行时逐条核对并补全）**:
| 功能 | 类型 | 禁用方式 |
|------|------|---------|
| ultraplan / thinkback / review web | CCR 云 | flag + isEnabled |
| remote-setup / teleport | CCR 云 | flag + isEnabled |
| passes / cost / stickers✓ | Anthropic 订阅 | isEnabled false |
| buddy | 待确认 | flag BUDDY→false? |
| feedback / desktop / chrome | Anthropic 专有 | isEnabled false |
| auth login/logout / ConsoleOAuthFlow | Anthropic 账号 | 守卫/不注册 |
| install（下载上游 CC）/ add-from-claude-desktop | 外部 | 不注册 |
| TranscriptSharePrompt / DesktopUpsell / ChannelsNotice | 数据回传/升级 | 触发条件设 false |
| WorkflowMultiselect / install-github-app | anthropics action | isEnabled false |

---

## D4 — 保留项处置

### D4-a 模型显示名 → **不造 YwCoder 名；移除内网可达的硬编码 Anthropic 列表**
- `ant` 目录已空:[antModels.ts:44-48](../../src/utils/model/antModels.ts) `getAntModels()` 在 `USER_TYPE !== 'ant'` 时 `return []`，非 ant 用户看不到 ant 模型。
- ⚠️ **但发现另一条可达的硬编码路径**:[modelOptions.ts](../../src/utils/model/modelOptions.ts) 的 `payg3pOptions` 兜底（原 487/498/508 等行）会在 openai/codex provider 落到 fallthrough 且用户未配自定义映射时，硬塞 Sonnet 4.6 / Opus 4.1 / Opus 4.6 / Haiku → `/model` 会出现 claude-*。
- ✅ **已修复（本次）**:注释掉 payg3p 的硬编码 Anthropic 兜底,仅保留 `getCustomSonnetOption/Opus/Haiku`（用户用 `ANTHROPIC_DEFAULT_{SONNET,OPUS,HAIKU}_MODEL` 把网关模型映射到对应槽位）。build+test 全绿。
- 其余 `claude-*` 引用（[modelOptions.ts:527-549](../../src/utils/model/modelOptions.ts) 能力判断、[model.ts:293](../../src/utils/model/model.ts) Bedrock 归一化、migrations、betas、attribution fallback）= **wire 层功能逻辑，保留**。
- 🔶 **仍待 D5 一并处理的休眠路径**（firstParty/订阅，内网无 Anthropic 认证不会触发，但为彻底应在禁用 firstParty 入口时连带处理）:
  - `standardOptions`（Max 订阅，约 [modelOptions.ts:404-442](../../src/utils/model/modelOptions.ts)）
  - `payg1POptions`（`getAPIProvider()==='firstParty'`，约 [modelOptions.ts:457-471](../../src/utils/model/modelOptions.ts)）
  - [modelOptions.ts:88](../../src/utils/model/modelOptions.ts) `getClaudeAiUserDefaultModelDescription`（claude.ai 默认描述）
- **净结论:不造 YwCoder 模型名;改动 = 移除 payg3p 硬编码兜底（已完成）+ 休眠 firstParty 列表随 D5 收尾。**

### D4-b CLAUDE.md → **YWCODER.md 主 + CLAUDE.md 永久只读兜底** ✅ 功能已完成
> 实现：[claudemd.ts](../../src/utils/claudemd.ts) 新增 `processMemoryFileWithFallback`（YWCODER.md 优先、CLAUDE.md 缺失回退），覆盖 8 处发现点 + `isMemoryFilePath`；[config.ts](../../src/utils/config.ts) `getMemoryPath` 经 `resolveMemoryFilePath`（已存在 YWCODER.md > 已存在 CLAUDE.md > 新建 YWCODER.md）；init 生成、projectOnboardingState、MemoryFileSelector、FileWriteTool 日志均已适配；本仓库 CLAUDE.md 已 `git mv` 为 YWCODER.md。功能经实测：同目录同时存在两文件时模型读到 YWCODER.md 内容。build + 562 test 全绿。
> 剩余 ~90 处 CLAUDE.md 为**注释/系统提示文本**，规则=改 YWCODER.md（claudemd.ts/config.ts 内的 fallback 名除外），已并入长尾交小模型。

- **写/生成/文案** 一律 `YWCODER.md`（含 `YWCODER.local.md`）。
- **读取发现** 额外认 `CLAUDE.md`（不存在 YWCODER.md 时回退），**永久保留、不删**——兼容存量项目与生态。
- 本仓库自身 `CLAUDE.md` 直接改名为 `YWCODER.md`。
- 落点:读取集中在 [utils/claudemd.ts](../../src/utils/claudemd.ts)（~6 处）+ [config.ts](../../src/utils/config.ts)（3 处）+ 组件；改成数组 `['YWCODER.md','CLAUDE.md']` 顺序查找。文本引用 164 行随品牌扫一并改。

### D4-c ANTHROPIC_* 环境变量 → **保持不动**
- 结论:`ANTHROPIC_*` 是**按协议命名的 provider 选择器**，与 `OPENAI_*`/`GEMINI_*` 同类，归入保留清单。**不重命名、不加 YWCODER_API_KEY、不做回退。**
- 内网走 OpenAI 格式网关（`OPENAI_BASE_URL`），Anthropic 路径休眠;将来若上 anthropic 协议网关，直接用 `ANTHROPIC_BASE_URL/API_KEY` 表示"启用 anthropic 协议"（就像 openai 那样）。
- 唯一动作:软化极少数把 `ANTHROPIC_API_KEY` 当"本工具身份"写的**用户可见文案**（`--bare` 帮助 [main.tsx:970](../../src/main.tsx)、status 提示 [statusNoticeDefinitions.tsx:130](../../src/utils/statusNoticeDefinitions.tsx)），使其读作"众多 provider 之一"。优先级低。
- 第三方 provider 变量（`OPENAI_*`/`GEMINI_*`/`GITHUB_TOKEN`…）**全部保留**。

---

## D1/D2/D3/D6 — ✅ 已议定并执行（2026-06-08）；D7 — ✅ 已完成·默认开启（2026-06-12）

| 编号 | 事项 | 决定 / 状态 |
|---|---|---|
| **D1** | OTel 指标名 `claude_code.*` | ✅ **已改 `ywcoder.*`**（内网无监控、无测试断言、无导出端点，零风险；将来搭监控直接用新名）。bootstrap/state.ts 8 个 counter + sessionTracing.ts span/tracer 名 |
| **D2** | `anthropics/` 官方插件市场 / `claude-code-action` | ✅ **官方市场 auto-install 已禁用**（`isOfficialMarketplaceAutoInstallDisabled()` 恒 true，内网不可达本就会失败）。功能性链接保留，将来接内网插件市场时恢复。install-github-app（claude-code-action）此前 D5 已处理 |
| **D3** | proto 包名 `openclaude.v1` → `ywcoder.v1` | ✅ **已改**（内网用 gRPC）。proto 文件 `openclaude.proto`→`ywcoder.proto`、`package ywcoder.v1`、server.ts + grpc-cli.ts 同步；实测 proto-loader 加载 `ywcoder.v1.AgentService` 成功 |
| **D6** | 对外 URL/标识 | ✅ **已改**：`MACRO.ISSUES_EXPLAINER`→中性「report the issue to your YwCoder administrator」；`originator:'openclaude'`→`'ywcoder'`（WebSearch + codexUsage）；UA 支持 URL `Gitlawb/openclaude`→`dcywzc/ywcoder`（按 npm scope 推断，若仓库不同可调）。**保留 `Claude-User` UA**（robots.txt 匹配，功能性）。反馈残留：feedback 命令已 D5 禁用，链接随之失效 |

### D7 — ✅ 已完成并默认开启（2026-06-12 更新）

> **执行结果**：D7 全部落地——Phase 0（路径收敛）→ Stage 1a/1b/1c（helper + flag 门控）→ Stage 1b-2（非-join 补漏）→ Stage 2（迁移模块 + 启动接入）→ Stage 3a/3b（全局 auth 文件 `getGlobalClaudeFile` 三分支 + HOME 显示串）→ 路径插值补修 + code-review 6 项修复,均已提交。版本号升至 **v1.2.0**。
>
> **⚠️ 决策变更：`MIGRATE_PROJECT_CONFIG` 默认值 OFF → ON（2026-06-12）。** 原决策（下方 2026-06-09）定为「默认 OFF,仅内网发布构建 ON」,理由是怕打断外网 CC + ywcoder 并用。复盘后改为**默认 ON**：
> - copy-keep 策略下 `.claude/` **始终保留**,外网 Claude Code 读 `.claude/` 不受影响;迁移副作用仅为生成 `.ywcoder/` 目录 + 往 `.gitignore` **追加**并行规则（不删原规则）,可接受。
> - 默认 ON **简化发布**（避免漏带 flag 打出 OFF 包;`npm pack` 的 prepack 自然产出 ON 包）并**方便测试** `.ywcoder` 生效。
> - **保留退路**：`MIGRATE_PROJECT_CONFIG=false bun run build` 仍可关（迁移分支 DCE）,供需与官方 CC 纯共用 `.claude/` 的场景。
> - 代价：外网纯用 CC 的开发者项目里会多出 `.ywcoder/` 目录 + 几行 gitignore;团队判断可接受。
>
> 详见 [REMAINING_WORK.md](REMAINING_WORK.md) 2026-06-12 更新。**下方 2026-06-08/09 的「暂缓」「默认 OFF」内容为历史决策记录,保留以追溯设计演进。**

---

### D7 — 项目级 `.claude/` 目录迁移 → **暂不动,先记录**（2026-06-08 决定,已被上方 2026-06-12 执行结果取代）
- **现状**:`~/.claude` 主配置目录已迁 `~/.ywcoder`（含 fallback）；`CLAUDE.md` 文件名已 D4-b 迁 `YWCODER.md`。但**项目级 `.claude/` 目录未迁移**，src 中 **253 处**硬编码 `join(getCwd(), '.claude', ...)`，无中心 getter。
- **涉及子系统**:
  - 用户可见/会创建：`.claude/rules/*.md`、`.claude/settings.json`、`.claude/agents/`、`.claude/commands/`
  - 内部状态：`.claude/agent-memory/`、`.claude/worktrees/`、`.claude/scheduled_tasks.*`、`.claude/ide/`
- **若将来迁移**：需 `.ywcoder/` 优先 + `.claude/` 回退（兼容存量项目），风险高（碰设置发现/agent 记忆/worktree/hooks），建议先抽中心 getter 再改，并充分测试。作为后续独立大批次。
- **本批不处理。**

**追加（2026-06-09，Phase C 运行时核查发现）：全局配置文件 `~/.claude.json` 并入 D7 暂缓。**
- **发现**：`getGlobalClaudeFile()`（[env.ts:14](../../src/utils/env.ts)）逻辑为「`~/.ywcoder/.config.json` 存在则用它，否则用 `~/.claude{oauth后缀}.json`」。但 `~/.ywcoder/.config.json` 仅由「迁移已有 `~/.claude.json`」产生；**新装用户无源文件 → 迁移跳过 → 全局配置（含 auth token）落 `~/.claude.json`**。隔离 HOME 实跑已验证：干净环境生成 `~/.claude.json`，无 `~/.ywcoder/.config.json`。
- **为何暂缓**：与 `.claude/` 目录同类——品牌命名的配置位置、**auth 关键路径**（OAuth 文件名后缀、`CLAUDE_CONFIG_DIR` 环境变量兼容、GH#3117「拒写以防抹掉 ~/.claude.json」保护）。单独动风险高。
- **将来连同 D7 一起做**：把 env.ts:14 的 else 默认指向 `~/.ywcoder/.config.json`（新装直接落此），`~/.claude.json` 降为只读兜底；必须连登录/认证流程一起测。
- **当前决定（用户 2026-06-09）：并入 D7，本阶段不动。**

---

### D7 方案 + 影响分析（2026-06-09 制定，供将来执行）

**范围（实测）**：项目级 `.claude/` 硬编码 **392 处**（无中心 getter，全散落）+ `~/.claude.json` 全局配置。HOME 配置目录已有 `getYwCoderConfigHomeDir()`→`~/.ywcoder`（已迁，不在 D7）。

**按"暴露面/交互对象"分三类（决定难易与风险）**：
| 类 | 子系统（命中数） | 谁读写 | 迁移风险 |
|---|---|---|---|
| 🔴 生态共享（用户签入 repo / 团队 / 跨工具） | settings(90)、rules(22)、skills(21)、plugins(24)、agents(10)、commands(7) | 用户 + 团队 + 其它工具 | 高：存量项目 `.claude/` 配置需回退读；改写位置影响 interop |
| 🟡 纯内部运行时状态 | scheduled(20)、agent-memory(13)、worktrees(10)、ide(1)、debug、`.update.lock` | 仅本工具 | 中：只是搬内部状态 + 回退 |
| 🟢 硬护栏（不改） | `.claude-plugin/`（plugin.json/marketplace.json 清单目录） | 插件生态标准 | — 同 `anthropics/`，保留 |

**核心张力（为何难、为何缓）**：`.claude/` 不只是品牌串，是**生态约定**——三方读写：用户（签入 `.claude/settings.json`、`.claude/rules/`）、团队（共享签入配置）、其它工具（官方 Claude Code、插件）。改成 `.ywcoder/` = 分叉约定。
> **关键判断**：内网是**纯 YwCoder 环境**（不混用官方 CC），所以"团队/跨工具 interop"顾虑**大半消失**；剩下的主要是"迁移存量项目里已有的 `.claude/` 配置"（回退读即可兜底）。这让全量迁移（下方 Option B）在内网场景比通用场景**可行得多**。

**执行方案（分阶段）**：
- **Phase 0｜抽中心 getter（前置，纯重构零行为变更）**：把 392 处 `join(cwd, '.claude', …)` 收敛到 `getProjectClaudeDir()` / 各子系统 path helper。改完 build+test 应完全等价。**这是后续一切的前提。**
- **Phase 1｜读回退**：getter 返回 `.ywcoder/`（存在则用）否则 `.claude/`——镜像 `getGlobalClaudeFile()` / `YWCODER.md` 兜底模式。
- **Phase 2｜写策略（✅ 已定 2026-06-09：Option B）**：
  - Option A（保 interop）：仍**写** `.claude/`，只加 `.ywcoder/` 读回退 → 改动最小，但 `.claude/` 品牌目录仍生成，去标识不彻底。
  - **✅ Option B（全量迁移）【用户选定】**：**写** `.ywcoder/`，`.claude/` 仅读回退 + 一次性迁移存量 → 去标识到位。理由：纯内网部署，不与官方 Claude Code 同时使用，无 interop 顾虑。
  - Option C：默认 `.claude/`，env/config 开关切 `.ywcoder/`。

  **B 的执行细则（2026-06-09 锁定）**：
  - **⚠️ 双场景 + 编译期开关 `MIGRATE_PROJECT_CONFIG`（2026-06-09 追加，关键约束）**：开发者本人外网用 **Claude Code 开发 ywcoder、又用 ywcoder 测试**，存在同一项目 CC + ywcoder 并用；若无条件搬 `.claude/`→`.ywcoder/` 会打断 CC（它只认 `.claude/`）。故整个 `.ywcoder` 行为（helper 的 active-dir + 迁移）必须**受编译期 flag 门控**（仿 `scripts/build.ts` 的 `feature('BRIDGE_MODE')` 同款 DCE 机制）：
    - **默认 OFF（dev 构建）**：`getProjectConfigDir` 恒返回 `.claude`、迁移代码被 DCE 删除 → 行为=原版，与 CC 完全共用 `.claude/`，零干扰。
    - **ON（内网发布构建）**：由发布流水线（构建 env / 专用 channel）设 true → helper 走 active-dir、迁移启用。
    - **零运行时表面**：不加 CLI flag / config 选项 / `/doctor` 输出 / 运行时 env 读取；用户无处可见或切换，迁移安静执行（debug 日志）+ 先备份。底线：逆向 bundle 才可见 flag 名（与所有编译逻辑同，无法规避）。
    - **⚠️ 实现欠账**：Stage 1a/1b 已落地的 helper 是**无条件 active-dir**（未读 flag）。Stage 2 前需先把 helper 改成**读 `feature('MIGRATE_PROJECT_CONFIG')`**（OFF→恒 `.claude`），否则 dev 构建跑 ywcoder 也会对全新项目建 `.ywcoder/`，破坏与 CC 的一致。
  - **整目录搬**（用户决定，仅在 flag ON 时）：启动早期一次性把项目 `.claude/` → `.ywcoder/`。worktree 功能未对内网用户宣传、用者极少，故接受其风险走整搬——**但保留一行天窗：跳过 `worktrees/` 不搬**（git worktree 路径已注册进 .git，盲搬会断链损坏；跳过近乎零成本）。
  - **同步 `.gitignore`**（用户确认）：迁移时把项目 `.gitignore` 里 `.claude/` 规则一并改 `.ywcoder/`，防 `settings.local.json`/密钥等本被忽略文件失配后被误提交。
  - **迁移机制**：configMigration 同款——每项目跑一次、幂等（`.ywcoder/` 已存在则跳过）、先备份、启动早期（settings 加载前）、只读/无权限优雅降级（暂留 `.claude/`，读回退继续用）。
  - **getter 必须分读/写**（实现修正）：写恒 `.ywcoder/`（否则全新项目回退又建 `.claude/`）；读 `.ywcoder/` 优先回退 `.claude/`、都无默认 `.ywcoder/`；匹配/权限场景认两边。已落 `src/utils/projectConfigDir.ts` 的 getProjectConfig{Write,Read}Dir / getProjectConfigDirVariants（Stage 1a，含单测）。
  - **执行分段（进度更新 2026-06-09）**：
    - Phase 0 ✅（40ba06b）：392 处 `join(base,'.claude',…)` 收敛到 `getProjectConfigDir`（当时名 getProjectClaudeDir），零行为变更。
    - Stage 1a ✅（41266c7）：`projectConfigDir.ts` 增 helper——`getProjectConfigDir`（active：.ywcoder 优先→回退 .claude→默认 .ywcoder，读写共用）、`getProjectConfigWriteDir`（强制 .ywcoder，留给迁移目标）、`getProjectConfigDirVariants`（[.ywcoder,.claude] 供匹配认两边）+ 单测。
    - Stage 1b ✅（de56312）：35 站点按读/写→active-dir、匹配/权限→variants 切换完毕（agentMemory/filesystem 安全敏感已认两边）；退役 getProjectClaudeDir。**当前行为**：新项目写 .ywcoder/、旧 .claude/ 仍读、权限认两边；存量项目在"搬"之前仍整体用 .claude/。
    - **👉 Stage 1c（下一步先做，未做）**：给 `projectConfigDir.ts` 的 helper 加 `feature('MIGRATE_PROJECT_CONFIG')` 门控——OFF 时 `getProjectConfigDir`/`getProjectConfigWriteDir` 恒返回 `.claude`（=原版行为，dev/CC 共用）；ON 时才走现有 active-dir/`.ywcoder` 逻辑。`getProjectConfigDirVariants` 可保持恒返回两边（认两边无害）。在 `scripts/build.ts` featureFlags 加 `MIGRATE_PROJECT_CONFIG`（默认 false，内网发布构建经构建 env 设 true）。补单测（flag on/off 两种）。
    - **👉 Stage 1b-2（下一步，未做）补漏**：Stage 1b 只改了 `join(base,'.claude',…)` 构造点，漏了一整类**非-join `.claude` 硬编码**（endsWith/includes/数组/pattern/相对 join('.claude',…)/双引号/prompt/显示串）。独立评审（temp/REVIEW_REPORT_2026-06-09.md）+ 主线复扫已整理成 **[STAGE_1B2_PUNCHLIST.md](archive/STAGE_1B2_PUNCHLIST.md)**。含 🔴 P0 安全/核心（**最关键 settings.ts:303 项目 settings 路径完全没走 getter**、sandbox-adapter 沙箱保护、DANGEROUS_DIRECTORIES、isClaudeSettingsPath、CLAUDE_FOLDER_PERMISSION_PATTERN、isMemoryFilePath、cron 文件路径、Doctor.tsx 等）。修法=认两边。**内网 `.ywcoder` 构建上线前必修齐 P0。** ⚠️ Phase 0 grep 有盲点（漏单引号外/相对 join/双引号），下一轮要全量重扫。
    - **👉 Stage 2（未做）**：项目级迁移模块——**整段受 `feature('MIGRATE_PROJECT_CONFIG')` 门控**（OFF 时 DCE 删除）；启动早期把存量 `.claude/`→`.ywcoder/`（跳 worktrees 天窗 + 同步 .gitignore + 备份 + 幂等 + 优雅降级），接进启动流程 settings 加载之前。**会改用户 repo，最危险。**
    - Stage 3：`~/.claude.json`（env.ts:14 else 默认改 ~/.ywcoder/.config.json + .claude.json 只读回退，auth 敏感连登录测）。
    - Stage 4：重测（settings 发现/权限/hooks/agent-memory/worktree/登录）。
- **Phase 3｜`~/.claude.json`**：env.ts:14 else 默认改指 `~/.ywcoder/.config.json`，`.claude.json` 降只读回退。**auth 敏感**，连登录流程测。
- **Phase 4｜重测**：settings 发现/权限/hooks、agent-memory、worktrees、scheduled、登录认证、插件、团队签入场景。

**风险点**：① settings 发现(90)是启动关键路径（驱动权限/hooks），最高危；② `~/.claude.json` 动 auth 有 token 丢失风险；③ 存量项目 `.claude/` 配置若回退没兜全→配置"丢失"观感；④ `.claude-plugin/` 必须保留。

**建议执行顺序**（若启动）：先 Phase 0（重构+测，零风险）→ 🟡 内部状态子系统全量迁（低 interop 风险、真去标识）→ 🔴 生态共享子系统按 Option B（内网）做读回退+写 `.ywcoder/`→ Phase 3 `~/.claude.json`→ Phase 4 重测。每阶段独立可提交、可回滚。
