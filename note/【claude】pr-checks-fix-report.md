# PR-Checks 工作流修复报告

## 问题背景

推送代码后触发的 GitHub Actions `PR-Checks` 工作流持续报错，导致 CI 无法通过。

---

## 根本原因分析

问题分为两个独立层面：

### 层面一：工作流配置错误（直接原因）

`.github/workflows/pr-checks.yml` 最后一步使用了 `npm run` 而非 `bun run`：

```yaml
# 修复前（错误）
- name: Provider recommendation tests
  run: npm run test:provider-recommendation

# 修复后（正确）
- name: Provider recommendation tests
  run: bun run test:provider-recommendation
```

项目全程使用 Bun 作为运行时，`npm` 在该环境下无法正常工作，导致该步骤直接失败。

---

### 层面二：测试文件跨文件污染（深层原因）

修复工作流后，CI 仍有多个测试失败。经排查，根本原因是 **Bun 以 `--max-concurrency=1` 运行测试时，所有文件共享同一个进程，包括同一份 `process.env` 和模块缓存（module registry）**。

污染链路有两类：

#### 2.1 `process.env` 环境变量泄露

项目同时使用 `YWCODER_USE_*` 和 `CLAUDE_CODE_USE_*` 两套环境变量来控制 API Provider（OpenAI、Gemini、GitHub 等）。多个测试文件在 `afterEach` 中只清理了 `CLAUDE_CODE_USE_*`，遗漏了 `YWCODER_USE_*`，导致 Provider 变量泄露到后续测试文件，使 `getAPIProvider()` 返回非预期的非 `firstParty` 值，进而造成连锁失败。

**涉及文件及具体缺陷：**

| 文件 | 缺陷描述 |
|------|---------|
| `src/utils/providerFlag.test.ts` | `RESET_KEYS` 只列 `CLAUDE_CODE_USE_*`，缺少 `YWCODER_USE_*`；而 `applyProviderFlag()` 会同时设置两套变量 |
| `src/utils/providerValidation.test.ts` | `afterEach` 只还原 `CLAUDE_CODE_USE_GEMINI`，漏掉 `YWCODER_USE_GEMINI` |
| `src/services/api/openaiShim.test.ts` | 同上，`afterEach` 漏掉 `YWCODER_USE_GEMINI` |

#### 2.2 模块 Mock 未正确清理

`src/utils/model/modelOptions.github.test.ts` 的 `importFreshModelOptionsModule()` 调用了 `mock.module('./providers.js', () => ({ getAPIProvider: () => 'github' }))`，在测试结束后 Bun 的 `mock.restore()` 无法完全清除该 mock 在模块缓存中的残留，导致后续文件（`officialRegistry.test.ts`）导入的 `providers.js` 仍是 mock 版本，`getAPIProvider()` 始终返回 `'github'`，使依赖 firstParty 模式的逻辑提前返回。

#### 2.3 Mock 导出不完整导致模块加载失败并污染模块缓存

`src/utils/user.test.ts` 和 `src/utils/fastMode.test.ts` 对 `bootstrap/state.js` 的 mock 缺少 `addSlowOperation` 导出。当 `slowOperations.ts` 尝试从中导入该函数时，模块加载失败并以破损状态写入缓存，后续其他文件（如 `withRetry.test.ts`）通过依赖链间接导入同一模块时也会失败。

同时，两个文件对 `envUtils.js` 的 mock 中 `isEnvTruthy` 实现有误——将所有非 `'0'`、非 `'false'` 的字符串视为真值（包括 `'undefined'`），而真实实现只接受 `['1', 'true', 'yes', 'on']`，导致 Provider 判断错误。

---

## 修复内容

### 修复 1：工作流配置

**文件：** `.github/workflows/pr-checks.yml`

```diff
- run: npm run test:provider-recommendation
+ run: bun run test:provider-recommendation
```

---

### 修复 2：`src/utils/user.test.ts`

**问题一：** `state.js` mock 缺少 `addSlowOperation`
```diff
  mock.module('../bootstrap/state.js', () => ({
    getSessionId: () => 'session-test',
+   addSlowOperation: () => {},
  }))
```

**问题二：** `envUtils.js` mock 的 `isEnvTruthy` 实现有误，且缺少 `getYwCoderEnv`
```diff
  mock.module('./envUtils.js', () => ({
-   isEnvTruthy: (value: string | undefined) =>
-     !!value && value !== '0' && value.toLowerCase() !== 'false',
+   isEnvTruthy: (value: string | boolean | undefined): boolean => {
+     if (!value) return false
+     if (typeof value === 'boolean') return value
+     return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase().trim())
+   },
+   getYwCoderEnv: (suffix: string) =>
+     process.env[`YWCODER_${suffix}`] ?? process.env[`CLAUDE_CODE_${suffix}`],
  }))
```

---

### 修复 3：`src/utils/fastMode.test.ts`

**问题一：** `state.js` mock 缺少 `addSlowOperation`
```diff
  mock.module('../bootstrap/state.js', () => ({
    getIsNonInteractiveSession: () => false,
    getKairosActive: () => false,
    preferThirdPartyAuthentication: () => false,
+   addSlowOperation: () => {},
  }))
```

**问题二：** `envUtils.js` mock 的 `isEnvTruthy` 实现有误
```diff
  mock.module('./envUtils.js', () => ({
-   isEnvTruthy: (value: string | undefined) =>
-     !!value && value !== '0' && value.toLowerCase() !== 'false',
+   isEnvTruthy: (value: string | boolean | undefined): boolean => {
+     if (!value) return false
+     if (typeof value === 'boolean') return value
+     return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase().trim())
+   },
    getYwCoderEnv: (suffix: string) =>
      process.env[`YWCODER_${suffix}`] ?? process.env[`CLAUDE_CODE_${suffix}`],
  }))
```

---

### 修复 4：`src/utils/providerFlag.test.ts`

**问题：** `RESET_KEYS` 未包含 `YWCODER_USE_*` 系列变量
```diff
  const RESET_KEYS = [
+   'YWCODER_USE_OPENAI',
+   'YWCODER_USE_GEMINI',
+   'YWCODER_USE_GITHUB',
+   'YWCODER_USE_BEDROCK',
+   'YWCODER_USE_VERTEX',
    'CLAUDE_CODE_USE_OPENAI',
    'CLAUDE_CODE_USE_GEMINI',
    ...
  ]
```

---

### 修复 5：`src/utils/providerValidation.test.ts`

**问题：** `afterEach` 漏掉 `YWCODER_USE_GEMINI` 的还原
```diff
  afterEach(() => {
+   restoreEnv('YWCODER_USE_GEMINI', originalEnv.CLAUDE_CODE_USE_GEMINI)
    restoreEnv('CLAUDE_CODE_USE_GEMINI', originalEnv.CLAUDE_CODE_USE_GEMINI)
    ...
  })
```

---

### 修复 6：`src/services/api/openaiShim.test.ts`

**问题：** `afterEach` 漏掉 `YWCODER_USE_GEMINI` 的还原
```diff
  afterEach(() => {
    restoreEnv('OPENAI_BASE_URL', originalEnv.OPENAI_BASE_URL)
+   restoreEnv('YWCODER_USE_GEMINI', originalEnv.CLAUDE_CODE_USE_GEMINI)
    restoreEnv('CLAUDE_CODE_USE_GEMINI', originalEnv.CLAUDE_CODE_USE_GEMINI)
    ...
  })
```

---

### 修复 7：`src/utils/model/modelOptions.github.test.ts`

**问题：** 使用 `mock.module('./providers.js', ...)` 注入 mock，Bun 的 `mock.restore()` 无法完全清理模块缓存中的残留，后续文件的 `providers.js` 仍为 mock 版本。

**修复思路：** 由于测试本身已通过 env 变量（`YWCODER_USE_GITHUB=1`）控制 Provider，`getAPIProvider()` 会在运行时读取 env 返回正确值，完全不需要 mock `providers.js`。直接去掉 module mock，并在 `afterEach` 补充 `mock.restore()` 兜底。

```diff
  async function importFreshModelOptionsModule() {
    mock.restore()
-   mock.module('./providers.js', () => ({
-     getAPIProvider: () => 'github',
-   }))
    const nonce = `${Date.now()}-${Math.random()}`
    return import(`./modelOptions.js?ts=${nonce}`)
  }

  afterEach(() => {
    ...
    resetModelStringsForTestingOnly()
+   mock.restore()
  })
```

---

### 修复 8：`src/components/Feedback.tsx`

**问题：** 第 37-38 行的注释与 `const` 声明错误合并到同一行，导致变量声明被注释掉，运行时 `GITHUB_ISSUES_REPO_URL` 无法被识别，抛出 `ReferenceError`。

**根本原因：** 注释行和变量声明合并成了一行，使得 `const GITHUB_ISSUES_REPO_URL = ...` 成为注释的一部分，变量未被声明。

```diff
  // TODO(内网部署): 需要改为内网Git仓库地址，当前为公网GitHub临时配置
  // 内网部署前必须修改此项，否则用户提交反馈会跳转到无法访问的公网地址
+ const GITHUB_ISSUES_REPO_URL = 'https://github.com/dcywzc/ywcoder/issues';
- // 内网部署前必须修改此项，否则用户提交反馈会跳转到无法访问的公网地址const GITHUB_ISSUES_REPO_URL = 'https://github.com/dcywzc/ywcoder/issues';
```

---

## 修复结果

| 阶段 | 通过 | 失败 | 说明 |
|------|------|------|------|
| 修复前 | — | 多个 | 工作流直接失败，测试未全量运行 |
| 工作流修复后 | 506 | 16 | 测试跑通，暴露跨文件污染问题 |
| 环境变量污染修复后 | 515 | 7 | 解决 env 变量泄露，仍有 module mock 污染 |
| 全部修复后 | **522** | **0** | ✅ 全部通过 |

**修复内容统计：**
- 工作流配置：1 处
- 测试文件：7 处（user.test.ts、fastMode.test.ts、providerFlag.test.ts、providerValidation.test.ts、openaiShim.test.ts、modelOptions.github.test.ts）
- 产品代码：1 处（Feedback.tsx）
- **总计：9 处修改**

---

## 经验总结

1. **Bun `--max-concurrency=1` 下测试文件共享进程**：所有文件的 `process.env` 和模块缓存互通，`afterEach` 的环境清理必须覆盖所有被修改的变量，遗漏任何一个都可能污染后续文件。

2. **`YWCODER_USE_*` 与 `CLAUDE_CODE_USE_*` 必须成对清理**：项目双命名空间设计要求测试中设置和清理均需同时操作两套变量。

3. **`mock.module()` 的残留风险**：Bun 的 `mock.restore()` 在某些情况下无法完全清除模块缓存中的 mock 状态。应优先通过 env 变量控制行为，避免不必要的 module mock。

4. **Mock 导出必须完整**：mock 一个模块时需包含被导入方实际使用的全部 export，否则模块加载失败会以破损状态缓存，连锁影响依赖链上的所有下游模块。
