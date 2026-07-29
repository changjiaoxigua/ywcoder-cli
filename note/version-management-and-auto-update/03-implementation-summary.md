# 03 - 实施总结：版本号管理与自动更新

**Status**: Done
**Date**: 2026-05-11
**Owner**: changjiaoxigua
**Branch**: feature/brand-replacement

---

## 1. 实施概览

三个 Phase 按设计文档顺序全部完成，所有改动在本地构建验证通过。

| 阶段 | 内容 | 状态 | 涉及文件 |
|------|------|------|----------|
| Phase 1 | S1 构建期元数据注入 | ✅ 完成 | `scripts/build.ts`、`src/entrypoints/cli.tsx`、`src/main.tsx` |
| Phase 2 | S3 CI 双轨改造 + 产物命名 | ✅ 完成 | 3 个 `build-*.yml` workflow |
| Phase 3 | S2 release-please 接入 | ✅ 完成 | 3 个新增配置/workflow 文件 |

---

## 2. Phase 1：构建期元数据注入

### 改动文件

| 文件 | 改动 |
|------|------|
| `scripts/build.ts` | 新增 `GIT_SHA`/`BUILD_ID`/`BUILD_CHANNEL` 计算逻辑；注入 3 个新 MACRO；`DISPLAY_VERSION` 改为拼接 `VERSION_SUFFIX`；构建日志输出完整元数据 |
| `src/entrypoints/cli.tsx` | `--version` 快速路径输出格式改为含 build id 和日期 |
| `src/main.tsx:3792` | Commander `.version()` 兜底路径同步更新格式 |

### 新增 MACRO

| 字段 | 本地默认值 | CI 示例 |
|------|-----------|---------|
| `MACRO.GIT_SHA` | 当前 HEAD short sha | `"a3f2c1d"` |
| `MACRO.BUILD_ID` | `"local"` | `"128"` |
| `MACRO.BUILD_CHANNEL` | `"local"` | `"dev"` / `"release"` |
| `MACRO.DISPLAY_VERSION` | `"1.0.1"`（纯版本号） | `"1.0.2-dev.a3f2c1d"` |

### `--version` 输出效果

```
# 本地开发
1.0.1 (YwCoder, build #local, 2026-05-11)

# CI dev build
1.0.2-dev.a3f2c1d (YwCoder, build #128, 2026-05-11)

# CI release build
1.0.2 (YwCoder, build #128, 2026-05-11)
```

### 注意事项

- `MACRO.VERSION` 保持 `"99.0.0"` 未动
- 发现 `src/entrypoints/cli.tsx` 有 `--version` 快速路径（绕过 Commander），Phase 1 实施时已同步修改

---

## 3. Phase 2：CI 双轨改造

### 改动文件

| 文件 | 改动 |
|------|------|
| `.github/workflows/build-npm-linux-offline.yml` | 触发条件、channel 决策、产物重命名、Release 上传 |
| `.github/workflows/build-npm-windows-offline.yml` | 同上 |
| `.github/workflows/build-zip-windows-offline.yml` | 同上（原来仅 `workflow_dispatch`，现扩展支持 push 触发） |
| `.github/workflows/build-node-modules-windows.yml` | **未改动**（仅打包 node_modules，不涉及版本元数据） |

### 触发矩阵（精简为两档）

| 触发源 | BUILD_CHANNEL | 版本号后缀 | 产物去向 |
|--------|---------------|-----------|----------|
| `feature/**` push | `dev` | `-dev.<sha>` | Actions Artifact |
| tag `v*` push | `release` | 无后缀 | GitHub Release |
| `workflow_dispatch` | `dev` | `-dev.<sha>` | Actions Artifact |

已按评审意见砍掉 `rc` channel，`main` push 不单独触发构建。

### 产物命名规范

```
# dev build
ywcoder-1.0.1-dev.d3e918c-linux-x64.tgz
ywcoder-1.0.1-dev.d3e918c-win-x64.tgz
ywcoder-1.0.1-dev.d3e918c-win-x64.zip

# release build
ywcoder-1.0.2-linux-x64.tgz
ywcoder-1.0.2-win-x64.tgz
ywcoder-1.0.2-win-x64.zip
```

### 关键实现细节

- "Determine build channel" step 使用 `shell: bash`（Windows runner 上也用 bash 做 channel 判断，避免 PowerShell 语法差异）
- `npm pack` 产出的 `dcywzc-ywcoder-*.tgz` 通过 `mv` 重命名为规范名称
- `permissions: contents: write`（从 `read` 升级，release 上传需要写权限）
- tag 触发时使用 `softprops/action-gh-release@v2` 上传产物到 GitHub Release

---

## 4. Phase 3：release-please 接入

### 新增文件

| 文件 | 用途 |
|------|------|
| `.github/workflows/release-please.yml` | 在 `main` push 时触发 release-please action |
| `.release-please-config.json` | release-please 配置（独立文件，便于扩展） |
| `.release-please-manifest.json` | 版本号起点记录，当前 `1.0.1` |

### 配置要点

- `release-type: node`：自动修改 `package.json` 的 `version` 字段
- `include-component-in-tag: false`：tag 格式为 `v1.0.2`（不带包名前缀）
- `bump-minor-pre-major: true`：1.x 阶段 `feat:` 仅 bump minor
- PR 标题 `chore: release v${version}`：避免 release-please 自身 commit 触发下一轮 bump

### CHANGELOG.md

项目根目录当前不存在 `CHANGELOG.md`，无需手动创建。release-please 首次运行并生成 Release PR 时会自动创建该文件。

### 端到端流程

```
feature 分支开发 → merge 到 main
    → release-please 自动开/更新 Release PR
        （修改 package.json version + 生成 CHANGELOG.md）
    → 手动 review + merge Release PR
        → release-please 自动打 tag v1.0.2 + 创建 GitHub Release
            → tag push 触发 build-*.yml workflow
                → 构建产物上传到 GitHub Release 页面
                    → 人工搬运到内网
```

---

## 5. 设计文档评审决策落地情况

| 决策点 | 结论 |
|--------|------|
| Q1 release-please 配置文件位置 | 采用独立 `.release-please-config.json` |
| Q2 build.ts 加 assert `MACRO.VERSION === "99.0.0"` | 本次未加，可后续补充 |
| Q3 `build-node-modules-windows.yml` 是否纳入双轨 | 不纳入，该 workflow 仅打包依赖 |

---

## 6. 验证情况

- ✅ 本地 `bun run build` 构建成功
- ✅ 本地 `bun run smoke` 通过
- ✅ `--version` 输出格式符合设计：`1.0.1 (YwCoder, build #local, 2026-05-11)`
- ✅ `MACRO.VERSION` 保持 `"99.0.0"`，bridge 模式不受影响
- ⏳ CI workflow 变更需 push 后在 GitHub Actions 上验证
- ⏳ release-please 需 merge 到 main 后验证首次 Release PR 生成

---

## 7. 遗留项

- build.ts 中 `MACRO.VERSION === "99.0.0"` 的 assert 守卫（设计文档 Q2 推荐加，本次暂未实施）
- release-please 生成的 CHANGELOG 为中文 commit message 直出，如需更好可读性需在 Release PR review 时手动调整
- 首次 merge 到 main 后需观察 release-please 是否正确创建 Release PR
