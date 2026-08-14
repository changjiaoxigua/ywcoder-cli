# 内网 Skill 远程安装：实施方案（方案一 · 修订版）

> **定位**：本文取代 `design.md`，是 `/skill-install` 的实施依据。
> 与 `design-option2-plugin-http-zip.md`（复用 plugin 机制）二选一。
>
> **修订说明**：本版在轻量版基础上收敛了原子性、来源身份、卸载安全与校验边界。
> 设计优先级按以下顺序，行数不是目标：
>
> 1. 不丢失已有 skill
> 2. 不越界写入或删除
> 3. 不绕过组织策略
> 4. 失败后可重试、可恢复
> 5. UI 与磁盘最终状态一致

---

## 1. 已确认决策

以下决策已定，实现时不再讨论：

| # | 决策 | 理由 |
|---|---|---|
| D1 | 独立 `/skill-install` 入口，不改造 plugin/marketplace | 内网只有静态 zip 分发 |
| D2 | 只有 `user` / `project` 两个 scope，无 `local` | settings 有 local 层（`settings.local.json`），但 **skills 没有对应的目录概念**：加载器只读 managed / `~/.ywcoder/skills` / cwd 向上各级 `.ywcoder/skills`（`loadSkillsDir.ts:728-730`）。`getSkillsPath('localSettings')` 也无对应分支，返回空串（`:80-97`） |
| D3 | 每个 skill 目录内一个 `.ywcoder-source.json`，不做集中安装记录 | 消除并发写冲突、多 scope 主键设计、孤儿记录三类问题 |
| D4 | 安装即更新，不实现 `--update` / `--update-all` | 同一条代码路径 |
| D5 | 更新判定 = `version` 不同 **或** `sha256` 不同；不引入 semver 高低比较 | 清单里的 `1.1` 不是合法 semver；sha256 是比 version 更可靠的变更判据（version 可能忘记 bump） |
| D6 | 原子切换：staging → 校验 → 换出旧目录 → 换入新目录 → 删旧 | 失败不得破坏已安装内容 |
| D7 | staging / backup 位于 skills 根的**兄弟目录**，不在 skills 根内 | skills 根下任何目录都会被 `findSkillMarkdownFiles` 加载为 skill（无 dot 过滤），且触发 watcher |
| D8 | 最终目录名只取清单中经校验的 `id`，不取 zip 内目录名 | 保证 slash 命令名可控 |
| D9 | 不读 `SKILL.md` frontmatter 的 `version` 作为发布版本 | 内容作者所写，不保证存在或与发布版本一致 |
| D10 | 配置只来自 `policySettings` / `userSettings`，**不做环境变量** | project/local settings 是仓库内容，不能控制可执行内容的安装源；团队统一要求配置写进 settings 文件。将来要加环境变量是一行的事 |
| D11 | 复用 `utils/dxt/zip.ts` 的解压与防护、`axios` 的代理/证书链路 | 已有实现更完备 |
| D12 | 成功后调 `clearCommandsCache()` + `resetSentSkillNames()`，不调 `addSkillDirectories()` | 后者是项目内动态发现专用，会错标 source 且被 projectSettings 门控 |
| D13 | `--remove` 只作用于有合法 sidecar 的目录，无 `--force` 变体；拒绝时**打印实际路径**供手动删除 | 避免命令成为任意目录删除入口，同时不挡路 |
| D14 | 不跟随 HTTP 重定向 | 静态文件服务无需重定向，禁用可消灭"重定向到非法协议"整类问题 |
| D15 | 不加并发安装锁 | 原子 rename 已保证无损坏状态；两会话同装同一 skill 为最后写入者生效 |
| D16 | headless（`-p`）下不提供本命令 | `local-jsx` 不在非交互命令列表（`main.tsx:2616`）；装机脚本直接解压即可 |
| D17 | **直接消费现有 `skills.json`**（顶层数组），服务端零改动 | 实际清单字段已够用；清单与 zip 地址均由 hub 根派生（§3.2） |
| D18 | zip 结构判定三条规则，兼容存量两种形态 | 存量包实测同时存在"单顶层目录"与"根即 SKILL.md"两种，见 §3.3 |
| D19 | 不做 downloadUrl 与 hub 的同源限制与提示 | 防护弱、会阻断"清单在 A、文件服务在 B"的部署；当前维护者单一，风险可控 |
| D20 | settings 字段定名 `ywdevhubUrl`，语义为 **hub 根地址**；资源类型靠清单路径约定区分（`skills.json`，将来 `tools.json`） | hub 内将来会有 skill 以外的资源（工具更新包等）；信任边界在 hub 级（§9.4），按资源类型拆 key 没有对应的信任差异 |

---

## 2. 命令面

```text
/skill-install                     列出内网 skill，交互选择后安装      ← 主路径
/skill-install --project           同上，但以项目级视角列出并装到项目级 skills 目录
/skill-install <id>                安装 / 更新（幂等）
/skill-install <id> --project      装到项目级 skills 目录
/skill-install <id> --force        覆盖来源未知的同名目录
/skill-install --remove <id>       卸载（user scope）
/skill-install --remove <id> --project   卸载（project scope）
```

### 2.1 参数解析

实现为**无 React 依赖的纯函数** `parseSkillInstallArgs(raw: string)`，独立单测。

必须处理并报出明确错误：

- 重复 flag（`--project --project`）
- 未知 flag
- `--remove` 缺参数
- 同时出现安装 id 与 `--remove`
- `--force` 与 `--remove` 同时出现（拒绝，见 D13）
- id 以 `-` 开头，或含 `/` `\` `:` 等路径字符
- 多余的位置参数

### 2.2 scope 解析

- 不带 `--project` → user scope，目标 `getSkillsPath('userSettings', 'skills')`
- 带 `--project` → project scope，目标 `getSkillsPath('projectSettings', 'skills', cwd)`

列表形态同样由 `--project` 决定视角：扫描哪个 skills 根的状态、选中后装到哪一级目录。
列表 Dialog 标题需标明"用户级 / 项目级"；项目级列表需在 footer 提示内容将随仓库提交（§8.3）。

**所有面向用户的输出必须打印 `getSkillsPath()` 的真实返回值**，不得硬编码 `.ywcoder` 或 `.claude`
——项目配置目录名受编译期 flag `MIGRATE_PROJECT_CONFIG` 门控（`projectConfigDir.ts`）。

`--remove` 的 scope 与安装一样由 `--project` 决定（缺省 user）；**不做跨 scope 回退**——
user 找不到时不得自动去 project 找。

---

## 3. 清单

### 3.1 直接消费现有 `skills.json`（服务端零改动）

现网清单（`yw-devhub/skills.json`）是**顶层数组**，字段已够用：

```json
[
  {
    "id": "architecture-diagram",
    "name": "Architecture Diagram Generator",
    "description": "根据文字描述生成系统架构图，输出为独立的 HTML+SVG 文件",
    "tags": ["架构设计", "可视化", "文档"],
    "version": "1.1",
    "updatedAt": "2026-05-15",
    "filename": "architecture-diagram.zip",
    "contact": "xxx",
    "source": "https://github.com/Cocoon-AI/architecture-diagram-generator"
  }
]
```

| 字段 | 必需 | 用途与校验 |
|---|---|---|
| `id` | 是 | 目录名 + slash 命令名。`/^[a-z0-9][a-z0-9._-]*$/i`，长度 ≤ 64 |
| `version` | 是 | 非空，长度 ≤ 64。参与更新判定（D5）与列表展示 |
| `filename` | 是（提供 `downloadUrl` 时可缺） | zip 文件名，用于拼接下载地址（§3.2） |
| `sha256` | 否 | **未来字段**，现网暂无。存在则校验完整性并参与更新判定 |
| `downloadUrl` | 否 | **未来字段**，存在则覆盖 §3.2 的拼接规则 |
| `name` `description` `tags` `updatedAt` `contact` `source` | 否 | 仅展示，**不做长度校验，渲染时截断** |

**清单级校验**：

- 响应体 ≤ 2 MB（`maxContentLength`）
- 条目数 ≤ 500，超出截断并警告
- `id` 重复 → **保留第一条并警告**，不拒绝整份清单
- 单条字段非法（如 id 不合规、缺 `filename` 且缺 `downloadUrl`）→ 该条标记"仅查看"不可选中，
  **不阻断其余条目**

不做 downloadUrl 与 hub 的同源校验或提示（D19）。

### 3.2 清单与下载地址派生

`ywdevhubUrl` 是 hub 根地址，清单与 zip 都按固定路径约定从它派生：

```
hubRoot       http://10.x.x.x/yw-devhub/
清单地址      new URL('skills.json', hubRoot)         → http://10.x.x.x/yw-devhub/skills.json
下载地址      new URL('skills/' + filename, hubRoot)  → http://10.x.x.x/yw-devhub/skills/architecture-diagram.zip  <!-- pr-scan:ignore executable-download-link —— 文档示例地址 -->
```

将来其他资源类型走各自的清单约定（如 `tools.json`），不新增 settings 字段（D20）。

**hubRoot 必须先归一化为以 `/` 结尾再拼接。** `new URL()` 会替换掉 base 的最后一段路径：
`http://10.x.x.x/yw-devhub`（无尾斜杠）拼 `skills.json` 会得到 `http://10.x.x.x/skills.json`，
静默指到错误位置。

条目若提供 `downloadUrl` 则**优先使用**，为将来 zip 换位置留出口子（约 3 行）。

最终地址无论来自拼接还是 `downloadUrl`，都必须通过 §9.3 的协议与 userinfo 校验。

### 3.3 zip 结构：三条判定规则

存量包实测存在两种形态，客户端两种都要支持：

| 包 | 形态 |
|---|---|
| `architecture-diagram.zip` | 单顶层目录：`architecture-diagram/SKILL.md` |
| `docx-skill` / `xlsx-skill` / `pdf-skill` / `pptx-skill` | 根即 `SKILL.md`，另有 `scripts/` 等目录 |
| `understand-anything.zip` | 根有 `SKILL.md`，另有 8 个子目录各带一个 `SKILL.md`（多 skill 包） |

判定规则，按顺序：

1. **根目录有 `SKILL.md`** → 整包内容原样放进 `<id>/`
2. 否则**恰好一个顶层目录且其下有 `SKILL.md`** → 剥掉这层，其内容放进 `<id>/`
3. 否则报错，错误信息列出实际的顶层条目

**多 skill 包无需特殊处理。** 按规则 1 安装后，加载器会自动按相对路径生成命名空间
（`getSkillCommandName` + `buildNamespace`，`loadSkillsDir.ts:611-631`）：

```
~/.ywcoder/skills/understand-anything/SKILL.md                  → /understand-anything
~/.ywcoder/skills/understand-anything/understand-chat/SKILL.md  → /understand-anything:understand-chat
~/.ywcoder/skills/understand-anything/understand-diff/SKILL.md  → /understand-anything:understand-diff
```

> 备注：`understand-anything.zip` 根目录的 `SKILL.md` 与 `understand/SKILL.md` 字节数相同（45658），
> 安装后会得到两个内容相同的 skill。属于打包冗余，不影响功能，如需消除应在上传侧处理。

zip 内其他文件（脚本、资源、`.git/`、`node_modules/`）**原样落盘不过滤**：skill 本可携带脚本资源
（`${CLAUDE_SKILL_DIR}` 占位符即为此存在，`loadSkillsDir.ts:359-366`），客户端不该猜哪些该删。
体积异常由 `unzipFile` 的上限兜底。

---

## 4. 配置

```jsonc
// ~/.ywcoder/settings.json
{ "ywdevhubUrl": "http://10.x.x.x/yw-devhub/" }
```

**统一命名**：settings 字段 `ywdevhubUrl`，值是 **hub 根地址**（不是清单文件地址；清单路径是约定，见 §3.2）。README 中的旧名 `YWCODER_INTRANET_SKILLS_INDEX_URL` 作废。

**优先级**：`policySettings` > `userSettings`。

**不做环境变量**（D10）：团队统一要求配置写进 settings 文件，少一条来源少一处解释成本。
将来若需要，接一行 `getYwCoderEnv('YWDEVHUB_URL')` 置于最高优先级即可。

**禁止读取 `projectSettings` / `localSettings`。** 实现上不能用 `getInitialSettings()`
（那是合并结果，含 project/local），必须用 `getSettingsForSource('policySettings')` 与
`getSettingsForSource('userSettings')` 分别取（`settings.ts:314`）。

理由：project/local settings 属于仓库内容。若 clone 来的仓库能指定安装源，等于开放了远程代码执行入口。
这条同时是"不必每次弹确认框"的前提——信任在配置 hub 地址那一刻建立。

`SettingsSchema`（`types.ts:257`）新增可选 `ywdevhubUrl: z.string().url().optional()`。
顶层是 `.passthrough()`（`types.ts:1094`），不加也能跑，但加了才有类型与校验。

未配置时的提示需给出完整路径与示例 JSON。

---

## 5. 目录布局

| 用途 | user scope | project scope |
|---|---|---|
| 安装目标 | `~/.ywcoder/skills/<id>/` | `<projectConfigDir>/skills/<id>/` |
| staging / backup | `~/.ywcoder/skills-staging/` | `<projectConfigDir>/skills-staging/` |

staging 根是 skills 根的**兄弟目录**，两点原因：

1. **同一文件系统**，`rename()` 可用，无 EXDEV。
2. **不在 skills 根内**——skills 根下的任何目录都会被 `findSkillMarkdownFiles` 递归加载为 skill
   （`loadSkillsDir.ts:476-498`，无 dot 前缀过滤），且被 chokidar 监听
   （`skillChangeDetector.ts:122-127` 仅忽略 `.git`）。把 staging 放进去会让半成品变成可见 skill
   并在写入过程中反复触发 reload。

staging 内使用两个路径：`<staging>/<id>.new/` 与 `<staging>/<id>.old/`。

**staging 是临时目录，用完即删 —— 连目录本身一起删。** 稳态下磁盘上不存在
`skills-staging/`；只有进程被强杀（Ctrl+C、崩溃）才会残留，由下次运行的第一步清理（§6.2）。

因此 project scope 下它通常不会出现在 `git status` 里。极端情况下（安装过程中被中断）
可能残留数秒，内网使用文档可提一句将 `skills-staging/` 加入 `.gitignore`，但非必须。

---

## 6. 安装流程

```
 1. 解析并校验 id                    → 正则 + 长度
 2. 策略检查                         → §9.1，不通过直接拒绝
 3. 解析目标路径与 staging 路径
 4. 路径逃逸校验                     → §9.2（含 realpath）
 5. 清理 / 恢复遗留 staging          → §6.2
 6. 读取目标目录现状                 → 三态判断（§7）
 7. 拉清单                           → 地址派生（§3.2）；5s 超时，≤2MB，校验（§3.1）
 8. 覆盖语义判定                     → §7.2，必要时二次确认或要求 --force
 9. 下载 zip                         → 60s 超时，≤64MB，maxRedirects=0
10. sha256 校验（若清单提供）         → 不匹配立即失败，不落盘
11. unzipFile 到内存                 → 路径穿越 / zip bomb / 体积防护
12. 结构校验与剥层                   → §3.3
13. 写入 <staging>/<id>.new/         → 逐文件 + parseZipModes 恢复 +x
14. 写 sidecar 到 <staging>/<id>.new/
15. 切换前复核                       → <id>.new/SKILL.md 存在且 sidecar 可解析
16. 若目标存在：rename(target → <staging>/<id>.old)
17. rename(<staging>/<id>.new → target)
      ↳ 失败 → rename(<id>.old → target) 回滚，报错退出
18. rm -rf <staging>/<id>.old
19. clearCommandsCache() + resetSentSkillNames()   ← 只在 17 成功后执行
20. 输出实际路径 / 版本 / 来源
```

### 6.1 关键约束

- 第 19 步**必须**在第 17 步成功之后，失败路径上不得刷新缓存（否则 UI 与磁盘状态不一致）。
- 第 16-17 步之间是唯一的不一致窗口（目标目录短暂不存在），毫秒级，且第 17 步失败可回滚。
- 任一步失败：已安装的旧版本保持原样；staging 残留由下次运行的第 5 步清理。

### 6.2 遗留恢复规则

安装开始时按顺序处理：

| 磁盘状态 | 含义 | 处理 |
|---|---|---|
| 存在 `<id>.new` | 上次死在写入阶段 | 直接 `rm -rf` |
| 存在 `<id>.old` 且目标**不存在** | 上次死在 16 与 17 之间 | `rename(<id>.old → target)` 恢复，然后继续本次安装 |
| 存在 `<id>.old` 且目标存在 | 上次死在 18（切换已成功） | 直接 `rm -rf` |

### 6.3 网络

统一用 `axios`（全局拦截器已处理 `HTTP(S)_PROXY` / `NO_PROXY` / mTLS / 自签 CA，`utils/proxy.ts:352`）。
不用裸 `fetch`——undici 不读这些环境变量，这是内网"浏览器能开、CLI 连不上"类报障的主要来源。
参考实现：`officialMarketplaceGcs.ts:107-150`。

请求参数：`responseType: 'arraybuffer'`、`maxRedirects: 0`、`timeout`、`maxContentLength`。
`maxContentLength` 同时覆盖 `Content-Length` 声明与实际接收字节数。

**日志与错误信息只输出 URL 的 origin + pathname**，不输出 query 与 fragment。

---

## 7. 目录状态与覆盖语义

### 7.1 三态

采用原子切换后，失败不会在正式路径留下半成品，因此状态无二义性：

| 目录状态 | 含义 |
|---|---|
| 不存在 | 全新安装 |
| 存在且 sidecar 合法（可解析、`schemaVersion` 受支持、`id` 与目录名一致） | 本工具管理 |
| 存在但无 sidecar / sidecar 损坏 / `id` 不匹配 | **来源未知**，由用户或其他工具管理 |

"来源未知"不再包含"上次安装中断"这层含义。

### 7.2 覆盖判定

| 现状 | version / sha256 | hubUrl | 行为 |
|---|---|---|---|
| 本工具管理 | 都相同 | 一致 | **不写磁盘**，返回"已是最新"（含实际路径与版本） |
| 本工具管理 | 任一不同 | 一致 | 直接更新 |
| 本工具管理 | 任意 | **不一致** | 提示来源已变化（展示新旧 hubUrl），交互模式需确认；非交互需 `--force` |
| 来源未知 | — | — | 交互模式二次确认；非交互需 `--force` |
| 不存在 | — | — | 直接安装 |

更新判定为 `version 不同 || sha256 不同`（D5）。清单未提供 `sha256` 时退化为 version-only 判定
（现网即此情况）；sidecar 里存过 sha256 而清单这次没给，视为"无法比对"，按 version 判定。

**`--force` 的语义必须在提示中写明**：会永久删除目标目录中的全部本地修改。

`--force` **不能绕过策略检查**（§9.1）。

"已是最新"只在本次成功获取清单且来源匹配时才可展示；清单获取失败时不得给出该结论。

---

## 8. sidecar 规范

### 8.1 格式

```json
{
  "schemaVersion": 1,
  "id": "architecture-diagram",
  "version": "1.1",
  "hubUrl": "http://10.x.x.x/yw-devhub/",
  "downloadUrl": "http://10.x.x.x/yw-devhub/skills/architecture-diagram.zip", <!-- pr-scan:ignore executable-download-link —— 文档示例地址 -->
  "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "installedAt": "2026-08-07T00:00:00.000Z"
}
```

文件名：`.ywcoder-source.json`，位于 skill 目录内。

- `schemaVersion`：当前为 `1`。读到不支持的值 → 视为**来源未知**，不自动覆盖、不允许 `--remove`。
- `hubUrl`：安装时实际使用的 hub 根地址（归一化、以 `/` 结尾后的值）。用于检测来源变化（§7.2）。
- `downloadUrl`：**最终使用的完整地址**（拼接结果或条目覆盖值）。因禁用重定向（D14），
  记录值即最终值，无需额外规范化。
- `sha256`：清单提供时才写入，缺失则省略该字段。参与更新判定（D5）。
- `installedAt`：ISO 8601，本地生成。

### 8.2 由谁生成

**由安装器在客户端生成**，写在 staging 内，随原子切换一起就位。zip 包不需要携带，
外网打包流程无需改动。

不放进 zip：这是客户端事实（从哪个 hub、按哪条清单、何时安装），不该由内容发布方声明。
不读 `SKILL.md` frontmatter 的 `version`（D9）。

sidecar **不是唯一的完整性依据**：切换前仍需验证 `SKILL.md` 存在（第 15 步）。

### 8.3 加载器与仓库

skill 加载器不会把它当内容：`findSkillMarkdownFiles` 只收集 `isSkillFile()` 匹配项，
正则为 `/^skill\.md$/i`（`loadSkillsDir.ts:572-574`）。

project scope 的 sidecar 会随项目提交进 git。这是有意的——团队成员 clone 后能看出来源与版本，
`/skill-install` 也能正确判断状态。需同时告知：**zip 解压出的全部内容同样会进入仓库**，
项目级安装前应确认这是期望行为。

---

## 9. 安全

### 9.1 组织策略

安装前检查，不通过**直接拒绝**，`--force` 不可绕过：

```ts
isRestrictedToPluginOnly('skills')          // pluginOnlyPolicy.ts:19-27
isSettingSourceEnabled('userSettings' | 'projectSettings')
```

策略锁定时，user 与 project 两个 scope 均拒绝安装。错误信息需说明：
组织策略要求 skills 通过 plugin 或受管来源提供，本命令已被禁用。

`--remove` **允许**删除本工具此前安装的目录（清理不等于加载授权），但同样只作用于
sidecar 合法的目录。

对无 sidecar / sidecar 非法的目录，拒绝删除并**打印实际路径**（D13）：

```
architecture-diagram 不是由 /skill-install 安装的，未执行删除。
如需手动删除：/Users/xxx/.ywcoder/skills/architecture-diagram
```

### 9.2 路径逃逸

三层校验，缺一不可：

1. `id` 正则白名单 + 长度上限（§3.1）
2. `resolve(target).startsWith(resolve(skillsRoot) + sep)`
3. **符号链接校验**：对已存在的 skills 根与目标目录取 `realpath`，再断言包含关系。
   仅做字符串 `startsWith` 无法处理 `~/.ywcoder/skills` 或 `~/.ywcoder/skills/<id>` 本身是
   符号链接的情况。目标路径链上存在指向 skills 根之外的符号链接时，拒绝安装并说明原因。

### 9.3 传输

| 项 | 策略 |
|---|---|
| 协议 | `https:` 默认允许；`http:` 作为受控内网的兼容能力保留，需在内网文档中说明风险 |
| 禁止 | `file:` `data:` 及其他一切非 http(s) 协议 |
| 禁止 | URL 携带 userinfo（`https://user:pass@host/...`） |
| 重定向 | 不跟随（`maxRedirects: 0`），遇到重定向报错并提示改用最终地址 |
| 体积 | 清单 ≤ 2 MB；zip ≤ 64 MB（压缩前）；解压后由 `unzipFile` 兜底 |
| 完整性 | sha256 匹配失败立即终止，不进入 staging |
| 日志 | 只输出 origin + pathname |

### 9.4 内容风险

SKILL.md 支持 `` !`…` `` 内联 shell（`loadSkillsDir.ts:377-399`）、frontmatter `hooks`
（→ `registerSkillHooks`，`processSlashCommand.tsx:871-877`）、`allowed-tools` 预授权。
**安装 skill 等价于安装可执行代码。**

sha256 只防传输损坏，不构成对内容的信任背书。真正的信任边界是"谁配置了 `ywdevhubUrl`"（D10）。
UI 需在选择前展示来源，并提示该风险（§11）。

---

## 10. 缓存刷新

成功切换后（且仅在成功后）调用：

```ts
clearCommandsCache()   // commands.ts:543，内部含 clearSkillCaches + plugin/skill 各级 memo
resetSentSkillNames()  // utils/attachments.ts
```

`--remove` 成功后同样调用；删除失败则不调用。

**不调 `addSkillDirectories()`**（D12）。

已知边界：`skillChangeDetector` 的 watcher 在 `initialize()` 时只监听**当时已存在**的目录
（`skillChangeDetector.ts:172-200` 逐个 `stat`，不存在则跳过），首次创建 `~/.ywcoder/skills/`
时不会有 watcher 事件，必须靠命令内主动刷新。若联调发现 slash 菜单未及时更新，
再考虑从 `skillChangeDetector` 导出 `notifySkillsChanged()`（一行，内部 `skillsChanged.emit()`）。

---

## 11. UI 规格

`type: 'local-jsx'`，`Dialog` + `Select`。参考实现：
`src/commands/rate-limit-options/rate-limit-options.tsx`（209 行的完整最小样例）。

### 11.1 列表状态

每条必须落入四类之一：

| 状态 | 展示 |
|---|---|
| 未安装 | `id  v1.1` |
| 已安装且版本一致 | `id  v1.1  (已安装)` |
| 已安装但版本不同 | `id  v1.1  (已安装 v1.0 → 可更新)` |
| 同名目录存在但来源未知 | `id  v1.1  (本地已存在，来源未知)` |

附加标记：

- 条目字段非法、无法拼出下载地址 → `(仅查看)`，**不可选中**
- 缺 `sha256` → `(未校验)` 风险标记。现网清单暂无 sha256，届时全部条目都会带该标记，
  可考虑改为在 Dialog footer 统一说明一次，避免每行重复噪音
- **不显示 downloadUrl 的 host**（D19）

### 11.2 其他

- Dialog 标题含 hub 地址；footer 提示"skill 可执行 shell 命令"
- 选中"来源未知"条目 → 二次确认，文案写明会永久删除本地修改
- 检测到来源变化 → 二次确认，展示新旧 hubUrl
- 安装完成 → 展示**实际安装路径**、版本、来源 hub
- `Select` 用 `visibleOptionCount` 滚动 + 数字键直选，**不做实时搜索过滤**

---

## 12. 模块划分与改动清单

### 12.1 新增文件

| 文件 | 职责 | 约束 | 估算行数 |
|---|---|---|---|
| `src/utils/skills/skillInstaller.ts` | 清单拉取与校验、hubRoot 归一化与地址派生、下载、解压与结构判定、staging、原子切换、恢复、sidecar 读写、已安装扫描 | **零 React 依赖** | 350–450 |
| `src/utils/skills/skillInstallArgs.ts` | 参数解析纯函数（6 类错误） | 零依赖 | 60–90 |
| `src/commands/skill-install/index.ts` | 命令注册（`type: 'local-jsx'`） | — | 20–30 |
| `src/commands/skill-install/skill-install.tsx` | Dialog + Select + 四态列表 + 两类二次确认 + 结果展示 | 只调用 installer，不含业务判定 | 180–250 |
| `src/utils/skills/skillInstaller.test.ts` | installer 单测（§13.2–13.8 共 47 个用例，需 mock axios、构造 zip、临时目录） | — | 350–500 |
| `src/utils/skills/skillInstallArgs.test.ts` | 参数解析单测（§13.1 共 6 组） | — | 50–80 |

### 12.2 修改文件（共约 3 行）

| 文件 | 改动 |
|---|---|
| `src/commands.ts` | import + COMMANDS 列表项，2 行（参照 `commands.ts:188,325` 的注册模式） |
| `src/utils/settings/types.ts` | `ywdevhubUrl: z.string().url().optional()`，1 行 |

### 12.3 复用不改

`utils/dxt/zip.ts`（解压防护，226 行）、`axios` 代理/证书链路（`utils/proxy.ts`）、
`pluginOnlyPolicy.ts`（策略检查）、`settings.ts` 的分源读取。

### 12.4 规模汇总

- 实现代码：**约 610–850 行**（净新增 4 个文件 + 修改 3 行）
- 测试代码：**约 400–580 行**
- 合计：**约 1000–1400 行**

估算基准：`rate-limit-options/index.ts` 19 行（注册样板）、`rate-limit-options.tsx` 209 行
（Dialog + Select 完整最小样例）、`officialMarketplaceGcs.ts` 216 行（清单拉取 + 下载参照）。

**这是估算不是目标**；与优先级冲突时以本文开头的五条优先级为准。

---

## 13. 测试计划

### 13.1 参数解析（纯函数）

1. 重复 flag / 未知 flag / 多余位置参数
2. `--remove` 缺参数
3. 安装 id 与 `--remove` 同时出现
4. `--force` 与 `--remove` 同时出现
5. `--project` `--force` 的合法组合
6. id 以 `-` 开头、含 `/` `\` `:` `..`

### 13.2 安装核心

7. 规则 1（根即 SKILL.md，如 `docx-skill`）：整包放进 `<id>/`
8. 规则 2（单顶层目录，如 `architecture-diagram`）：剥层后放进 `<id>/`
9. 规则 3：根无 SKILL.md 且顶层多目录 → 报错，文案列出实际顶层条目
10. 多 skill 包（如 `understand-anything`）：安装后加载出 `<id>` 与 `<id>:<子目录>` 系列，
    命名空间正确
11. sha256 不匹配 → 报错，**目标目录与 staging 均无残留**
12. sha256 缺失 → 跳过校验并标注"未校验"
13. zip 内含 `../` 条目 → 被 `unzipFile` 拒绝（回归）
14. 可执行位：zip 内 `+x` 文件解压后仍为 `+x`

### 13.3 原子性与恢复

15. staging 写入阶段失败 → **旧版本内容与 sidecar 完全不变**
16. `rename(new → target)` 失败 → backup 被恢复为 target，内容与失败前一致
17. 遗留 `<id>.new` → 下次运行清理后正常安装
18. 遗留 `<id>.old` 且目标不存在 → 恢复为目标
19. 遗留 `<id>.old` 且目标存在 → 清理 old，不影响目标
20. 同一 skill 两个进程并发安装 → 最终目录内容与某一次完整安装一致，无混合残骸
21. `clearCommandsCache()` / `resetSentSkillNames()` **仅在切换成功后**被调用（失败路径断言未调用）

### 13.4 状态与覆盖

22. 同版本 + 同来源 → 不写磁盘（断言 mtime 不变）
23. 版本不同 + 同来源 → 更新成功
24. hubUrl 变化 → 非交互下无 `--force` 时拒绝
25. 无 sidecar + 无 `--force` → 拒绝
26. 无 sidecar + `--force` → 覆盖并补写 sidecar
27. sidecar JSON 损坏 → 视为来源未知
28. sidecar `schemaVersion: 99` → 视为来源未知
29. sidecar 的 `id` 与目录名不一致 → 视为来源未知
30. user / project 同 id 同时存在 → 两侧状态各自识别正确，互不影响

### 13.5 卸载

31. 无 sidecar → 拒绝删除
32. sidecar 损坏 → 拒绝删除
33. sidecar id 不匹配 → 拒绝删除
34. user scope 不存在时**不**回退到 project
35. 删除失败 → 不刷新缓存，不留下"已卸载"假状态

### 13.6 配置与清单

36. `ywdevhubUrl` 写在 projectSettings / localSettings → **不被读取**
37. 优先级：policy > user
38. 直接喂入现网 `skills.json`（顶层数组，无 sha256/downloadUrl）→ 全部 6 条正常解析
39. 地址派生：hubRoot 有 / 无尾斜杠两种输入 → 均得到 `<hubRoot>/skills.json` 与 `<hubRoot>/skills/<filename>`
40. 条目提供 `downloadUrl` → 覆盖拼接结果
41. 清单重复 id → 保留第一条并警告
42. 清单超过 2 MB → 拒绝
43. zip 超过 64 MB → 拒绝
44. 最终地址为 `file://` / `data:` → 拒绝
45. 最终地址含 userinfo → 拒绝
46. 下载返回 302 → 报错（不跟随）
47. 条目 id 非法或无法拼出地址 → 标记仅查看，不阻断其余条目

### 13.7 路径安全

48. 目标父目录含符号链接且指向 skills 根之外 → 拒绝
49. skills 根本身是符号链接 → realpath 后仍在预期位置则允许
50. scope=project 的路径解析（`.ywcoder` / `.claude` 两种 flag 状态）

### 13.8 策略

51. `strictPluginOnlyCustomization` 锁定 skills → user / project 安装均拒绝
52. 策略锁定时 `--force` 不能绕过
53. 策略锁定时 `--remove` 仍可清理本工具安装的目录

CI：`bun run build`、`bun test --max-concurrency=1`、`bun run smoke`、
`bun run security:pr-scan -- --base origin/main`。

---

## 14. 验收标准

功能验收（内网实机）：

- [ ] A1 未配置 `ywdevhubUrl` 时给出含完整路径与示例的提示
- [ ] A2 `/skill-install` 能列出清单，四类状态显示正确
- [ ] A3 全新安装成功，`/skills` 与 slash 菜单**无需重启**即可看到新 skill
- [ ] A4 输出的安装路径与磁盘实际路径一致（project scope 下 `.ywcoder`/`.claude` 正确）
- [ ] A5 重复执行同一安装 → "已是最新"，磁盘未被改写
- [ ] A6 服务端升版本后再执行 → 成功更新，sidecar 版本同步更新
- [ ] A7 存量手工目录（无 sidecar）→ 二次确认后收编成功，此后走正常版本比对
- [ ] A8 `--remove` 成功卸载，slash 菜单同步消失
- [ ] A9 `--remove` 对手工目录被拒绝

健壮性验收：

- [ ] B1 下载中途断网 → 已安装的旧版本完好可用，staging 无残留（或下次运行自动清理）
- [ ] B2 sha256 故意改错 → 拒绝安装，旧版本完好
- [ ] B3 磁盘写满模拟 → 旧版本完好，报错信息可读
- [ ] B4 手工制造 `<id>.old` 遗留 + 删除目标 → 下次运行自动恢复
- [ ] B5 两个终端同时安装同一 skill → 最终目录为某一次的完整内容，无混合

安全验收：

- [ ] C1 `ywdevhubUrl` 写进项目 `.ywcoder/settings.json` → 不生效
- [ ] C2 清单里构造 `id: "../evil"` → 拒绝
- [ ] C3 `downloadUrl` 改为 `file:///etc/passwd` → 拒绝
- [ ] C4 zip 内构造 `../../evil.sh` → 拒绝
- [ ] C5 开启 `strictPluginOnlyCustomization` → 安装被拒且提示明确，`--force` 无法绕过

---

## 15. 已关闭的确认事项

| # | 事项 | 结论 |
|---|---|---|
| Q1 | sidecar 文件名 | 采用 `.ywcoder-source.json` |
| Q2 | 清单是否改用 marketplace.json 形状 | **否**。直接消费现有 `skills.json`，服务端零改动（D17） |
| Q3 | 内网 zip 结构 | **两种并存**：`architecture-diagram` 为单顶层目录，其余 5 个为根即 SKILL.md（其中 `understand-anything` 为多 skill 包）。客户端按 §3.3 三条规则全部兼容，无需重打包 |
| Q4 | project scope 内容随仓库提交 | **可接受**，与现有手工解压到 `$project/.ywcoder/skills/` 的行为一致，无需额外适配。唯一新增是几百字节的 sidecar |
| Q5 | 内网 HTTPS | 当前仅 HTTP，未来可能增加。设计上两者都支持，届时无需改代码 |
| Q6 | `--update-all` 等批量操作 | 一期不做 |
| Q7 | staging 的 `.gitignore` 提示 | 降级为可选。staging 用完即删，稳态下不存在（§5） |
| Q8 | 环境变量配置来源 | **不做**，只读 settings 文件（D10） |
| Q9 | downloadUrl 与 hub 同源提示 | **不做**（D19） |
| Q10 | settings 字段命名与语义 | 定名 `ywdevhubUrl`，值为 hub 根地址；资源类型靠清单路径约定区分（D20） |

### 剩余待确认

无阻塞项。以下为实现期可自行决定的细节：

- 现网清单全部缺 `sha256` 时，"未校验"标记逐行显示还是在 footer 统一说明一次（§11.1）
- 内网使用文档是否补充"建议为清单补 sha256 字段"的说明

---

## 16. 明确不做

- **headless（`-p`）支持**（D16）。装机脚本直接解压到 `~/.ywcoder/skills/` 即可。
- **环境变量配置**（D10）。只读 settings 文件。
- **列表内实时搜索**。规模够用为止。
- **版本兼容门禁**（`minYwcoderVersion`）。老客户端装到新 skill 是运行时报错而非安装时拦截。
- **semver 版本高低比较**（D5）。只判相同/不同。
- **并发安装锁**（D15）。原子切换已保证无损坏状态。
- **downloadUrl 与 hub 同源限制或提示**（D19）。
- **清单格式改造**（D17）。直接吃现有 `skills.json`。
- **zip 重打包**（D18）。客户端兼容存量两种结构。
- **`--remove --force`**（D13）。拒绝时打印路径供手动删除。
- **企业级集中管控**（禁用清单、多版本回滚、审计）。需要这些应选方案二。

---

## 17. 推进计划

设计已定稿（D1–D20、Q1–Q10 全部关闭，无阻塞项），以下按依赖顺序排布。
每阶段列出验证检查点，未通过不进入下一阶段。

### Phase 0 开工准备

1. 从 main 切 feature 分支 `feature/skill-install`（本仓库规矩：feature 分支先行，main 最后合并）
2. 确认现网 `yw-devhub/skills.json` 可访问，字段与 §3.1 表格一致（id/version/filename 齐全）
3. 确认 `strictPluginOnlyCustomization` 在内网策略中的现状（影响 §9.1 联调方式）

验证：分支就位；`curl` 清单返回 200 且为顶层数组。

### Phase 1 核心 installer（纯逻辑，不依赖 UI）

按"先纯函数、后副作用"顺序，每个文件伴随单测：

| 步 | 内容 | 验证（对应 §13） |
|---|---|---|
| 1 | `skillInstallArgs.ts` + 单测 | §13.1 全部 6 组 |
| 2 | `types.ts` 加 `ywdevhubUrl`；清单拉取 / 校验 / hubRoot 归一化与地址派生 | §13.6 |
| 3 | 下载 + `unzipFile` + 三条结构判定 | §13.2 |
| 4 | staging / 原子切换 / 遗留恢复 / sidecar 读写 | §13.3 |
| 5 | 三态扫描 / 覆盖判定 / `--remove` | §13.4、§13.5 |
| 6 | 路径逃逸三层校验 + 策略检查接入 | §13.7、§13.8 |

验证：`bun test --max-concurrency=1` 全绿。

### Phase 2 命令与 UI

1. `skill-install/index.ts` 注册（参照 `rate-limit-options`，19 行样板）
2. `skill-install.tsx`：四态列表、`(仅查看)` / `(未校验)` 标记、两类二次确认、结果展示
3. `commands.ts` 加入 COMMANDS（2 行）

验证：`bun run build` 通过；本地交互跑通"列表 → 选择 → 安装 → slash 菜单出现"。

### Phase 3 CI 与打包

按仓库 CI 清单全量执行：

```bash
bun run build
bun run smoke
bun test --max-concurrency=1
bun run security:pr-scan -- --base origin/main
```

验证：全部通过后由 CI 打出内网测试包。

### Phase 4 内网实机验收

用 CI 包装一台干净的内网机器，按 §14 逐项勾选：

- 功能验收 A1–A9
- 健壮性验收 B1–B5
- 安全验收 C1–C5

两个已知边界重点盯：

- **slash 菜单刷新**：首次创建 `~/.ywcoder/skills/` 时 watcher 不存在（§10），若 A3 失败，
  启用预案——从 `skillChangeDetector` 导出 `notifySkillsChanged()`（一行）
- **project scope 目录名**：`.ywcoder` / `.claude` 两种 flag 状态各验一次（A4）

验证：§14 全部勾完。

### Phase 5 合并与发布

1. 内网验收通过后合并 main（main 是最后一步，不提前）
2. 内网使用文档（随发布交付）：
   - 配置方法：`settings.json` 写 `ywdevhubUrl`，含完整示例
   - "安装 skill 等价于安装可执行代码"的风险说明（§9.4）
   - project scope 内容随仓库提交的告知（§8.3）
   - HTTP 明文风险说明（§9.3，内网当前无 HTTPS）
   - 可选：建议为清单补 `sha256` 字段（§15 剩余事项）
3. 发布后观察：安装类报障、`--remove` 拒绝文案是否足够指引手动删除

验证：合并后 main 分支 CI 绿；内网文档发出。

### 外部依赖与风险

| 项 | 说明 | 应对 |
|---|---|---|
| 现网清单持续可访问 | 本方案服务端零改动的前提（D17） | 无额外动作；若清单迁移只需用户改 `ywdevhubUrl` |
| 清单暂无 sha256 | 全部条目带"未校验"标记，更新判定退化为 version-only | 功能不阻塞；建议上传侧后续补字段 |
| 打包冗余（`understand-anything` 根与子目录同内容） | 安装后出现两个同内容 skill | 不阻塞；如需消除在上传侧处理（§3.3 备注） |
