# 验证：CLAUDE_CODE_* 旧品牌环境变量残留已消除

对应改动：`fix: 停止写出 CLAUDE_CODE_* 旧品牌环境变量，消除部署残留`（commit `dcb420d`）。

**验证目标（三条独立断言）**
1. **残留消除**：ywcoder 自身进程不再写出 `CLAUDE_CODE_*` 旧名（子进程 / hook / MCP 里看不到）。
2. **入站回退不回归**：用户只设旧名 `CLAUDE_CODE_USE_*` 时，provider 仍能正确激活。
3. **功能无回归**：构建、冒烟、provider 相关测试全绿。

---

## A. 构建期验证（无需 provider，CI 可跑）

```bash
bun run build          # 编译通过
bun run smoke          # 构建 + --version 正常

# provider 相关单测（逐文件跑，避免测试间 env 泄漏——项目 CI 用 --max-concurrency=1）
bun test src/tools/WebFetchTool/domainCheck.test.ts
bun test src/utils/providerValidation.test.ts
bun test src/utils/apiPreconnect.test.ts
bun test src/utils/providerProfiles.test.ts
bun test src/bridge/sessionRunner.test.ts
```

**源码级断言（推荐，精确）**：ywcoder 自身进程对旧名的「写入」应只剩一处——有意保留的 ant-only `SESSION_ID`。

```bash
grep -rnE "process\.env\.CLAUDE_CODE_[A-Z_]+ = [^=]" src --include="*.ts" --include="*.tsx" \
  | grep -v "\.test\." | grep -v "delete " | grep -vE "= undefined"
```

期望**唯一**输出：
```
src/commands/clear/conversation.ts:206:    process.env.CLAUDE_CODE_SESSION_ID = getSessionId()
```
（该行 `USER_TYPE === 'ant'` 守卫，对内网死分支、从不写出，本次有意不改。若出现其它行即为回归。）

> 注意：**不要**用 `grep -c CLAUDE_CODE_USE_OPENAI dist/cli.mjs` 判 0——该字面量仍会因子进程白名单数组、`delete` 清理、文案而出现（非写入），计数非 0 属正常。`getYwCoderEnv` 也是动态拼 `CLAUDE_CODE_${suffix}`，dist 里没有整串字面量。故构建产物计数不是可靠判据，以上面的源码写入模式为准。

## B. 运行时残留验证（真机，最能复现内网现象）

`subprocessEnv()` 默认原样透传 `process.env`，因此 ywcoder 的 **Bash 工具子进程会继承 ywcoder 进程的完整环境**——直接在里面看 env 即可观察残留。

**交互式（最可靠）**：以 OpenAI provider 启动 ywcoder，在对话里让它执行一条 Bash 命令：

```
env | sort | grep -E '^(CLAUDE_CODE_|YWCODER_|CLAUDECODE)'
```

**判定**：
- ✅ 应出现：`YWCODER_ENTRYPOINT`、`YWCODER_USE_OPENAI`、`YWCODER_DISABLE_EXPERIMENTAL_BETAS` 等新名。
- ✅ 应**不再出现**：`CLAUDE_CODE_ENTRYPOINT`、`CLAUDE_CODE_USE_OPENAI`、`CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`（本次停写的旧名）。
- ⚪ 仍会有 `CLAUDECODE=1`（无下划线的基础品牌标志，**不在本次范围**，属另一议题）。
- ⚪ bridge/remote/sandbox 模式下子进程 env 里的 `CLAUDE_CODE_ENVIRONMENT_KIND` / `CLAUDE_CODE_FORCE_SANDBOX` / `CLAUDE_CODE_TMPDIR` 等**本次未处理**（见 `note/ISSUE/2026-07-15-...`，后续单独任务）。

> 对比基线：改动前同样操作会看到 `CLAUDE_CODE_ENTRYPOINT=cli`、`CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=true` 与新名并存（即最初排查截图的现象）。

**hook / MCP 场景**：若内网部署配置了自定义 hook 或 MCP server，它们同样继承 ywcoder 进程环境。可在 hook 脚本里临时加 `env | grep CLAUDE_CODE_ >> /tmp/ywcoder-env-check.log` 确认无本次停写的旧名。

## C. 入站回退不回归验证（必须仍生效）

用户/内网脚本**只设旧名**时，provider 仍应正确激活（`getYwCoderEnv` 回退保证）。

**快速单元级校验（无需真实网关）**：在**仓库根目录**创建临时脚本再跑（相对 `import` 依赖此路径，勿放 /tmp）：

```bash
cat > verify-fallback.ts <<'EOF'
import { getAPIProvider } from './src/utils/model/providers.ts'
for (const k of Object.keys(process.env))
  if (k.startsWith('YWCODER_') || k.startsWith('CLAUDE_CODE_USE')) delete process.env[k]
process.env.CLAUDE_CODE_USE_GEMINI = '1'
console.log('仅设 CLAUDE_CODE_USE_GEMINI →', getAPIProvider(), '(期望 gemini)')
delete process.env.CLAUDE_CODE_USE_GEMINI
process.env.YWCODER_USE_OPENAI = '1'
console.log('仅设 YWCODER_USE_OPENAI  →', getAPIProvider(), '(期望 openai)')
EOF
bun run verify-fallback.ts; rm -f verify-fallback.ts
```

期望输出：
```
仅设 CLAUDE_CODE_USE_GEMINI → gemini (期望 gemini)
仅设 YWCODER_USE_OPENAI  → openai (期望 openai)
```

**真机级校验**：仅导出旧名 `CLAUDE_CODE_USE_OPENAI=1`（不设 `YWCODER_USE_OPENAI`）+ 对应 `OPENAI_BASE_URL`/`OPENAI_API_KEY` 启动 ywcoder，`/status` 应显示 provider 为 OpenAI，且请求打到 OpenAI 兼容网关（非 Anthropic）。

---

## 通过标准

- A 全绿；源码写入模式 grep 仅剩 `conversation.ts:206` 一处（有意保留）。
- B 中本次停写的三类旧名（ENTRYPOINT / USE_* / DISABLE_EXPERIMENTAL_BETAS）在子进程 env 中消失，新名存在。
- C 两个回退用例均得到期望 provider。
