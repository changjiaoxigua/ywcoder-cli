# 01 - 需求说明：版本号管理与自动更新

**Status**: Draft
**Date**: 2026-05-11
**Owner**: changjiaoxigua

---

## 1. 背景

### 1.1 现状

- `package.json` 中 `version` 字段（当前 `1.0.1`）由人手工维护，每次发版要记得改；
- `scripts/build.ts:14-15` 读取 `pkg.version` 注入到 `MACRO.DISPLAY_VERSION`（见 `scripts/build.ts:71`）；
- `scripts/build.ts:70` 将 `MACRO.VERSION` 写死为 `"99.0.0"`，仅用于绕过 first-party 的 `assertMinVersion` 等最小版本检查（参见 `src/utils/autoUpdater.ts:71`、`src/bridge/envLessBridgeConfig.ts:149` 等多处）；
- 现有 CI workflow（`.github/workflows/build-npm-linux-offline.yml` 等）在 `feature/brand-replacement` 分支 `push` 时触发，每次 push 都重新打包，**多次构建均标注同一个 `1.0.1`**，无法区分；
- 构建产物以固定名 `ywcoder-linux-offline` 等通过 Actions Artifact 暴露，命名中不带版本号；
- `src/utils/autoUpdater.ts` 中现有的自动更新链路指向 Anthropic 的 GCS bucket（`storage.googleapis.com/claude-code-dist-...`），对 fork 后的 `@dcywzc/ywcoder` 包**完全不生效**；
- 没有 `.changeset/` / `release-please.yml` / `semantic-release` 等任何自动版本管理工具；
- 没有 release / publish 类 workflow。

### 1.2 部署链路

```
[外网]  开发者本地  →  git push  →  GitHub Actions 打包  →  GitHub Artifact / Release
                                                                    │
                                                                    │ 人工 / 单向网闸搬运
                                                                    ▼
[内网]  管理员存放点（共享盘/U 盘） → 内网用户离线 npm install -g xxx.tgz
```

内网用户**不能**回连外网 npm registry / GitHub。

### 1.3 痛点

| #   | 痛点                                                                          | 影响等级 |
| --- | ----------------------------------------------------------------------------- | -------- |
| 1   | 同一个 `1.0.1` 版本号被反复构建多次，排障时无法定位用户跑的是哪次 build       | 高       |
| 2   | 发版需要手工改 `package.json` 的版本号，容易忘                                | 高       |
| 3   | 没有 CHANGELOG，发版后无法快速告诉内网用户"这一版改了什么"                    | 中       |
| 4   | 构建产物命名固定（`ywcoder-linux-offline`），内网共享盘上多版本并存时容易拿错 | 中       |
| 5   | 缺乏"预发 / 正式"语义，给内网测试的包和正式发版的包外观上一模一样             | 中       |

---

## 2. 目标

### 2.1 主目标

1. **G1 版本号自动化**：合并到 main 后，下一次发版的版本号由工具根据 commit 类型自动计算，开发者不再手改 `package.json`；
2. **G2 构建产物可追溯**：`ywcoder --version` 输出能精确定位到一次 CI 构建（含 git sha + build id）；
3. **G3 预发 / 正式语义清晰**：分支 push 出的 dev build 与 tag push 出的 release build，从产物名和版本号字符串就能直接区分；
4. **G4 CHANGELOG 自动维护**：每次发版同时自动生成 / 追加 CHANGELOG，可作为内网用户升级前的阅读材料。

### 2.2 次要目标

5. **G5 产物命名规范**：所有 CI 产物文件名包含版本号 + 平台，避免内网共享盘多版本并存时混淆。

---

## 3. 范围

### 3.1 In Scope

- 引入 release-please 维护版本号与 CHANGELOG；
- 修改 `scripts/build.ts` 注入 `GIT_SHA` / `BUILD_ID` / `BUILD_TIME` 等元数据；
- 修改 `ywcoder --version` 输出，展示可追溯标识；
- 改造现有 build workflow：
  - 触发条件：`feature/**` push + `tag v*` push；
  - 分支 push 产物版本号带 `-dev.<sha>` 后缀，tag push 产物为干净版本号；
  - 产物文件命名包含版本号和平台；
  - tag 触发时附加构建产物到 GitHub Release。

### 3.2 Out of Scope（明确不做）

- **不做客户端运行时自动检查更新**：内网无可达的版本清单地址，强行做会引入"启动期网络请求"的风险，且 ROI 低；
- **不做 `ywcoder update` 一键升级**：同上原因，且全局 npm 安装权限在内网用户机器上不一定具备；
- **不动 `MACRO.VERSION = "99.0.0"`**：这是绕过 first-party min-version 检查的占位符，改动会导致 bridge 模式被判定为"过旧"而拒绝服务；
- **不改 first-party `assertMinVersion` / 自动更新链路**：`src/utils/autoUpdater.ts` 保持现状，新机制完全独立；
- **不引入 npm publish**：当前没有公网发布需求；
- **不强制约定式提交（Conventional Commits）格式**：release-please 能从已有的 `feat:` / `fix:` 前缀工作，但不强制贡献者改习惯；
- **不做 `RELEASE.json` manifest**：当前没有消费方，等内网有清单服务时再加；
- **不做 `main` push 的 rc build**：单人开发流程中 rc 档没有实际消费场景。

---

## 4. 约束

### 4.1 技术约束

| #   | 约束                                                                     | 来源                                             |
| --- | ------------------------------------------------------------------------ | ------------------------------------------------ |
| C1  | `MACRO.VERSION` 必须保持 `"99.0.0"`，与 `MACRO.DISPLAY_VERSION` 严格分离 | first-party min-version 检查的占位策略           |
| C2  | 构建期注入逻辑必须在 `scripts/build.ts` 集中，不能散落到运行时代码       | 现有 macro 注入模式                              |
| C3  | 任何客户端启动期的外部请求都必须 ≤1.5s 超时 + 静默失败                   | 内网/离线环境的鲁棒性                            |
| C4  | 不能引入需要 publish 到公网的发布步骤                                    | 内网部署场景                                     |
| C5  | 构建产物大小不应明显增加                                                 | NPM 包瘦身已有的优化目标（参考 note 中相关文档） |

### 4.2 流程约束

- 开发模式：单人在 feature 分支开发，自测后合并到 main；
- 发版触发：合并到 main 后由 release-please 自动开 Release PR，手动 review 并 merge 后才真正发版；
- 构建环境：GitHub Actions（已有），Node 18.20、Bun 1.3.11。

---

## 5. 验收标准

| #   | 验收项                                                                                | 验证方式                          |
| --- | ------------------------------------------------------------------------------------- | --------------------------------- |
| A1  | feature 分支 push 后产物名形如 `ywcoder-1.0.2-dev.a3f2c1d-linux-x64.tgz`              | 检查 GitHub Actions Artifact 列表 |
| A2  | tag `v1.0.2` push 后产物名形如 `ywcoder-1.0.2-linux-x64.tgz` 且附在 GitHub Release 上 | 检查 Releases 页面                |
| A3  | `ywcoder --version` 输出形如 `1.0.2-dev.a3f2c1d (YwCoder, build #128, 2026-05-11)`    | 在新 build 上执行                 |
| A4  | 在 main 上有 `feat:` / `fix:` 类 commit 后，自动出现 release-please 维护的 Release PR | 观察 PR 列表                      |
| A5  | merge Release PR 后，`package.json` 版本号、`CHANGELOG.md` 自动更新                   | git diff                          |
| A6  | bridge 模式仍然可用（`MACRO.VERSION` 未被影响）                                       | 走一次 bridge 启动流程            |
| A7  | 构建产物大小相对当前基线变化 ≤2%                                                      | 对比 `npm pack --dry-run` 输出    |

---

## 6. 非目标 / 暂缓项

可作为后续迭代考虑，本期不做：

- **运行时检查更新**：未来如果内网搭起 Verdaccio 或共享文件服务器，再加上 banner 提示落后版本的逻辑；
- **`ywcoder update` 命令**：依赖上一条；
- **`RELEASE.json` manifest**：等有消费方再加；
- **多 release channel（stable/beta）**：当前用户群单一，无需求；
- **签名 / 校验**：内网搬运信任链由组织流程保证，不引入签名机制。

---

## 7. 相关参考

- `note/internal-model-config-gateway/` — 类似的 feature 文档夹组织格式
- `note/NPM-PACKAGE-OPTIMIZATION-Opus.md` — npm 包优化背景，约束 C5 的来源
- `note/PACKAGING_AND_INSTALL.md` — 现有打包/安装流程
- `scripts/build.ts` — 构建脚本，本次主要改动点之一
- `.github/workflows/build-npm-linux-offline.yml` 等 — 现有 CI workflow
- `src/utils/autoUpdater.ts` — first-party 自动更新链路，本次**不动**
