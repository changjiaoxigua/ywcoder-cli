# Feature: 内网 Skill 远程安装

## 1. 背景

内网已有 skill 集中上传页面，维护了一份类似 `/Users/sijia/code/git_program/yw-devhub/skills.json` 清单。当前用户需要登录网页手动下载 zip 包，再解压到 `~/.ywcoder/skills/` 或 `$project/.ywcoder/skills/` 目录，流程繁琐。

本功能让 YwCoder agent 启动后可以通过 `/skill-install` 命令直接浏览、下载、安装和卸载内网 skill，无需离开终端。

## 2. 文档索引

| 文档 | 状态 | 用途 |
| ---- | ---- | ---- |
| `design-option1-lite.md` | **当前实施依据** | 方案一修订版：自建 `/skill-install`，含已确认决策、验收标准、待确认事项 |
| `design-option2-plugin-http-zip.md` | 备选 | 方案二：给 plugin 新增 `http-zip` 来源，复用 marketplace 全套能力 |
| `design.md` | **已废弃** | 初版设计，已被 `design-option1-lite.md` 取代，仅作历史留存 |

方案一与方案二二选一。选型的关键前置问题见 `design-option2-plugin-http-zip.md` §11。

## 3. 一句话目标

新增 `/skill-install` slash command，读取内网 skill 清单，下载 zip 并原子安装到用户级或项目级 skills 目录，实现 skill 的"发现—安装—更新—卸载"闭环。

## 4. 范围（按方案一修订版）

**做**:

- 新增 `/skill-install` slash command（交互列表 + 直接安装）
- 支持 `--project` 切换到项目级，默认 user 级
- 支持内网 `skills.json` 索引
- 原子安装：staging 写入 → 校验 → 换出旧目录 → 换入新目录，失败保留旧版本
- 可选 sha256 完整性校验
- 安装后 skill 立即生效（清理缓存 + 重新加载）
- 每个 skill 目录内写 `.ywcoder-source.json` 记录来源与版本
- `--remove` 卸载（仅限本工具安装的目录）

**不做**:

- 不改造 plugin / marketplace 机制
- 不实现自动后台更新（用户主动触发）
- 不做 skill 依赖自动安装
- 不做 zip 包加密/签名
- 不做 `--update` / `--update-all` —— 安装本身即幂等更新
- 不做 `local` scope（skills 加载器没有 local 目录这一层）
- 不做集中式安装记录文件
- 不做 headless（`-p`）支持
- 不做 semver 版本高低比较 —— 只判相同/不同
- 不做环境变量配置来源
- 不改造清单格式、不重打包 zip

## 5. 关键约束

- 所有新增代码注释使用中文
- 优先复用既有实现：`utils/dxt/zip.ts`（解压与防护）、`axios` 全局代理链路、`commands.ts` 的缓存刷新
- **直接消费现有 `skills.json`，服务端零改动**；下载地址按 `new URL('skills/' + filename, hubUrl)` 拼接
- 清单地址通过 settings 的 `skillhubUrl` 配置，**只从 policySettings / userSettings 读取**，
  不读 project/local settings，不做环境变量
- 客户端兼容存量两种 zip 结构（单顶层目录 / 根即 SKILL.md），不要求重打包
- staging 与 backup 目录必须位于 skills 根的兄弟目录，不得放在 skills 根内；用完即删
- 缓存刷新只在原子切换成功后执行

## 6. 相关文件

- `src/commands.ts` — slash command 注册
- `src/commands/skills/` — 现有 skill 命令目录（`/skills`）
- `src/skills/loadSkillsDir.ts` — skill 加载、`getSkillsPath()`、缓存清理
- `src/utils/skills/skillChangeDetector.ts` — skill 目录监听与自动 reload
- `src/utils/dxt/zip.ts` — `unzipFile()` / `parseZipModes()`
- `src/utils/proxy.ts` — axios 代理 / mTLS / NO_PROXY
- `src/utils/settings/settings.ts` — `getSettingsForSource()`
- `src/utils/settings/pluginOnlyPolicy.ts` — `isRestrictedToPluginOnly()`
- `src/utils/projectConfigDir.ts` — 项目配置目录解析（受编译期 flag 门控）
- `src/commands/rate-limit-options/rate-limit-options.tsx` — `Dialog` + `Select` 的最小 UI 样例
- 内网清单：`/Users/sijia/code/git_program/yw-devhub/skills.json`
