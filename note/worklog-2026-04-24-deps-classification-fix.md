# 工作日志 2026-04-24：构建时依赖分类修复与 npm 依赖模型梳理

小结：修复了 npm 离线包构建环境依赖缺失问题，将 60+ 个构建时依赖正确归类为 devDependencies，确保 bun build / 测试套件（522 项）全部通过，同时保持离线 tgz 包体积（16.5MB）不回退，内网部署流程不受影响。
非技术版：
排查并修复了内网 CLI 工具的构建断路问题，恢复开发环境可正常打包和测试，不影响现有离线安装包的分发流程。

---

## 一、问题背景

工作区对 `package.json` 做了未提交的精简（npm 打包优化），将 `dependencies` 从 60+ 个包砍到 8 个（仅保留 sharp + opentelemetry），但未正确区分"构建时依赖"与"运行时依赖"，导致：

- `bun run build` 报 `Could not resolve: "chalk"` / `"lodash-es"` / `"zod"` 等 20+ 个错误
- `bun install` 也无法修复（这些包已从 `package.json` 所有字段中消失）
- `bun test` 无法运行

HEAD 提交 `e9cd49b`（"恢复 package.json 完整构建时依赖"）虽已修复，但工作区的未提交改动覆盖了它。

---

## 二、根本原因分析

| 文件                        | git HEAD (e9cd49b)                 | 工作区（未提交）                   |
| --------------------------- | ---------------------------------- | ---------------------------------- |
| `package.json` dependencies | 60+ 个包（含 chalk/lodash/zod）    | 8 个包（仅 sharp + opentelemetry） |
| `bun.lock`                  | 完整                               | 同步精简                           |
| `node_modules`              | 不完整（bun install 按工作区安装） | 缺 chalk/lodash/zod 等             |

问题不在于 bun.lock 条目丢失，也不在于安装流程，而在于：这些包被从 `dependencies`/`devDependencies` 中完全删除了。

---

## 三、修复方案（方案 B：语义正确的分类）

将所有 **Bun bundler 会内联进 `dist/cli.mjs` 的包** 从 `dependencies` 移入 `devDependencies`，仅保留**无法 bundle 的运行时外部包**在 `dependencies`：

```
dependencies（运行时需要独立文件）:
  sharp, @opentelemetry/api, @opentelemetry/api-logs, ...

devDependencies（构建时读取，内联进 cli.mjs）:
  chalk, lodash-es, zod, execa, axios, commander, react, ...（60+ 个）
```

执行命令：

```bash
bun add -d chalk@5.6.2 lodash-es@4.18.1 zod@3.25.76 \
  @anthropic-ai/sdk@0.81.0 @modelcontextprotocol/sdk@1.29.0 \
  commander@12.1.0 execa@9.6.1 axios@1.14.0 ... （共 63 个包）
```

提交：`7e4727b` — fix: 将构建时依赖从 dependencies 移入 devDependencies

---

## 四、验证结果

| 验证项     | 命令                           | 结果                         |
| ---------- | ------------------------------ | ---------------------------- |
| 构建       | `bun run build`                | ✓ dist/cli.mjs 18MB          |
| 冒烟测试   | `bun run smoke`                | ✓ v1.0.1 正常输出            |
| 单元测试   | `bun test --max-concurrency=1` | ✓ 522 pass / 0 fail          |
| npm 包体积 | `npm pack --dry-run`           | ✓ 16.5MB，devDeps 未进入 tgz |

---

## 五、本次涉及的知识点

### 5.1 npm 三类依赖字段的语义

| 字段                  | 含义                                     | 典型用途                                                |
| --------------------- | ---------------------------------------- | ------------------------------------------------------- |
| `dependencies`        | 用户安装你的包时，npm 会自动一并安装的包 | 运行时必须独立存在的包（native 模块、无法 bundle 的包） |
| `devDependencies`     | 只有开发者本地才安装，用户不会安装       | 构建工具、测试框架、**会被 bundle 进产物的包**          |
| `bundledDependencies` | 将指定包的 node_modules 物理打入 tgz     | 离线/内网场景下随包分发的运行时依赖                     |

**关键规则**：`bundledDependencies` 中列出的包必须同时在 `dependencies` 中声明（不能是 devDependencies）。

### 5.2 Bundle（打包）的本质

Bun bundler 在构建时做的事情：

```
源码:  import chalk from 'chalk'   ← 读取 node_modules/chalk 的源码
           ↓
构建:  chalk 的实现代码被"物理复制"进 dist/cli.mjs
           ↓
产物:  dist/cli.mjs 里不再有 import chalk，而是 chalk 的代码本身
```

bundle 后，`chalk` 的**代码**在 cli.mjs 里，但 `node_modules/chalk/` 这个**目录**不需要了。

### 5.3 devDependencies 在构建型 CLI 中的扩展语义

对于**库（library）**：

- devDependencies = 测试/文档工具，构建后完全不出现在产物里

对于**打包型 CLI（本项目）**：

- devDependencies = 构建时需要读取其源码的包，构建后以**内联形式**存在于 cli.mjs 中

两者的共同点：**用户安装你的包后，不需要也不会安装 devDependencies**。

### 5.4 为什么 devDependencies 在开发时必须安装

Bun bundler 在 `bun run build` 时需要：

1. 从 `node_modules/chalk/` 读取 chalk 的源码
2. 将读到的代码内联进 cli.mjs

没有 `node_modules/chalk/`，步骤 1 失败 → `Could not resolve: "chalk"` 报错。

所以开发环境必须有它，但用户环境不需要它（cli.mjs 已经自包含）。

### 5.5 sharp / opentelemetry 为何必须留在 dependencies

这两类包不能被 bundle 的原因：

| 包类型             | 不能 bundle 的原因                                        |
| ------------------ | --------------------------------------------------------- |
| `sharp`            | 包含 `.node` 原生二进制，bundler 无法内联二进制文件       |
| `@opentelemetry/*` | 动态 exports 太多，bundle 会出错（build.ts 中有注释说明） |

它们必须以独立文件形式存在于运行时环境，所以：

- 留在 `dependencies`（用户安装时自动下载）
- 或列入 `bundledDependencies`（离线场景随 tgz 分发）

### 5.6 npm 包 tgz 的内容结构（内网离线场景）

```
tgz
├── dist/cli.mjs          ← 18MB，chalk/lodash/zod 等代码已内联
├── dist/vendor/ripgrep/  ← ripgrep 二进制
├── node_modules/sharp/   ← bundledDependencies（无法 bundle 的运行时依赖）
├── node_modules/@opentelemetry/
├── bin/ywcoder
└── package.json / README
```

**devDependencies 的包不在其中**，因为它们已经在 cli.mjs 里了。

### 5.7 "4MB tgz"与当前"16.5MB tgz"的差异

| 状态                                    | 大小   | 原因                                                                      |
| --------------------------------------- | ------ | ------------------------------------------------------------------------- |
| commit 251b45f（eliminate bundledDeps） | ~4MB   | bundledDependencies 被清空，sharp/opentelemetry 未随包分发                |
| 当前状态（正确）                        | 16.5MB | sharp + opentelemetry 以 bundledDependencies 形式随包分发，内网可正常使用 |

251b45f 的 4MB 在联网环境可行（用户可安装 sharp），但在内网离线场景会因缺少 sharp/opentelemetry 而运行失败。当前 16.5MB 才是离线内网部署的正确体积。

---

## 六、package.json 最终结构（简图）

```json
{
  "dependencies": {
    "sharp": "^0.34.5",
    "@opentelemetry/api": "1.9.1",
    "...": "（共 8 个运行时外部包）"
  },
  "devDependencies": {
    "chalk": "5.6.2",
    "lodash-es": "4.18.1",
    "zod": "3.25.76",
    "...": "（共 68 个构建时依赖）"
  },
  "bundledDependencies": [
    "sharp",
    "@opentelemetry/api",
    "...（共 14 个，随 tgz 分发给内网用户）"
  ]
}
```

---

## 七、阶段3恢复：配置目录迁移至 ~/.ywcoder（同日追加）

恢复 YwCoder 独立的配置目录 `~/.ywcoder`，与官方 Claude Code 的 `~/.claude` 实现运行时数据隔离，同时保留静默兼容和一键迁移能力，解决品牌分叉后配置互相污染的问题。

### 7.1 需求背景

BRAND1 迁移中，阶段3曾引入 `~/.ywcoder` 作为独立配置目录，但阶段6因"内网共享更简单"而撤销。经重新评估，恢复独立目录对长期维护更有利：
- 官方 Claude Code 使用 `~/.claude`，YwCoder 若复用会导致 sessions、plugins、settings 等子目录互相污染
- `ywcoder ps` 可能列出 `claude` 的会话，`claude ps` 也可能列出 `ywcoder` 的会话
- 独立目录后，两个工具的运行时数据完全隔离

### 7.2 修改内容

| 文件 | 改动 |
|------|------|
| `src/utils/envUtils.ts` | 恢复 `getYwCoderConfigHomeDir()` 多级检测逻辑：优先级为 `YWCODER_CONFIG_DIR` > `CLAUDE_CONFIG_DIR` > `~/.ywcoder`(存在) > `~/.claude`(存在，TTY 提示迁移) > `~/.ywcoder`(默认) |
| `src/utils/configMigration.ts` | **重新创建**。从 `~/.claude` 复制配置到 `~/.ywcoder`，不覆盖已有文件，支持 `import.meta.main` 独立执行 |
| `src/entrypoints/cli.tsx` | 在 `--version` fast-path 之后、`--provider` 之前，插入 `--migrate-config` CLI fast-path |
| `note/BRAND1_MIGRATION_SUMMARY.md` | 新增"阶段7：重新实施阶段3"章节，记录决策变更和兼容性说明 |

### 7.3 目录优先级逻辑

```
YWCODER_CONFIG_DIR > CLAUDE_CONFIG_DIR > ~/.ywcoder(存在) > ~/.claude(存在，提示) > ~/.ywcoder(默认)
```

**行为说明**：
- 新安装（无 `~/.ywcoder` 也无 `~/.claude`）：自动创建并使用 `~/.ywcoder`
- 已有 `~/.ywcoder`：直接使用，无提示
- 已有 `~/.claude` 但无 `~/.ywcoder`：fallback 到 `~/.claude`，TTY 显示黄色迁移提示（仅一次）
- 用户可运行 `ywcoder --migrate-config` 将 `~/.claude` 内容复制到 `~/.ywcoder`

### 7.4 已知风险与决策

| 风险 | 状态 |
|------|------|
| 全局配置文件 `~/.claude.json` 仍共享（OAuth、providerProfiles） | **接受**。内网用户不使用官方 Claude Code，无实际冲突；长期如需完全隔离需改 `getGlobalClaudeFile()`，影响 20+ 调用点 |
| 子目录文件（settings.json 等）无文件锁保护 | **可接受**。两个工具同时修改同一文件概率低；迁移到 `~/.ywcoder` 后自动消除 |
| `getYwCoderConfigHomeDir()` memoize 不感知目录存在性变化 | **已知**。用户运行 `--migrate-config` 后需重启进程才能生效 |

### 7.5 验证结果

| 验证项 | 命令 | 结果 |
|--------|------|------|
| 构建 | `bun run build` | ✅ `dist/cli.mjs` 18MB |
| 冒烟测试 | `bun run smoke` | ✅ `v1.0.1 (YwCoder)` |
| `--migrate-config` 从 `~/.claude` 迁移 | `node dist/cli.mjs --migrate-config` | ✅ 复制成功，提示可删除旧目录 |
| `~/.ywcoder` 已存在时再次迁移 | `node dist/cli.mjs --migrate-config` | ✅ "Already using ~/.ywcoder" |

### 7.6 分支合并

将 `feature/brand-replacement` 与 `main` 同步（fast-forward merge），并推送到远程：

```bash
git checkout feature/brand-replacement
git merge main          # 0db5743 → 7e4727b
git push origin feature/brand-replacement
```

---

*工作日志最后更新: 2026-04-24*

