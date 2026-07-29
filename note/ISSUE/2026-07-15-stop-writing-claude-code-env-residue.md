# ywcoder 主动写出 CLAUDE_CODE_* 旧名，造成部署环境残留

> **状态**：🔲 计划中 · 待实施
> **标签**：`#品牌迁移缺口` `#环境变量` `#provider` `#去标识`
> **发现日期**：2026-07-15
> **来源**：内网部署机排查 `process.env`，发现 `CLAUDE_CODE_ENTRYPOINT`、`CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` 等旧品牌变量与 `YWCODER_*` 并存
> **优先级**：中（不影响功能，属去标识收尾；`CLAUDE_CODE_ENTRYPOINT` 每次启动必残留）
> **演进自**：2026-06-17「环境变量去标识·双名对称」（[2026-06-12-use-openai-flag-fallback-incomplete.md](2026-06-12-use-openai-flag-fallback-incomplete.md) 已闭合）。上一步刻意做成「`YWCODER_*` 转正 + `CLAUDE_CODE_*` 双写/回退」以保「内网脚本可只用新名」；本步在其基础上进一步**停止写出旧名**。

---

## 问题概述

ywcoder 多处做「同名成对写入」：`process.env.YWCODER_X = process.env.CLAUDE_CODE_X = v`，即每次运行都主动写出一份 `CLAUDE_CODE_*`，这是部署环境旧名残留的来源。

读取端早已通过 `getYwCoderEnv(suffix)`（[src/utils/envUtils.ts:24](../../src/utils/envUtils.ts#L24)）统一「`YWCODER_*` 优先、`CLAUDE_CODE_*` 回退」，故**写入端那一半在进程内已冗余**，可安全去除。

## 范围（已与用户确认）

- **范围 A**：只停止「写出」旧名。**保留** `getYwCoderEnv` 的入站回退（用户仍可用旧名设置）；**不**动约 130 个纯只读入站配置变量（宿主/用户设置、ywcoder 只读、本无 `YWCODER_` 对应名）。
- **三个外向名（ENTRYPOINT / SESSION_ACCESS_TOKEN / SESSION_ID）一并停写旧名**：ywcoder 自读走回退不受影响；它们是 ywcoder 默认设置的内部变量，非第三方约定契约。
- 护栏：不动 `CLAUDECODE=1`（基础品牌标志，另一议题）、`claude-*` 模型名、`ANTHROPIC_*`。

## 前置（已完成）

- [src/services/api/openaiShim.ts:206](../../src/services/api/openaiShim.ts#L206) `isGeminiMode()` 原只直读 `CLAUDE_CODE_USE_GEMINI`（无回退），已补为带 `YWCODER_USE_GEMINI` 回退——这是唯一「绕过 helper 且硬依赖旧名」的读取点，修好后才能安全移除对应写入。

## Phase 1 — 读取端一致性收尾（极小）

1. 把上面 openaiShim 的行内修复改用同文件已有辅助，与 [openaiShim.ts:1356](../../src/services/api/openaiShim.ts#L1356) `isEnvTruthy(getYwCoderEnv('USE_GEMINI'))` 一致。
2. 复核：所有「待停写变量」的读取要么走 `getYwCoderEnv`，要么已带 `?? CLAUDE_CODE_` 回退。已核实 `providerProfiles` 读取端（[providerProfiles.ts:618-622](../../src/utils/providerProfiles.ts#L618-L622)）为双读，安全。此步为验证性，无预期改动。

## Phase 2 — 移除写入端的 CLAUDE_CODE_* 一半

统一模式：`process.env.YWCODER_X = process.env.CLAUDE_CODE_X = v` → `process.env.YWCODER_X = v`。

**启动默认项（`??=` 形式，实施时补发现——截图第二项残留来源）**
- [entrypoints/cli.tsx:56](../../src/entrypoints/cli.tsx#L56)、[entrypoints/mcp.ts:6](../../src/entrypoints/mcp.ts#L6) — `DISABLE_EXPERIMENTAL_BETAS`：`YWCODER_ ??= CLAUDE_CODE_ ??= 'true'` 的第二个 `??=` 会在启动时写出旧名 → 改为 `?? 'true'`（只读入站旧名、不写；默认值不变）。读取端 [betas.ts:218](../../src/utils/betas.ts#L218)、[api.ts:243](../../src/utils/api.ts#L243)、[toolSearch.ts:181](../../src/utils/toolSearch.ts#L181) 均走 `getYwCoderEnv`，安全。

**核心内部变量**
- [main.tsx:529,533,541](../../src/main.tsx#L529-L541) — `ENTRYPOINT`（每次启动必写，残留主因）
- [main.tsx:1010](../../src/main.tsx#L1010)、[entrypoints/cli.tsx:410](../../src/entrypoints/cli.tsx#L410) — `SIMPLE`
- [main.tsx:1112](../../src/main.tsx#L1112) — `AGENT`
- [main.tsx:1137](../../src/main.tsx#L1137) — `TASK_LIST_ID`

**Provider / 模式**
- [utils/providerFlag.ts:89,94,99,104,108,112](../../src/utils/providerFlag.ts#L89-L112) — `USE_OPENAI/GEMINI/GITHUB/BEDROCK/VERTEX`
- [coordinator/coordinatorMode.ts:66](../../src/coordinator/coordinatorMode.ts#L66) — `COORDINATOR_MODE`
- [utils/providerProfiles.ts:403,404,425](../../src/utils/providerProfiles.ts#L403-L425) — `PROVIDER_PROFILE_ENV_APPLIED(_ID)`、`USE_OPENAI`
- [components/ProviderManager.tsx:315](../../src/components/ProviderManager.tsx#L315) — `USE_GITHUB`
- [commands/onboard-github/onboard-github.tsx:88](../../src/commands/onboard-github/onboard-github.tsx#L88) — `USE_GITHUB`

**外向名**
- ENTRYPOINT（见上，已含）
- [utils/sessionIngressAuth.ts:140](../../src/utils/sessionIngressAuth.ts#L140) — `SESSION_ACCESS_TOKEN`（REPL bridge 在本进程 process.env 注入刷新 token；仅 bridge/remote 触发）

**明确不改：`SESSION_ID`**（[Shell.ts:326](../../src/utils/Shell.ts#L326)、[conversation.ts:205-206](../../src/commands/clear/conversation.ts#L205-L206)）——`USER_TYPE === 'ant'` 守卫，是 Anthropic 内部会话关联标记（子进程面包屑，消费者在 ant 外部基础设施，仓库内无读取方）。对内网 `USER_TYPE !== 'ant'` 是死分支、从不写出、零残留；改名唯一影响是「ant 环境下外层 harness 注入 `CLAUDE_CODE_SESSION_ID` 时 /clear 守卫失效」。按「精准修改」原则，对内网零收益、非必碰，保持原样。

## 本次不做（review 补发现·bridge/sandbox 子进程 env 去标识，后续单独任务）

以下站点把 `CLAUDE_CODE_*` **单独写入子进程 env 对象**（非 ywcoder 自身 process.env），是一个自洽子系统，本次不动、另行研究：
- [bridge/sessionRunner.ts:34-40,69-77](../../src/bridge/sessionRunner.ts#L34-L77) `buildChildEnv`：白名单 + override 整块统一 `CLAUDE_CODE_`（`ENVIRONMENT_KIND`/`FORCE_SANDBOX`/`BUBBLEWRAP`/`ENTRYPOINT`/`COORDINATOR_MODE`/`PERMISSIONS_VERSION`/`PERMISSIONS_SETTING`/`SESSION_ACCESS_TOKEN`/`WORKER_EPOCH`）。**须整块 + 白名单一起迁移**，且 `FORCE_SANDBOX`、`PERMISSIONS_VERSION/SETTING` 全库无 `getYwCoderEnv` 读取端，盲目改名有破坏 sandbox/权限风险——需先确认其读取契约。
- [utils/shell/bashProvider.ts:242](../../src/utils/shell/bashProvider.ts#L242)、[utils/shell/powershellProvider.ts:118](../../src/utils/shell/powershellProvider.ts#L118) — `CLAUDE_CODE_TMPDIR` 写入 shell 子进程 env（读取端走 `getYwCoderEnv('TMPDIR')`，可安全改，但归入同一子任务统一处理）。

> 说明：初版实现曾误将 `sessionRunner.ts:587`（bridge 刷新 token）单独改为新名，造成该块半迁移 + child 残留陈旧 token 副本，review 时已回退，纳入本节整体任务。

## 明确保留 / 不动（避免误删）

- **保留** `getYwCoderEnv` 的 `?? CLAUDE_CODE_` 入站回退（[envUtils.ts:24](../../src/utils/envUtils.ts#L24)）。
- **保留**所有清理/删除旧名的语句（如 [coordinatorMode.ts:69](../../src/coordinator/coordinatorMode.ts#L69) `delete CLAUDE_CODE_COORDINATOR_MODE`、ProviderManager / onboard-github 里把 `CLAUDE_CODE_USE_*` 设 `undefined`、`clearProviderProfileEnvFromProcessEnv` 的 delete）——停写后它们变成清理「用户入站旧名」的良性卫生代码。
- **不动**子进程白名单里 `CLAUDE_CODE_USE_*` 条目（[spawnUtils.ts:100-112](../../src/utils/swarm/spawnUtils.ts#L100-L112)、[managedEnvConstants.ts](../../src/utils/managedEnvConstants.ts#L19-L27)）——停写后取不到值即失效，保留无害；是否精简列为后续可选。

## 测试

- 现有 `*.test.ts` 中大量 `YWCODER_X = CLAUDE_CODE_X = '1'` 成对赋值属 fixture，读取走回退，不因本次失效，无需强制更新。
- 建议（可选）将关键 provider 测试改为「只设 `YWCODER_*`」以锁定回归：`providerValidation.test.ts`、`apiPreconnect.test.ts`、`domainCheck.test.ts`。

## 验证

1. `bun run build` 编译通过。
2. `bun test src/tools/WebFetchTool/domainCheck.test.ts src/utils/providerValidation.test.ts src/utils/apiPreconnect.test.ts src/utils/providerProfiles.test.ts` 全绿。
3. 残留消除：构建后启动，检查进程环境只剩新名：
   `YWCODER_USE_OPENAI=1 node dist/cli.mjs -p "printenv | grep -E 'CLAUDE_CODE_|YWCODER_' | sort"` —— 预期不再出现 `CLAUDE_CODE_ENTRYPOINT` / `CLAUDE_CODE_USE_OPENAI`。
4. 回退仍生效：仅设 `CLAUDE_CODE_USE_GEMINI=1` 启动，`getAPIProvider()` 仍解析为 `gemini`。
5. `bun run smoke` 通过。

---

## 附：同日排查的关联残留 —— `~/.claude/debug` 持续被写（非本仓库缺口）

> **发现日期**：2026-07-15 · 同一台内网/离线机
> **结论**：**不是 ywcoder 本体的品牌迁移缺口**，无需在本仓库修复；根因在**外部 web 封装程序自带的旧 `cli.mjs`**。记录于此仅为闭环留痕，避免后续误当成 ywcoder 残留重复排查。

### 现象

离线机 `~/.claude/debug` 又出现活跃更新（36 个文件，07-03 19:29 → 07-15 14:00，含 `latest`），而迁移后应写入的 `~/.ywcoder/debug` 只有 07-03 21:00 的 2 个文件、之后再没动过。用户此前已认为「debug 已迁到 `.ywcoder`」，故怀疑迁移失效。

### 排查与证据（已逐条验证）

1. **当前源码/构建正确**：`getDebugLogPath()`（[src/utils/debug.ts:230](../../src/utils/debug.ts#L230)）默认走 `getYwCoderConfigHomeDir()`（[src/utils/envUtils.ts:30](../../src/utils/envUtils.ts#L30)），`.claude` 回退已在 commit `7d8e0b1`（2026-07-03「取消 ~/.claude 目录和配置文件回退机制」）移除；`dist/cli.mjs` 内配置目录字面量全为 `.ywcoder`，无硬编码 `.claude/debug`。
2. **排除环境变量**：离线机 `CLAUDE_CONFIG_DIR` / `YWCODER_CONFIG_DIR` / `CLAUDE_CODE_DEBUG_LOGS_DIR` 全空，shell 配置与 ywcoder 二进制内亦无相关 export。
3. **离线机 ywcoder 为迁移后版本**：`1.2.3-dev.20c7c01 (build #32, 2026-07-14)`，晚于 07-03 修复 —— ywcoder 本体只会写 `~/.ywcoder/debug`。
4. **日志内容指向外部 SDK**：`latest` 内容为 `[Query.streamInput] ...`、`[Query] Calling transport.endInput() to close stdin to CLI process`、`Processing message N: user`。这些字符串在 ywcoder 的 `src/`、`node_modules/`、`dist/cli.mjs`（`grep -c` = 0）中**均不存在**，属参照 claude-code SDK 的「编排层驱动子 CLI」日志。
5. **无独立进程/无 claude 二进制**：`lsof +D ~/.claude/debug` 无进程持有句柄（追加即关闭）；`ps` 仅见 ywcoder 自身 BashTool 子进程（路径在 `~/.ywcoder/shell-snapshots/`，因 `/tmp/claude-*-cwd` 临时名被 grep 命中）；`which claude` 为空。

### 根因（两层进程模型）

用户在一个 web 程序里参照 claude-code SDK 做了封装，运行时是**「一个封装层指挥、一个 ywcoder 干活」**：

- **编排层（父）= web 程序打包自带的旧 `cli.mjs`**（07-03 之前构建）：负责对接前端、管会话、喂输入/关 stdin、收流式结果。它的 debug 路径在旧代码里仍解析为 `~/.claude/debug` → **即 `[Query.*]` 日志与那 36 个文件的来源**。
- **执行层（子）= 本机新版 ywcoder CLI**（build #32）：被父层拉起真正跑模型/执行工具 → 正确写 `~/.ywcoder/debug`、`~/.ywcoder/shell-snapshots`。

web 封装的「优先用本机 CLI、找不到才用自带 SDK」策略**只作用于执行层（换子引擎）**；编排层始终是自带的旧 bundle，故即便本机装了迁移后新版，父层仍写 `.claude`。这与「用新 CLI 就应全写 `.ywcoder`」的预期相悖，但**属外部程序的分层设计，非 ywcoder 仓库问题**。

### 处理（在 web 程序侧，本仓库不改动）

- **推荐**：web 程序把打包自带的旧 `cli.mjs` 更新为 07-03 之后的构建（或改为直接调用本机 `/usr/local/bin/ywcoder`，不再自带旧副本），使编排层也走 `.ywcoder`。
- **临时止血**：给 web 程序进程注入 `CLAUDE_CONFIG_DIR=$HOME/.ywcoder`（旧版亦认此变量）。
- 更新后验证：多次运行后 `~/.claude/debug` 不再新增、`~/.ywcoder/debug` 开始出新文件；并确保 web 侧 `cli.mjs` 与本机 `ywcoder` 版本尽量同一大版本，避免编排层与执行层协议错配。
