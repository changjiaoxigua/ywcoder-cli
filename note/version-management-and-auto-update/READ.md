# Feature: 版本号管理与自动更新

## 1. 当前状态

Status: Planning
Date: 2026-05-11
Owner: changjiaoxigua
Branch: feature/brand-replacement

需求与设计文档已起草，待评审后进入实施。

## 2. 背景一句话

YwCoder 当前版本号在 `package.json` 中硬编码维护，构建产物缺乏可追溯标识，内网用户拿到 `.tgz` 后无法区分是哪一次 CI 构建，发版流程依赖人工记忆改版本号。

## 3. 实施场景（重要约束）

- **外网开发**：在 GitHub 上提交代码，触发 GitHub Actions 打包；
- **人工搬运**：将构建产物（`.tgz` / `.zip`）从外网拷贝到内网；
- **内网安装**：内网用户离线 `npm install -g xxx.tgz` 使用 YwCoder。

内网用户**不能**回连外网 npm registry / GitHub。所有"内网用户主动检查更新"的方案默认不可用。

## 4. 文档索引

| 文档                              | 状态     | 用途                                       |
| --------------------------------- | -------- | ------------------------------------------ |
| `01-requirements.md`              | Final    | 需求说明：目标、范围、约束、验收标准       |
| `02-design.md`                    | Final    | 设计方案：版本号体系、CI 双轨、产物命名    |
| `03-implementation-summary.md`    | Done     | 实施总结：改动清单、验证情况、遗留项       |

## 5. 范围预览

**做**：
- 引入 release-please 自动维护 `package.json` 版本号与 CHANGELOG
- 构建期注入 git sha / build id / build time，`ywcoder --version` 输出可追溯标识
- CI 双轨：feature 分支 push 产 dev build，tag push 产 release build
- 构建产物命名规范化：`ywcoder-<version>-<platform>.<ext>`

**不做**：
- 内网用户运行时自动检查更新（缺少内网清单服务，不强行做）
- `ywcoder update` 命令真正去拉新版本安装（同上）
- 改动 `MACRO.VERSION = "99.0.0"` 这个绕过 first-party min-version 的占位符
- 引入 changeset / semantic-release 等替代品
- `RELEASE.json` manifest（当前无消费方，等内网有清单服务时再加）

## 6. 关键风险

- release-please 接入后，仍存在的手工"合并 Release PR"动作必须有专人把关，否则会误发；
- 产物名变化会影响内网管理员的搬运脚本，需同步知会；
- 任何客户端启动期网络请求都必须 ≤1.5s 超时 + 静默失败，避免影响内网启动体验。
