# 02 - 设计文档：版本号管理与自动更新

**Status**: Draft
**Date**: 2026-05-11
**Owner**: changjiaoxigua
**对应需求**: `01-requirements.md`

---

## 1. 整体架构

本方案分为 **3 个子系统**，按风险递增顺序分阶段实施：

```
┌─────────────────────────────────────────────────────────────────────┐
│  [外网]                                                              │
│                                                                       │
│   开发者                                                              │
│     │ git push (feature/**)                                          │
│     ▼                                                                 │
│  ┌────────────┐    分支 push 触发           ┌──────────────────┐    │
│  │  Workflow  │ ───────────────────────────►│  dev build (.tgz)│    │
│  │   build-*  │    版本号: 1.0.2-dev.<sha>   │  附 GIT_SHA 元数据 │    │
│  └────────────┘                              └──────────────────┘    │
│     │                                                                 │
│     │ merge to main                                                  │
│     ▼                                                                 │
│  ┌────────────────┐  自动开 Release PR                                │
│  │ release-please │ ──────►  Release PR (改 package.json + CHANGELOG)│
│  └────────────────┘                                                  │
│     │                                                                 │
│     │ 手工 review + merge Release PR                                 │
│     ▼                                                                 │
│  ┌────────────┐  打 tag v1.0.2                                       │
│  │ release-   │ ───────────────────────────────►  GitHub Release      │
│  │  please    │                                    │ ywcoder-1.0.2-..│
│  └────────────┘                                    └─────────────────┘
└─────────────────────────────────────────────────────────────────────┘
                           │ 人工搬运
                           ▼
┌─────────────────────────────────────────────────────────────────────┐
│  [内网]                                                              │
│   管理员存放点（共享盘/U 盘）                                         │
│     │                                                                 │
│     │ 通知 + 拷贝                                                    │
│     ▼                                                                 │
│   内网用户  ──►  npm install -g ywcoder-1.0.2-linux-x64.tgz          │
│              ──►  ywcoder --version 显示完整可追溯标识                │
└─────────────────────────────────────────────────────────────────────┘
```

三个子系统：

| 子系统 | 名称                | 涉及文件                                         | 实施阶段 |
| ------ | ------------------- | ------------------------------------------------ | -------- |
| S1     | 构建期元数据注入    | `scripts/build.ts`、`src/main.tsx`               | Phase 1  |
| S2     | release-please 接入 | `.github/workflows/release-please.yml`（新增）   | Phase 3  |
| S3     | CI 双轨改造         | `.github/workflows/build-*.yml`（修改）          | Phase 2  |

---

## 2. S1：构建期元数据注入

### 2.1 设计

在 `scripts/build.ts` 的 `define` 段增补 MACRO 注入项，**所有元数据在构建时一次性确定，运行时不再动态计算**，与现有 `MACRO.DISPLAY_VERSION` / `MACRO.BUILD_TIME` 风格保持一致。

### 2.2 新增 MACRO 字段

| 字段                       | 来源                                                            | 示例                          |
| -------------------------- | --------------------------------------------------------------- | ----------------------------- |
| `MACRO.GIT_SHA`            | `git rev-parse --short HEAD`                                    | `"a3f2c1d"`                   |
| `MACRO.BUILD_ID`           | `process.env.GITHUB_RUN_NUMBER` ?? `"local"`                    | `"128"` / `"local"`           |
| `MACRO.BUILD_CHANNEL`      | `process.env.BUILD_CHANNEL` ?? `"local"`                        | `"dev"` / `"release"` / `"local"` |
| `MACRO.DISPLAY_VERSION`    | 已存在；改为拼接 `version + (process.env.VERSION_SUFFIX ?? '')` | `"1.0.2-dev.a3f2c1d"`         |

### 2.3 `MACRO.VERSION` 保持不变

继续硬编码为 `"99.0.0"`，仅供 first-party min-version 检查使用。**严禁与 `MACRO.DISPLAY_VERSION` 合并**。

### 2.4 `--version` 输出

修改 `src/main.tsx` 的 `.version()` 调用，输出格式：

```
1.0.2-dev.a3f2c1d (YwCoder, build #128, 2026-05-11)
```

字段来源：
- `1.0.2-dev.a3f2c1d` → `MACRO.DISPLAY_VERSION`
- `build #128` → `MACRO.BUILD_ID`
- `2026-05-11` → `MACRO.BUILD_TIME` 截取日期部分

本地开发构建（无 CI 环境变量）输出：

```
1.0.2 (YwCoder, build #local, 2026-05-11)
```

### 2.5 兼容性

- `MACRO.VERSION` 不动，所有 first-party 检查链路不受影响；
- `releaseNotes.ts` 等读 `MACRO.VERSION` 的逻辑暂不调整（参考需求 4.1 C1）；
- 内嵌的 `-dev.sha` 形式符合 SemVer pre-release identifier 规范，现有 `semver` 比较库可正确处理。

---

## 3. S2：release-please 接入

### 3.1 工具选型理由

| 候选          | 是否要 publish 公网 | 是否要约定式提交 | 是否提供 Review 机制 | 结论        |
| ------------- | ------------------- | ---------------- | -------------------- | ----------- |
| Changesets    | 否                  | 否               | 不直接               | 备选        |
| semantic-release | 通常需要         | 强制             | 否（直接发版）       | 不选        |
| **release-please** | **不要求**     | **是（推荐但可宽松）** | **是（自动开 PR）** | **采用**    |

选用 release-please 主要因为：
1. 不绑死 npm publish，可单独管理 tag + Release；
2. 已有 commit 风格（`feat:` / `fix:` 已使用）兼容其默认 parser；
3. 自动维护一个长期 Release PR，发版前还有人工 review 机会，符合"内网测试通过才发版"的实际流程。

### 3.2 新增 workflow：`.github/workflows/release-please.yml`

设计要点：

- **触发**：`push: branches: [main]`；
- **配置**：`release-type: node`、`package-name: @dcywzc/ywcoder`；
- **行为**：
  - 解析 main 上新增 commit；
  - 在已有 Release PR 上累计变更，或创建新的 Release PR；
  - merge Release PR 后自动 `git tag v<version>` + 创建 GitHub Release；
- **后续**：tag 创建会触发下文 S3 描述的 build workflow。

### 3.3 Commit 类型与版本号 bump 规则（默认 release-please 行为）

| Commit 前缀                            | bump 类型 | 是否进 CHANGELOG |
| -------------------------------------- | --------- | ---------------- |
| `feat:`                                | minor     | 是               |
| `fix:`                                 | patch     | 是               |
| `feat!:` / `fix!:` / `BREAKING CHANGE` | major     | 是               |
| `docs:` / `chore:` / `refactor:` 等     | 无 bump   | 否               |

### 3.4 不引入 publish

不在 release-please 配置里启用 `npm publish`。release-please 仅负责：
- 维护 `package.json` 版本号；
- 生成 CHANGELOG；
- 打 tag + 创建 GitHub Release。

打包动作由 S3 接管。

### 3.5 注意事项

自动生成的 CHANGELOG 会直接使用 commit message 中文标题。如需更好的可读性，可在 merge Release PR 前手动编辑 release notes。

---

## 4. S3：CI 双轨改造

### 4.1 触发矩阵

| 触发源                  | BUILD_CHANNEL | 版本号后缀          | 产物去向            | 用途                 |
| ----------------------- | ------------- | ------------------- | ------------------- | -------------------- |
| `feature/**` push       | `dev`         | `-dev.<sha>`        | Actions Artifact    | 自测、拷内网验证     |
| tag `v*` push           | `release`     | 无后缀（干净版本号）| GitHub Release      | 正式发版             |
| `workflow_dispatch`     | `dev`（默认） | `-dev.<sha>`        | Actions Artifact    | 手动重打             |

注：`main` push 不单独触发构建。正式发版通过 release-please 打 tag 后触发。

### 4.2 改造点

**`.github/workflows/build-npm-linux-offline.yml`** 等现有 workflow：

1. **触发条件**：

```yaml
on:
  push:
    branches: ['feature/**']
    tags: ['v*']
  workflow_dispatch:
```

2. **新增前置 step：根据触发源决定 channel 与后缀**

```bash
if [[ "$GITHUB_REF" == refs/tags/v* ]]; then
    BUILD_CHANNEL=release
    VERSION_SUFFIX=""
else
    BUILD_CHANNEL=dev
    VERSION_SUFFIX="-dev.${GITHUB_SHA::7}"
fi

echo "BUILD_CHANNEL=$BUILD_CHANNEL" >> $GITHUB_ENV
echo "VERSION_SUFFIX=$VERSION_SUFFIX" >> $GITHUB_ENV
```

3. **`scripts/build.ts` 读取环境变量**：

`MACRO.DISPLAY_VERSION` 注入逻辑改为：

```typescript
JSON.stringify(version + (process.env.VERSION_SUFFIX ?? ''))
```

`MACRO.BUILD_CHANNEL` 同理读 `process.env.BUILD_CHANNEL ?? 'local'`。

本地开发时这些环境变量不存在，`DISPLAY_VERSION` 为纯版本号，`BUILD_CHANNEL` 为 `"local"`。

4. **产物命名**：

```
ywcoder-${DISPLAY_VERSION}-${PLATFORM}.tgz
```

例：
- `ywcoder-1.0.2-dev.a3f2c1d-linux-x64.tgz`（dev build）
- `ywcoder-1.0.2-linux-x64.tgz`（release build）

5. **Release 触发时上传 asset**：

新增 step 使用 `softprops/action-gh-release@v2`，将本次 build 产物附加到已有的 GitHub Release（由 release-please 创建）上。

---

## 5. 失败模式与回滚

| 场景                                 | 影响                       | 应对                                                                 |
| ------------------------------------ | -------------------------- | -------------------------------------------------------------------- |
| release-please 误判 commit 类型      | 版本号 bump 不符合预期     | Release PR 是手工 merge，review 时即可发现，改 PR 内容即可           |
| `MACRO.VERSION` 被误改               | bridge 模式拒绝服务         | code review 拦截；可在 `build.ts` 加 assert: 必须 `=== "99.0.0"`     |
| `VERSION_SUFFIX` 注入失败            | 产物版本号变成纯 `1.0.1`   | 与现状无差异，不会造成新增故障                                       |
| tag 已存在重复创建                   | release-please 报错        | 删除冲突 tag 后重跑                                                  |
| 构建产物附加到 GitHub Release 失败   | Release 页缺产物            | 重跑 workflow 即可；release-please 不会因此回退版本号                |

---

## 6. 与现有代码的接触点

| 文件                                                          | 改动类型 | 说明                                                  |
| ------------------------------------------------------------- | -------- | ----------------------------------------------------- |
| `scripts/build.ts`                                            | 修改     | 新增 MACRO 注入；保留 `MACRO.VERSION = "99.0.0"`     |
| `src/main.tsx`（`.version()` 调用处）                          | 修改     | `--version` 输出格式扩展                              |
| `.github/workflows/release-please.yml`                        | 新增     | release-please action 配置                            |
| `.github/workflows/build-npm-linux-offline.yml`               | 修改     | 触发条件、channel 决策、产物命名                      |
| `.github/workflows/build-npm-windows-offline.yml`             | 修改     | 同上                                                  |
| `.github/workflows/build-zip-windows-offline.yml`             | 修改     | 同上                                                  |
| `package.json`（`version` 字段）                              | 接管     | 后续由 release-please 修改，开发者不再手改           |
| `CHANGELOG.md`                                                | 新增     | 由 release-please 自动维护                            |

**明确不动**：
- `src/utils/autoUpdater.ts`
- `src/bridge/envLessBridgeConfig.ts`、`src/bridge/bridgeEnabled.ts`（涉及 `MACRO.VERSION` 比较）
- `src/utils/releaseNotes.ts`
- `MACRO.VERSION` 的值

---

## 7. 实施顺序

| 阶段    | 内容                              | 风险 | 收益 |
| ------- | --------------------------------- | ---- | ---- |
| Phase 1 | S1 构建期元数据注入               | 低   | 高（立刻解决"看不出哪次 build"的痛点） |
| Phase 2 | S3：CI workflow 改造 + 产物命名   | 中   | 高（解决产物混淆 + 预发/正式区分）     |
| Phase 3 | S2：接入 release-please           | 中   | 中（自动化 bump，节省人工记忆）        |

Phase 1 完全独立，不依赖其它阶段，可单 PR 落地。Phase 2 与 Phase 3 顺序可对调，但 Phase 2 先做能更快验证"产物命名规范"是否符合内网搬运需求。

---

## 8. 待评审决策点

| # | 待定                                                                                              | 备注                                                                 |
| - | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Q1 | release-please 配置文件位置：`.release-please-config.json` 还是 inline workflow？                | 推荐前者，便于后续扩展                                                |
| Q2 | 是否在 `scripts/build.ts` 加 assert 强制 `MACRO.VERSION === "99.0.0"`？                          | 推荐加，防止误改                                                      |
| Q3 | `build-node-modules-windows.yml` 是否纳入双轨改造？                                              | 需先确认该 workflow 当前的实际用途                                    |

---

## 9. 后续可能的扩展（不在本期范围）

- **内网清单服务**：若内网架起共享文件服务器，可在客户端启动期读清单做版本提示；
- **`ywcoder update` 命令**：依赖上一条；
- **`RELEASE.json` manifest**：等有消费方再加；
- **多 channel（beta / stable）**：通过 release-please 的 `release-as` 与 channel 配置实现；
- **构建产物签名**：用 GPG / cosign 签产物，增强搬运信任。
