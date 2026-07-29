# [已完成] CLAUDE_CODE_USE_OPENAI 的 YWCODER_* fallback 不完整

> **状态**：✅ 已完成（2026-06-17，随 GitHub 环境变量去标识一并修复）
>
> **修复**：provider profile 子系统的 `hasProviderSelectionFlags` / `hasConflictingProviderFlagsForProfile` / `isProcessEnvAlignedWithProfile`（`providerProfiles.ts`）与 `hasExplicitProviderSelection`（`providerProfile.ts`）已改为就地 dual-read `env.YWCODER_USE_X ?? env.CLAUDE_CODE_USE_X`（6 个 provider flag），保留显式 `env` 注入；`hasExplicitProviderSelection` 的 `*_PROVIDER_PROFILE_ENV_APPLIED` 单读也补成双读。新增「仅设新名」回归测试（`providerProfiles.test.ts`）。内网脚本现可去除 `CLAUDE_CODE_USE_OPENAI` / `CLAUDE_CODE_USE_GITHUB`，仅用 `YWCODER_USE_*`。
>
> **补充（2026-06-17 复审）**：除 profile 子系统外，`providerValidation`（provider 选择判定 + 三处报错文案）与 `provider.tsx` 的 gemini/openai/github 显示读也已 dual-read/改新名；各写入/清除站点（onboard-github、ProviderManager、`buildLaunchEnv`）补齐双名对称，避免 dual-read 下残留旧 provider 的新名标志。至此 USE_OPENAI 全链路 fallback 完整。
>
> ---
>
> **以下为原始记录（保留备查）**
>
> **状态**：🔲 未完成 · 待单独研究
> **标签**：`#待研究` `#品牌迁移缺口` `#环境变量` `#provider`
> **发现日期**：2026-06-12
> **来源**：发布说明编写时排查内网网关配置脚本的环境变量改名情况
> **优先级**：中（阻断「内网脚本完全去 claude 化」；当前以保留旧名规避）

---

## 问题概述

品牌迁移为环境变量引入了 `YWCODER_X ?? CLAUDE_CODE_X` 的 fallback（`getYwCoderEnv`），但 **provider 选择标志 `CLAUDE_CODE_USE_OPENAI`（及同族 `USE_GEMINI/USE_GITHUB/USE_BEDROCK/USE_VERTEX/USE_FOUNDRY`）在 `providerProfiles.ts` 多处被直读，未走 fallback**。

后果：用户若只设新名 `YWCODER_USE_OPENAI`（不设旧名 `CLAUDE_CODE_USE_OPENAI`），下列 provider profile 判断会失效，行为不可预测。

## 直读旧名的位置（未走 getYwCoderEnv）

- `src/utils/providerProfiles.ts:259` `hasProviderSelectionFlags` —— 直读 `processEnv.CLAUDE_CODE_USE_OPENAI !== undefined`（及同族 5 个）
- `src/utils/providerProfiles.ts:277-282` `hasConflictingProviderFlagsForProfile`
- `src/utils/providerProfiles.ts:326` `isProcessEnvAlignedWithProfile`
- `src/utils/providerProfile.ts:425` `hasProviderSelectionFlags`（另一文件的同名实现）
- 调用链：`providerProfiles.ts:273 / 317 / 433 / 440 / 444 / 684`

> 对照：`main.tsx`、`utils/auth.ts`、`utils/context.ts`、`utils/providerDiscovery.ts`、`services/api/providerConfig.ts` 等**已正确**使用 `getYwCoderEnv('USE_OPENAI')` / `getYwCoderEnv('INTRANET')`。缺口集中在 provider profile 子系统。

## 影响场景

- 内网用户把配置脚本「去 claude 化」（只留 `YWCODER_USE_OPENAI=1`）时，若本机存有 provider profile（`ywcoder profile init` 保存的本地配置），profile 的对齐/冲突检测会误判「未显式选择 provider」，可能导致 provider 未按预期激活或被 profile 覆盖。
- 纯环境变量、无本地 profile 的用户暂不受影响，但行为依赖「恰好没走到这些判断」，不稳健。

## 当前对策（已在发布说明记录）

内网配置脚本**保留 `CLAUDE_CODE_USE_OPENAI=1`**（可与 `YWCODER_USE_OPENAI=1` 并设），暂不可只用新名。
见 `note/BRAND_MIGRATION_2026-06-07/RELEASE_NOTES_2026-06-12.md` §4.1。

## 候选修复方向

1. 把 `providerProfiles.ts` / `providerProfile.ts` 中所有 `processEnv.CLAUDE_CODE_USE_*` 直读改为经 `getYwCoderEnv('USE_*')`（注意这些函数接收显式 `processEnv` 参数，需保持可注入 —— 可让 `getYwCoderEnv` 支持传入 env，或在这些点做 `env.YWCODER_USE_OPENAI ?? env.CLAUDE_CODE_USE_OPENAI`）。
2. 同步排查 `*_PROVIDER_PROFILE_ENV_APPLIED` 等其它 `CLAUDE_CODE_*` 直读标志（部分已做双读，见 providerProfiles.ts:302-303、309-310）。
3. 补测试：仅设 `YWCODER_USE_OPENAI` 时，provider profile 的 has/align/conflict 判断与设旧名行为一致。

## 待办清单

- [ ] 全量列出 provider 子系统内所有 `CLAUDE_CODE_USE_*` / `CLAUDE_CODE_*` 直读点
- [ ] 决定 fallback 实现方式（扩展 getYwCoderEnv 支持注入 env，或就地双读）
- [ ] 补测试覆盖「仅新名」场景
- [ ] 修复后更新发布说明 §4.1，并通知内网用户可去除 `CLAUDE_CODE_USE_OPENAI`

## 关联

- 发布说明：`note/BRAND_MIGRATION_2026-06-07/RELEASE_NOTES_2026-06-12.md`（§4.1 已知限制）
