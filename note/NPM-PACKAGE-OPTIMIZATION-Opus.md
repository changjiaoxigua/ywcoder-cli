# NPM 离线包优化分析

**日期**: 2026-04-11  
**目标**: 将 YwCoder npm 包从 300MB 优化至 ~30MB（对标 Claude Code 官方包 47MB）

---

## 📊 核心差异对比

| 维度 | Claude Code (官方) | YwCoder (当前) | 差距 |
|-----|------|------|-----|
| **总包大小** | **47 MB** | **300 MB** | **6.4倍** ⚠️ |
| **cli.js/cli.mjs 大小** | 13.5 MB | 20 MB | 1.5倍 |
| **node_modules** | **无** | 276 MB | ∞ |
| **dependencies** | `{}` (0个) | 80+ 个 | - |
| **optionalDependencies** | 9个 (仅sharp平台二进制) | 无 | - |
| **bundledDependencies** | 无 | 80+ 个 | ← **罪魁祸首** |
| **vendor 目录位置** | `vendor/` (包根) | `dist/vendor/` | - |

---

## 🔍 关键差异深度分析

### 1️⃣ 最大差异：依赖处理策略完全不同

#### Claude Code 的策略：零依赖 + 单文件打包

**package.json:**
```json
{
  "dependencies": {},           // ✅ 完全为空！
  "optionalDependencies": {     // ✅ 仅 sharp 的平台二进制
    "@img/sharp-darwin-arm64": "^0.34.2",
    "@img/sharp-darwin-x64": "^0.34.2",
    "@img/sharp-linux-arm64": "^0.34.2",
    "@img/sharp-win32-x64": "^0.34.2"
  },
  "files": [
    "cli.js",
    "sdk-tools.d.ts",
    "vendor/ripgrep/",
    "vendor/audio-capture/",
    "vendor/seccomp/"
  ]
}
```

**核心原理**：
- 所有 npm 依赖 **100% 打进单个 `cli.js`** （13.5 MB）
- 运行时 **零** npm 依赖
- `npm install -g @anthropic-ai/claude-code` 瞬间完成，无需下载 node_modules

#### YwCoder 当前策略：全量捆绑 node_modules

**问题代码** (`.github/workflows/build-npm-offline.yml`):
```javascript
// 步骤: "Create offline package with node_modules"
node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pkg.bundledDependencies = Object.keys(pkg.dependencies || {});  // ❌ 把所有80+个包列进来
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2));
"
```

**后果**：
- cli.mjs 部分 bundle 了代码（但保留 `@opentelemetry/*`、`sharp` 等为 external）
- 剩余 deps 靠 `node_modules` 运行（276 MB）
- **结果：所有代码被打了两遍！** ❌

---

### 2️⃣ 关键冗余：同时做了两件事

**当前流程**：
```
依赖下载
    ↓
npm install → node_modules (276 MB)
    ↓
build.ts 打包：
  ├─ 部分 deps 打进 cli.mjs
  └─ 其他 deps 标为 external（靠 node_modules）
    ↓
workflow 注入 bundledDependencies
    ↓
npm pack → 整个 node_modules 塞进 tgz → 300 MB ❌
```

**Claude Code 做法**：
```
依赖下载
    ↓
npm install → node_modules (仅用于构建)
    ↓
build.ts 打包：
  └─ 所有 deps 打进 cli.js
    ↓
npm pack → 只打包 files 字段 → 47 MB ✅
```

---

### 3️⃣ build.ts 中的次要问题

**当前配置**：
```typescript
const result = await Bun.build({
  entrypoints: ['./src/entrypoints/cli.tsx'],
  outdir: './dist',
  target: 'node',
  format: 'esm',
  splitting: false,
  sourcemap: 'external',  // ❌ 发布版本不需要
  minify: false,          // ❌ 未压缩 → cli.mjs 比需要的大
  naming: 'cli.mjs',
  external: [
    // ❌ 这些应该 bundle，不应该 external
    '@opentelemetry/api',
    '@opentelemetry/api-logs',
    // ... 还有 16 个 @opentelemetry/* 包
    'sharp',
    'google-auth-library',
  ],
})
```

**影响**：
- `minify: false` 导致 cli.mjs 大小是 Claude 的 1.5 倍（20 MB vs 13.5 MB）
- `sourcemap: 'external'` 生成额外的 `.map` 文件
- `external` 清单中的包无法被 bundle，必须靠 node_modules

---

### 4️⃣ Sharp 处理方式差异

#### Claude Code 的方式：optionalDependencies

**优势**：
- npm 只下载当前平台的 native 二进制（如 `@img/sharp-win32-x64` ~20 MB）
- 其他平台的二进制不下载
- **内网离线环境**: 只需准备一个平台的包

#### YwCoder 当前方式：整个 sharp 打包

**问题**：
- sharp package 本身 ~100 MB（含多平台二进制）
- 全部打进 bundledDependencies
- 效率低

---

### 5️⃣ Vendor 目录位置

| 项目 | 结构 | 问题 |
|-----|------|-----|
| Claude | `vendor/ripgrep/`（根目录） | 简洁 |
| YwCoder | `dist/vendor/ripgrep/` | 多了一层目录，打包时需要调整相对路径 |

---

## 🎯 优化方案（分4阶段）

### **阶段一：消除 bundledDependencies（收益最大 ⭐⭐⭐⭐⭐）**

**目标**: 300 MB → 30 MB

**修改文件**：

1. **`.github/workflows/build-npm-offline.yml`** - 删除整个步骤

```diff
- - name: Create offline package with node_modules
-   run: |
-     node -e "
-     const fs = require('fs');
-     const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
-     pkg.bundledDependencies = Object.keys(pkg.dependencies || {});
-     fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2));
-     "

- name: Pack npm package
  run: npm pack
```

**原因**: `files` 字段已经定义了要打包的内容，不需要额外注入 bundledDependencies。

---

2. **`package.json`** - 简化 files 字段

```diff
  "files": [
    "bin/ywcoder",
    "dist/cli.mjs",
-   "dist/vendor/",
+   "vendor/",
    "README.md"
  ],
+ "optionalDependencies": {
+   "@img/sharp-win32-x64": "^0.34.2"
+ }
```

---

### **阶段二：开启 minify 和移除 sourcemap（收益 ⭐⭐⭐）**

**目标**: cli.mjs 从 20 MB → ~10 MB

**修改文件**: `scripts/build.ts`

```diff
  const result = await Bun.build({
    entrypoints: ['./src/entrypoints/cli.tsx'],
    outdir: './dist',
    target: 'node',
    format: 'esm',
    splitting: false,
-   sourcemap: 'external',
+   sourcemap: 'none',
-   minify: false,
+   minify: true,
    naming: 'cli.mjs',
```

**或使用环境变量区分**：
```typescript
minify: process.env.NODE_ENV === 'production',
sourcemap: process.env.NODE_ENV === 'production' ? 'none' : 'external',
```

---

### **阶段三：移除 external，全量 bundle（收益 ⭐⭐⭐⭐）**

**目标**: 完全消除对 node_modules 的依赖

**修改文件**: `scripts/build.ts`

#### 3.1 从 external 列表中移除这些包：

```typescript
// ❌ 删除这些行（允许 bundle）
'@opentelemetry/api',
'@opentelemetry/api-logs',
'@opentelemetry/core',
'@opentelemetry/exporter-logs-otlp-http',
'@opentelemetry/exporter-trace-otlp-grpc',
'@opentelemetry/exporter-trace-otlp-http',
'@opentelemetry/exporter-trace-otlp-proto',
'@opentelemetry/exporter-logs-otlp-proto',
'@opentelemetry/exporter-logs-otlp-grpc',
'@opentelemetry/exporter-metrics-otlp-proto',
'@opentelemetry/exporter-metrics-otlp-grpc',
'@opentelemetry/exporter-metrics-otlp-http',
'@opentelemetry/exporter-prometheus',
'@opentelemetry/resources',
'@opentelemetry/sdk-trace-base',
'@opentelemetry/sdk-trace-node',
'@opentelemetry/sdk-logs',
'@opentelemetry/sdk-metrics',
'@opentelemetry/semantic-conventions',

'google-auth-library',
'sharp',  // ⚠️ JS 部分 bundle，native binary 靠 @img/sharp-* 的 optionalDependencies
```

#### 3.2 保留这些 external（native addons、大型二进制）：

```typescript
external: [
  // Cloud provider SDKs（如有用）- 这些可能包含 native binary 或 cred files
  '@aws-sdk/client-bedrock',
  '@aws-sdk/client-bedrock-runtime',
  '@aws-sdk/client-sts',
  '@aws-sdk/credential-providers',
  '@azure/identity',
]
```

**关键点**：
- 当前注释说 "OpenTelemetry — too many named exports to stub" 是一个误解
- **Stub 的意思是"用假代码替换"**（用 noop、Proxy 等）
- **Bundle 的意思是"把真实代码打进来"**
- OpenTelemetry 完全可以直接 bundle，不需要 stub

---

### **阶段四：Sharp 改用 optionalDependencies（收益 ⭐⭐）**

**目标**: 进一步清理，对齐 Claude Code

**修改文件**: `package.json`

```diff
  "dependencies": {
    // ... 其他 deps
-   "sharp": "^0.34.5",  // ❌ 移除（bundle 进 cli.mjs）
    // ...
  },
  "optionalDependencies": {
+   "@img/sharp-win32-x64": "^0.34.2"  // ✅ 只要 Windows x64
  }
```

**说明**：
- sharp 的 JS 代码被 bundle 进 cli.mjs
- sharp 的 native `.node` 文件会去 `node_modules/@img/sharp-win32-x64` 查找
- 如果未来要多平台支持，再加其他 `@img/sharp-*` 包

---

### **阶段五（可选）：Vendor 目录扁平化**

**目标**: 清理性优化，无功能改变

**当前结构**：
```
dist/vendor/ripgrep/x64-win32/rg.exe
```

**目标结构**：
```
vendor/ripgrep/x64-win32/rg.exe
```

**修改**：
1. `.github/workflows/build-npm-offline.yml` - 创建 vendor 而非 dist/vendor
2. `scripts/build.ts` - 修改 ripgrep 路径查找逻辑
3. `package.json` 的 `files` 字段已在阶段一改为 `"vendor/"`

---

## 📈 预期效果

| 阶段 | 修改项 | 大小变化 | 累计大小 |
|-----|------|-------|-------|
| 当前 | - | - | **300 MB** |
| 一 | 删除 bundledDependencies | -270 MB | **30 MB** |
| 二 | 开启 minify | -10 MB | **20 MB** |
| 三 | 全量 bundle OpenTel 等 | -10 MB | **10 MB** |
| 四 | Sharp optionalDeps | -5 MB | **5 MB** |

**最终目标**: **~10-15 MB** （接近 Claude Code 的 47 MB 中的核心部分）

---

## ⚠️ 风险评估

| 风险项 | 风险等级 | 缓解方案 |
|-----|-------|-------|
| OpenTelemetry bundle 失败 | **中** | 如果 bundle 失败，保留为 external；或改成 stub（参考 build.ts 现有的 stub 模式） |
| Sharp native binary 路径 | **中** | 需要验证 cli.mjs 中 `require('@img/sharp-*')` 路径在 bundle 后仍能找到二进制 |
| 内网离线环境 | **中** | 确保 `@img/sharp-win32-x64` 或完整 sharp 包在内网仓库中可用 |
| 其他 external deps 副作用 | **低** | google-auth-library 等大包可能有 native addon，需 smoke 测试 |

---

## ✅ 验证清单

在 push 到 GitHub Actions 前，本地验证：

- [ ] `bun run build` 成功，`dist/cli.mjs` 大小 < 15 MB
- [ ] `npm pack` 生成的 tgz 文件大小 < 50 MB
- [ ] 解压 tgz，验证 `node_modules` 目录不存在
- [ ] `node dist/cli.mjs --version` 正常输出版本号
- [ ] 本地 `npm install -g ./dcywzc-ywcoder-*.tgz` 能安装成功
- [ ] `ywcoder --version` 能运行
- [ ] ripgrep 能正常查询代码
- [ ] OpenTelemetry 相关日志模块能初始化
- [ ] Sharp 相关图像处理能工作

---

## 🔄 执行顺序建议

### **快速路径（推荐）**：
1. **先做阶段一**（删除 bundledDependencies）→ 立即收获 270 MB
2. **本地验证** → npm pack + 测试
3. **再做阶段二、三** → 在 build.ts 优化

### **保守路径**：
1. 每阶段一个 PR
2. 每阶段本地完整测试
3. 逐步上线

---

## 📚 参考

- **Claude Code 官方包**：`@anthropic-ai/claude-code` v2.1.101
- **YwCoder 当前包**：`@dcywzc/ywcoder` v1.0.0
- **分析时间**：2026-04-11

---

## 💡 后续优化方向（可选）

1. **预构建不同平台的 cli.js**
   - Windows: 去掉 macOS/Linux ripgrep
   - macOS: 去掉 Windows/Linux ripgrep
   - 每个平台包大小 < 10 MB

2. **压缩 vendor 二进制**
   - ripgrep 本身 ~10 MB，可压缩为 .tar.xz 然后解压

3. **分离 heavy deps**
   - 如果 OpenTelemetry 确实有问题，可考虑延迟加载或 lazy require

4. **监测包大小**
   - CI 中添加包大小检查，防止回退

---

---

## 🔧 后续完善记录（2026-04-24）

### 已完成：依赖分类修复（commit 7e4727b）

**问题**：npm 打包优化过程中，将所有 `dependencies` 精简到 8 个，但未区分"构建时依赖"与"运行时依赖"，导致 `bun run build` 报 `Could not resolve` 错误。

**修复**：将 Bun bundler 会内联进 `dist/cli.mjs` 的 60+ 个包从 `dependencies` 移入 `devDependencies`，仅保留 sharp + opentelemetry 在 `dependencies`（这两类无法 bundle，必须以独立文件存在）。

**验证结果**：

| 项目 | 结果 |
|---|---|
| `bun run build` | ✓ dist/cli.mjs 18MB，构建成功 |
| `bun run smoke` | ✓ v1.0.1 正常输出 |
| `bun test` | ✓ 522 pass / 0 fail |
| `npm pack` tgz 体积 | 16.5MB（devDeps 未进入 tgz） |

**关于 tgz 体积说明**：

- commit 251b45f 的 "4MB tgz" 是清空了所有 `bundledDependencies` 的结果——在联网环境可行，但内网离线场景因缺少 sharp/opentelemetry 会运行失败
- 当前 **16.5MB** 是离线内网部署的正确体积（sharp + opentelemetry 随 tgz 分发）
- devDependencies 中的 chalk/lodash/zod 等包已内联进 cli.mjs，不在 tgz 中

---

### 待完成后续步骤（对应原优化方案各阶段）

#### 步骤 A：验证 bundledDependencies 完整性（阶段一收尾）

当前 `bundledDependencies` 列表为 14 个包（sharp + opentelemetry 系列）。需确认：

- [ ] 所有 `bundledDependencies` 中的包均已在 `dependencies` 中声明（npm 规范要求）
- [ ] `bun pm untrusted` 检查是否有被阻止的 postinstall 脚本需要处理
- [ ] 在**全新无 node_modules 环境**中 `npm install ./tgz` 后验证 CLI 可正常运行

#### 步骤 B：CI/CD 工作流同步（重要）

构建流水线（`.github/workflows/`）中如有动态注入 `bundledDependencies` 的步骤，需要同步删除或更新，避免工作流覆盖本次修复。

- [ ] 检查所有 workflow 文件，找出操作 `package.json` 的 `node -e` 脚本
- [ ] 确认没有步骤会把 `devDependencies` 里的包重新写入 `dependencies`

#### 步骤 C：阶段二——开启 CI 构建 minify（已有配置，确认即可）

查看 `scripts/build.ts`：
```typescript
minify: !!process.env.CI,   // CI 环境已开启 minify
```
当前本地构建 18MB，CI 构建应自动压缩到 ~10MB。

- [ ] 触发一次 CI 构建，确认 dist/cli.mjs 在 CI 中 < 12MB

#### 步骤 D：阶段三——评估 opentelemetry 全量 bundle 可行性

当前 opentelemetry 系列作为 `external` + `bundledDependencies` 随包分发（~10MB）。理论上可以 bundle 进 cli.mjs 以彻底消除这部分 node_modules 依赖。

风险：opentelemetry 动态 exports 可能导致 bundle 失败。

- [ ] 在 `scripts/build.ts` 的 `external` 列表中注释掉 `@opentelemetry/*`，尝试构建
- [ ] 若构建成功，运行完整测试；若失败，保持现状

#### 步骤 E：包大小 CI 守护

防止未来优化成果被无意间回退：

- [ ] 在 CI 中添加包体积检查步骤（如 tgz > 50MB 则 fail）
- [ ] 可参考 `size-limit` 工具或简单的 `npm pack` + `du` 判断

---

**文档版本**: v1.1  
**最后更新**: 2026-04-24
