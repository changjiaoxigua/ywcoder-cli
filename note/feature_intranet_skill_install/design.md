# 内网 Skill 远程安装：设计方案

## 1. 概述

在 YwCoder 中新增 `/skill-install` slash command，连接内网已有的 skill 清单服务，实现：

1. 列出内网可用 skill
2. 下载 skill zip 包
3. 解压到指定 scope 的 skills 目录
4. 清理缓存并重新加载，使 skill 立即可用
5. 记录安装信息，支持后续更新

## 2. 内网清单字段扩展

现有 `/Users/sijia/code/git_program/yw-devhub/skills.json` 字段基本可用，建议新增/明确以下字段：

| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `id` | string | 是 | skill 唯一标识，也是安装后的目录名 |
| `name` | string | 是 | 展示名称 |
| `description` | string | 否 | 展示描述 |
| `tags` | string[] | 否 | 标签，用于列表过滤 |
| `version` | string | 是 | 版本号，用于更新比较 |
| `updatedAt` | string | 否 | 更新时间，展示用 |
| `filename` | string | 是 | zip 文件名（保留，用于日志和展示） |
| `downloadUrl` | string | **新增/必需** | zip 包完整下载地址 |
| `entryDir` | string | **新增/可选** | zip 解压后 skill 入口目录名，默认与 `id` 相同 |
| `sha256` | string | **新增/可选** | zip 包完整性校验值 |
| `minYwcoderVersion` | string | **新增/可选** | 最低 YwCoder 版本要求 |
| `scope` | string | **新增/可选** | 推荐安装 scope：`user` / `project`，默认 `user` |
| `contact` | string | 否 | 维护人 |
| `source` | string | 否 | 源码地址 |

### 示例条目

```json
{
  "id": "architecture-diagram",
  "name": "Architecture Diagram Generator",
  "description": "根据文字描述生成系统架构图，输出为独立的 HTML+SVG 文件",
  "tags": ["架构设计", "可视化", "文档"],
  "version": "1.1",
  "updatedAt": "2026-05-15",
  "filename": "architecture-diagram.zip",
  "downloadUrl": "http://内网服务器/skills/architecture-diagram.zip",
  "entryDir": "architecture-diagram",
  "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "scope": "user",
  "contact": "xxx",
  "source": "https://github.com/Cocoon-AI/architecture-diagram-generator"
}
```

### `downloadUrl` 与 `filename` 的关系

- `downloadUrl` 是客户端实际下载地址，必须完整可访问。
- `filename` 保留用于展示和日志，不要求与 URL 文件名一致。
- 如果某条目只有 `filename` 没有 `downloadUrl`，则无法安装，列表中标记为"仅查看"。

## 3. 配置

### 3.1 `skillhubUrl`

内网 skill 清单地址通过 `settings.json` 中的 `skillhubUrl` 字段配置，支持所有 settings scope：

| Scope | 位置 |
|------|------|
| user | `~/.ywcoder/settings.json` |
| project | `$project/.ywcoder/settings.json` |
| local | `$project/.ywcoder/settings.local.json` |
| managed | 由组织统一配置 |

示例（第一版建议直接写内网 IP）：

```json
{
  "skillhubUrl": "http://10.x.x.x/skills.json"
}
```

环境变量 `YWCODER_SKILLHUB_URL` 可作为最高优先级覆盖。未配置任何地址时，命令提示用户在 settings.json 中设置 `skillhubUrl`。

## 4. 命令设计

### 4.1 命令形式

```text
/skill-install                              # 进入交互选择界面
/skill-install <id>                         # 直接安装指定 skill，默认 user scope
/skill-install <id> --scope project         # 安装到项目级 skills 目录
/skill-install <id> --scope local           # 安装到项目本地覆盖目录
/skill-install --list                       # 仅列出可用 skill，不安装
/skill-install --update <id>                # 更新指定 skill
/skill-install --update-all                 # 批量更新所有已安装 skill
```

### 4.2 参数解析

- `<id>`：skill 在清单中的 `id` 字段。
- `--scope`：可选，默认 `user`。可选值 `user` / `project` / `local`。
- `--list`：只展示清单，不安装。
- `--update <id>`：检查版本，若清单版本高于本地则下载覆盖。
- `--update-all`：遍历所有已记录的内网 skill，批量更新。

### 4.3 输出示例

```text
$ /skill-install architecture-diagram --scope project
✓ 已安装 architecture-diagram v1.1 到 project scope（$project/.ywcoder/skills/architecture-diagram/）
  运行 /skills 查看已加载 skill
```

## 5. 安装流程

```
用户输入 /skill-install [id] [--scope user|project|local]
        │
        ▼
读取 skillhubUrl（环境变量 > settings.json）
        │
        ▼
未配置 ──► 提示用户在 settings.json 中配置 skillhubUrl 并退出
        │
        ▼
fetch skills.json（超时 5s，失败静默/提示）
        │
        ▼
未提供 id ──► 进入交互列表（按名称/标签过滤）
        │
        ▼
根据 id 找到清单条目
        │
        ▼
校验 minYwcoderVersion（若配置），不满足则提示
        │
        ▼
下载 zip 到临时文件（超时 30s，可配置）
        │
        ▼
校验 sha256（若配置），失败则删除并提示
        │
        ▼
解压 zip 到临时目录
        │
        ▼
移动到目标 skills 目录
  user  → ~/.ywcoder/skills/<id>/
  project → $project/.ywcoder/skills/<id>/
  local → $project/.ywcoder/skills/<id>/（写入 settings.local）
        │
        ▼
清理 skill 缓存、触发重新加载
        │
        ▼
写入/更新安装记录 ~/.ywcoder/skills-installed.json
        │
        ▼
输出成功信息
```

### 5.1 目标目录选择

复用现有工具：

- `user` scope：`src/skills/loadSkillsDir.ts` 中的 `getSkillsPath('userSettings', 'skills')`
- `project` scope：`getSkillsPath('projectSettings', 'skills')`
- `local` scope：`getSkillsPath('localSettings', 'skills')`

`local` 与 `project` 的物理目录相同，区别在于是否写入 `settings.local.json` 做显式覆盖。首期可统一按 `project` 处理，`local` 后续再细化。

### 5.2 zip 包结构约定

推荐结构：

```
architecture-diagram.zip
└── architecture-diagram/          # entryDir，与 id 一致
    └── SKILL.md
```

也允许扁平结构：

```
architecture-diagram.zip
└── SKILL.md
```

解压逻辑：

1. 若 zip 根目录只有一个目录，且 `entryDir` 未配置，则自动使用该目录作为入口。
2. 若 zip 根目录直接包含 `SKILL.md`，且 `entryDir` 未配置，则把 zip 内容整体移到 `<id>/` 下。
3. 若配置了 `entryDir`，则以该目录为入口，拷贝到 `<id>/` 下。

## 6. 更新机制

### 6.1 安装记录

在 `~/.ywcoder/skills-installed.json` 中记录：

```json
{
  "version": 1,
  "skills": {
    "architecture-diagram": {
      "installedVersion": "1.1",
      "installedAt": "2026-08-06T10:00:00Z",
      "scope": "project",
      "installPath": "/path/to/project/.ywcoder/skills/architecture-diagram",
      "sourceId": "architecture-diagram",
      "downloadUrl": "http://内网服务器/skills/architecture-diagram.zip"
    }
  }
}
```

### 6.2 更新流程

`/skill-install --update <id>`：

1. 读取安装记录。
2. 拉取清单，比较 `version`。
3. 若清单版本与本地相同或更低，提示"已是最新"。
4. 若清单版本更高，按安装流程重新下载解压，覆盖原目录，更新记录。

`/skill-install --update-all`：

1. 遍历安装记录中所有 `sourceId`。
2. 对每个 skill 执行单条更新逻辑。
3. 汇总更新结果输出。

## 7. 缓存与清理

- 下载的临时 zip 文件存放到 `~/.ywcoder/skills/tmp/`。
- 解压后的临时目录也放在该路径下。
- 安装成功或失败后都删除临时文件。
- 安装成功后调用 `clearSkillCaches()` 和 `addSkillDirectories()`，使 skill 立即生效。

## 8. 错误处理

| 场景 | 处理 |
|------|------|
| `skillhubUrl` 未配置 | 提示在 settings.json 中配置并退出 |
| 网络请求失败 | 提示"无法连接内网 skill 服务" |
| 清单 JSON 解析失败 | 提示"清单格式错误" |
| 找不到指定 id | 提示可用 skill 列表 |
| sha256 校验失败 | 删除临时文件，提示"下载内容校验失败" |
| zip 解压失败 | 提示"zip 包损坏" |
| 目标目录已存在同名 skill | 提示是否覆盖（交互模式）或加 `--force` 覆盖 |
| `minYwcoderVersion` 不满足 | 提示当前 YwCoder 版本过低 |

## 9. 安全与权限

- 所有网络请求使用 `AbortSignal.timeout()`，避免长时间挂起。
- sha256 校验防止传输过程中被篡改。
- 解压路径严格限制在目标 skills 目录内，禁止 zip 包内包含 `../` 等 traversal 路径。
- 不执行 zip 包内任何脚本。

## 10. 测试策略

- 单元测试 `src/utils/skills/skillInstaller.test.ts`：
  - mock `fetch` 返回清单 JSON
  - mock zip 下载（用内存 buffer 构造 zip）
  - 验证解压后目录结构
  - 验证 sha256 校验失败场景
  - 验证 `minYwcoderVersion` 拦截
  - 验证安装记录写入
- 集成测试：临时目录中跑完整安装流程，验证 `/skills` 能加载新 skill

## 11. 后续可扩展

- skill 依赖自动安装（`dependencies` 字段）
- 启动时检查 skill 更新并提示
- 内网 marketplace 自动发现
- zip 包 gpg/cosign 签名验证
