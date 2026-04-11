# NPM 离线包优化记录

**创建日期**：2026-04-11  
**文档版本**：v2.0（已完成实施，更新为实际结果）

---

## 📊 优化前后对比

| 指标 | 优化前 | 优化后 | 降幅 |
|-----|------|------|------|
| **tgz 压缩大小** | 300 MB | **~10 MB** | **-97%** |
| **解压大小** | ~276 MB | ~60 MB | -78% |
| **node_modules** | 276 MB（80+ 个包） | ~40 MB（仅运行时必需） | -85% |
| **cli.mjs 大小** | 20 MB（未压缩） | **9.5 MB**（CI minify） | -53% |
| **bundled 包数** | 80+ | 14 | - |
| **内网安装** | 需联网 | ✅ 完全离线 | - |

---

## 🧩 与 Claude Code 官方包的差异分析

Claude Code 官方包（47 MB）的关键做法：

```
package.json:
  "dependencies": {}          ← 完全为空
  "optionalDependencies": {   ← 只有 sharp 平台二进制
    "@img/sharp-win32-x64": "^0.34.2"
  }

包内容：
  cli.js        13.5 MB   ← 所有 JS 代码全部 bundle，minify
  vendor/
    ripgrep/    ~30 MB    ← 6 个平台的 ripgrep 二进制
```

**核心原理**：Bun 将所有 npm 依赖打包进单文件，运行时不需要 node_modules。
唯一例外是 sharp 的 native `.node` 二进制，因为它是平台专属 C++ 动态库，
Node.js 必须通过 `dlopen()` 在文件系统中加载，无法内嵌进 JS 文件。

---

## 🔧 实施的四个 PR

### PR-1：删除 bundledDependencies（2026-04-11）

**问题根源**：workflow 中有一段代码将所有 80+ 个 dependencies 动态注入为
`bundledDependencies`，导致 npm pack 时把整个 node_modules 塞进 tgz。

**改动**：删除 `.github/workflows/build-npm-offline.yml` 中的注入步骤。

**效果**：tgz 从 300 MB → 4 MB（但 sharp 因缺少 node_modules 而失效）

---

### PR-2：精简 node_modules，仅保留运行时必需包（2026-04-11）

**问题**：PR-1 后 sharp 功能失效，因为 sharp 的 native binary 必须通过 node_modules 加载。

**改动**：
- 新增 `scripts/prepare-offline-pack.mjs` 脚本
- workflow 在 build 完成后，替换 node_modules 为仅含运行时依赖的精简版
- 通过 `bundledDependencies` 将精简 node_modules 打进 tgz

**精简后 node_modules 包含**：
- `sharp` + `@img/sharp-win32-x64`（Windows native binary）
- `@aws-sdk/client-bedrock-runtime` 等（当时仍为 external）
- 7 个 `@opentelemetry/*` 包

**效果**：tgz 17.4 MB，Windows 内网离线安装验证通过 ✅

---

### PR-3：CI 构建开启 minify（2026-04-11）

**改动**：`scripts/build.ts`

```typescript
// 区分本地开发和 CI 构建
sourcemap: process.env.CI ? 'none' : 'external',  // CI 不生成 sourcemap
minify:    !!process.env.CI,                        // CI 压缩，本地不压缩
```

**说明**：
- GitHub Actions 默认设置 `CI=true`，自动开启 minify
- 本地开发不受影响，仍保留 sourcemap 便于调试
- 发布包中没有 `.map` 文件

**效果**：cli.mjs 从 20 MB → 9.5 MB（-53%）

---

### PR-4：Stub 云服务商 SDK（2026-04-11）

**背景**：内网环境使用自建 LLM 网关，不会使用 AWS Bedrock、Google Vertex AI
或 Azure。这些 SDK 原本在 node_modules 里占用约 35 MB，属于完全无用的空间。

**改动**：在 `scripts/build.ts` 中通过 Bun 的 `onResolve/onLoad` 插件将这些包
替换为桩模块（stub），构建时内联进 cli.mjs，运行时不再需要 node_modules 中的真实包。

**效果**：tgz 从 ~17 MB → **~10 MB**，node_modules 精简 35 MB

---

## 🚫 当前已 Stub 的依赖详情

> **什么是 Stub**：构建时将真实包替换为几行 noop/报错代码，内联进 cli.mjs。
> 用户如果触发相关功能会看到明确的错误提示，而不是崩溃。

| 包名 | 原本用途 | 触发条件 | Stub 原因 |
|-----|---------|---------|---------|
| `@aws-sdk/client-bedrock` | 通过 AWS Bedrock 服务列举/查询 Claude 推理配置 | 用户配置 Bedrock provider，使用 `anthropic.*` 或 ARN 格式模型名 | 内网不使用 AWS 云服务 |
| `@aws-sdk/client-bedrock-runtime` | 通过 AWS Bedrock 实际发送 Claude API 请求 | 同上，发起 API 调用时 | 内网不使用 AWS 云服务 |
| `@aws-sdk/client-sts` | AWS STS 身份验证（`GetCallerIdentity`） | 配置 Bedrock provider 时校验 AWS 凭证 | 内网不使用 AWS 云服务 |
| `@aws-sdk/credential-providers` | 从 `~/.aws/credentials` 读取 AWS 凭证 | Bedrock provider 初始化时 | 内网不使用 AWS 云服务 |
| `@aws-sdk/credential-provider-node` | Node.js 环境下自动发现 AWS 凭证链 | proxy.ts 中探测 AWS 凭证 | 内网不使用 AWS 云服务 |
| `google-auth-library` | Google Cloud / Vertex AI 认证（`GoogleAuth`） | 用户配置 Vertex AI provider | 内网不使用 Google 云服务 |
| `@azure/identity` | Azure AD 认证 | Azure OpenAI provider | src/ 中实际未引用，历史遗留 |

### 涉及源文件

| 源文件 | 引用的包 | 功能描述 |
|-------|---------|---------|
| `src/utils/model/bedrock.ts` | `@aws-sdk/client-bedrock`、`@aws-sdk/client-bedrock-runtime` | Bedrock 客户端创建、推理配置查询 |
| `src/utils/aws.ts` | `@aws-sdk/client-sts`、`@aws-sdk/credential-providers` | AWS STS 身份验证、凭证缓存刷新 |
| `src/utils/proxy.ts` | `@aws-sdk/credential-provider-node` | 代理环境下的 AWS 凭证探测 |
| `src/utils/geminiAuth.ts` | `google-auth-library` | Google Vertex AI 认证 |
| `src/utils/auth.ts` | `google-auth-library` | Google 认证兜底逻辑 |

### Stub 触发后的错误信息

用户如果主动配置了这些 provider，会看到如下错误（而不是崩溃）：

```
[YwCoder] 当前内网构建不支持 AWS Bedrock provider。
如需启用，请删除 scripts/build.ts 中的云服务商 SDK 桩模块并重新构建。
```

---

## 🔄 如何恢复云服务商 SDK 支持

如果将来内网需要使用 AWS Bedrock、Google Vertex AI 等，**只需修改以下 3 处并重新 CI 打包**，无需改动任何业务代码：

### 第一步：删除 build.ts 中的桩模块代码块

打开 [scripts/build.ts](../scripts/build.ts)，找到以下注释块，删除其中所有 `onResolve` 和 `onLoad` 代码：

```typescript
// ─── 云服务商 SDK 桩模块 ───────────────────────────────────────────────
// ...（删除这里到"云服务商 SDK 桩模块结束"之间的所有代码）
// ─── 云服务商 SDK 桩模块结束 ──────────────────────────────────────────
```

### 第二步：取消注释 external 数组

在同一文件底部的 `external` 数组中，取消注释对应的包：

```typescript
external: [
  // 取消以下注释：
  '@aws-sdk/client-bedrock',
  '@aws-sdk/client-bedrock-runtime',
  '@aws-sdk/client-sts',
  '@aws-sdk/credential-providers',
  // '@azure/identity',        // src/ 中未直接引用，按需添加
  'google-auth-library',
]
```

### 第三步：将包加回 RUNTIME_DEPENDENCIES

打开 [scripts/prepare-offline-pack.mjs](../scripts/prepare-offline-pack.mjs)，
在 `RUNTIME_DEPENDENCIES` 中添加对应包：

```javascript
const RUNTIME_DEPENDENCIES = {
  sharp: '^0.34.5',
  // 添加需要的包：
  '@aws-sdk/client-bedrock-runtime': '*',
  'google-auth-library': '9.15.1',
  // ...
  '@opentelemetry/api': '1.9.1',
  // ...其余 opentelemetry 包
}
```

### 第四步：重新触发 CI

```bash
git add scripts/build.ts scripts/prepare-offline-pack.mjs
git commit -m "恢复：启用 AWS Bedrock / Google Vertex AI provider 支持"
git push
```

CI 完成后下载新的 tgz 即可，内网用户重新安装即可使用。

---

## 📦 当前包结构（优化后）

```
dcywzc-ywcoder-1.0.0.tgz（~10 MB）
└── package/
    ├── bin/
    │   └── ywcoder              入口脚本
    ├── dist/
    │   ├── cli.mjs    9.5 MB   所有业务代码（minify）
    │   └── vendor/
    │       └── ripgrep/
    │           └── x64-win32/
    │               └── rg.exe  Windows x64 ripgrep 二进制
    ├── node_modules/            仅运行时必需（~40 MB 解压后）
    │   ├── @img/
    │   │   └── sharp-win32-x64/ Windows sharp native binary
    │   ├── @opentelemetry/      7 个 OTel 包（静态 import，无法 stub）
    │   ├── sharp/               sharp JS 部分
    │   └── （其他 sharp 传递依赖）
    ├── package.json
    └── README.md
```

---

## 📐 当前 external 包说明

以下包在 `build.ts` 中保留为 `external`（不打进 cli.mjs），运行时从 node_modules 加载：

| 包名 | 保留原因 | node_modules 大小 |
|-----|---------|----------------|
| `sharp` | JS 部分可 bundle，但 native `.node` binary 必须在 node_modules | ~1 MB |
| `@img/sharp-win32-x64` | Windows 平台 native binary，无法 bundle | ~19 MB |
| `@opentelemetry/api` | src/ 中有静态 import，导出类型过多，stub 风险高 | ~0.5 MB |
| `@opentelemetry/api-logs` | 同上 | ~0.3 MB |
| `@opentelemetry/resources` | 同上 | ~1 MB |
| `@opentelemetry/sdk-logs` | 同上 | ~2 MB |
| `@opentelemetry/sdk-metrics` | 同上 | ~3 MB |
| `@opentelemetry/sdk-trace-base` | 同上 | ~2 MB |
| `@opentelemetry/semantic-conventions` | 同上 | ~1 MB |

---

## 🔍 本地开发 vs CI 构建差异

| 配置项 | 本地开发（`bun run build`） | CI 构建（`CI=true bun run build`） |
|-------|--------------------------|----------------------------------|
| `minify` | `false`（保留可读性） | `true`（cli.mjs 减半） |
| `sourcemap` | `external`（生成 `.map` 文件） | `none`（不生成） |
| 调试体验 | ✅ 完整 sourcemap，报错可定位到源码行 | 无 sourcemap，需本地复现 |

---

## 📚 参考

- **Claude Code 官方包**：`@anthropic-ai/claude-code` v2.1.101
- **对比分析时间**：2026-04-11
- **关键文件**：
  - [`scripts/build.ts`](../scripts/build.ts) — 构建配置 + 桩模块定义
  - [`scripts/prepare-offline-pack.mjs`](../scripts/prepare-offline-pack.mjs) — 离线包打包脚本
  - [`.github/workflows/build-npm-offline.yml`](../.github/workflows/build-npm-offline.yml) — CI 流水线
