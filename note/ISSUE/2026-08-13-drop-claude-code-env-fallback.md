# [待排期] 全局去掉 getYwCoderEnv 的 CLAUDE_CODE_* 旧名回退（只读新名）

> **状态**：🔲 未完成 · 已决策待排期
> **标签**：`#品牌迁移缺口` `#环境变量` `#provider`
> **发现日期**：2026-08-13
> **来源**：ywmatrix-shim 交付前审核复核——onboard-github 测试失败排查时引出
> **决策**：2026-08-13 用户拍板「可以直接改成不读旧名，只读新名，无需保留兼容性」，但**单独排期**，不混入 ywmatrix-shim 交付分支（feature/ywmatrix-shim）

---

## 背景

环境变量双名机制现状（`src/utils/envUtils.ts:24`）：

```ts
export function getYwCoderEnv(suffix: string): string | undefined {
  return process.env[`YWCODER_${suffix}`] ?? process.env[`CLAUDE_CODE_${suffix}`]
}
```

- **写入端已收口**（`2026-07-15-stop-writing-claude-code-env-residue.md` / commit dcb420d）：ywcoder 自身只写 `YWCODER_*`，不再写出旧名。
- **读取端仍保留旧名回退**：`getYwCoderEnv` 有 150+ 调用点，覆盖 USE_OPENAI/GEMINI/GITHUB/BEDROCK/VERTEX/FOUNDRY、CONFIG_DIR、ENTRYPOINT 等全部双名变量。

本 issue 是写入端收口的**读取端对应物**：去掉 `?? CLAUDE_CODE_*` 回退，只认新名。

## 影响面（去掉回退后）

- 任何仍在用 `CLAUDE_CODE_*` 旧名的**旧部署 / 配置脚本 / settings.json**，升级后**静默失效**（例：`CLAUDE_CODE_USE_GITHUB=1` 不再激活 GitHub 模式；`CLAUDE_CONFIG_DIR` 不再生效、回退默认路径）。
- 内网脚本侧：自 2026-06-17（USE_OPENAI fallback 闭合）起文档已指引「可只用新名」，需发布前再次确认内网实际脚本已切换完毕。
- 用户手写的旧名 export（个人 shell rc 等）将不再被识别——按本次决策这是**可接受的 breaking change**，但需在发布说明/升级须知中显式公告。

## 待办清单

- [ ] 内网部署/脚本侧确认无 `CLAUDE_CODE_*` 残留依赖（升级前置条件）
- [ ] `getYwCoderEnv` 函数体去掉 `?? process.env[...]` 回退（1 行），评估是否保留函数壳还是全量替换为直读
- [ ] 全量 grep `CLAUDE_CODE_` 直读点与双名 delete 清理点，同步简化（delete 站点可只删新名）
- [ ] 更新受影响测试（withRetry.test.ts、officialRegistry.test.ts、providerConfig.github.test.ts 等显式设旧名的用例）
- [ ] 发布说明/USER_UPGRADE_NOTICE 公告 breaking change
- [ ] `bun run build && bun test --max-concurrency=1` 保绿

## 关联

- 写入端收口：`note/ISSUE/2026-07-15-stop-writing-claude-code-env-residue.md`（commit dcb420d）
- 双名机制引入：`note/ISSUE/2026-06-12-use-openai-flag-fallback-incomplete.md`（2026-06-17 已闭合）
- 本次触发点的测试修复：onboard-github.test.ts 断言对齐「只写新名」（feature/ywmatrix-shim 分支，2026-08-13）
