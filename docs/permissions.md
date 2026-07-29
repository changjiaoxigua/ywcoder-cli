# YwCoder 权限命令使用说明

YwCoder 在执行敏感操作（如修改文件、运行 Bash、调用 MCP 工具等）前，会根据当前**权限模式（Permission Mode）**和**预授权规则**决定是否询问、自动允许或拒绝。

---

## 一、权限模式

权限模式控制 YwCoder 如何处理工具执行请求。

| 模式                | 含义                                 | 典型用途                                  |
| ------------------- | ------------------------------------ | ----------------------------------------- |
| `default`           | 默认模式，敏感操作会弹窗询问         | 日常交互                                  |
| `acceptEdits`       | 自动接受文件编辑类权限               | 专注于代码审查，减少编辑确认              |
| `plan`              | 计划模式，执行前必须生成并确认计划   | 复杂改动前先规划                          |
| `dontAsk`           | 不弹窗询问；没有预授权则**直接拒绝** | 静默/批处理/CI 场景                       |
| `bypassPermissions` | 跳过所有权限检查（危险）             | 仅建议隔离沙箱、无网络环境                |
| `auto`              | 由 AI 分类器自动判断是否允许         | 需要 `TRANSCRIPT_CLASSIFIER` feature 开启 |

### 设置方式

#### 1. 命令行启动参数

```bash
# 使用默认模式
ywcoder --permission-mode default

# 自动接受编辑
ywcoder --permission-mode acceptEdits

# 计划模式
ywcoder --permission-mode plan

# 静默拒绝未授权操作
ywcoder --permission-mode dontAsk

# 跳过所有权限检查（危险）
ywcoder --dangerously-skip-permissions
```

#### 2. settings.json 中设置默认模式

```json
{
  "permissions": {
    "defaultMode": "dontAsk"
  }
}
```

`settings.json` 支持三个层级，后加载的覆盖先加载的：

- `~/.ywcoder/settings.json`：用户全局配置
- `<项目配置目录>/settings.json`：项目级配置（可提交到仓库）
- `<项目配置目录>/settings.local.json`：项目本地个人覆盖（通常 gitignore）

---

## 二、预授权规则

在 `dontAsk` 或 `default` 等模式下，可以通过 `permissions.allow` 提前允许某些工具或命令，避免每次询问。

### 规则语法

```json
{
  "permissions": {
    "allow": [
      "Read",
      "Bash(git:*)",
      "Bash(npm run test)",
      "Edit(\u003c项目配置目录\u003e/**)",
      "Write(/tmp/*)"
    ],
    "deny": ["Bash(rm -rf:*)"],
    "ask": ["Write(/etc/*)"]
  }
}
```

其中 `<项目配置目录>` 通常为 `.claude` 或 `.ywcoder`（取决于构建版本）。

| 规则类型 | 作用                             |
| -------- | -------------------------------- |
| `allow`  | 自动允许匹配的操作               |
| `deny`   | 自动拒绝匹配的操作               |
| `ask`    | 强制询问（即使模式本会自动允许） |

### 匹配规则

- **工具名匹配**：`"Read"` 允许所有 `Read` 操作
- **前缀通配**：`"Bash(git:*)"` 匹配所有以 `git` 开头的 Bash 命令
- **精确匹配**：`"Bash(npm run test)"` 仅允许这条命令
- **文件通配**：`"Edit(src/**/*.ts)"` 允许编辑匹配的文件

> 注意：`Bash` 或 `Bash(*)` 这种无限制规则会被视为过度宽泛，在 `auto` 等模式下可能被安全机制剥离。

---

## 三、CLI 参数与设置文件的优先级

决定最终权限模式时，YwCoder 按以下顺序尝试，取第一个可用模式：

1. `--dangerously-skip-permissions` → `bypassPermissions`
2. `--permission-mode <mode>` → 指定模式
3. `settings.json` 中的 `permissions.defaultMode` → 配置模式
4. 否则 fallback 到 `default`

如果组织策略或设置禁用了 `bypassPermissions`，即使传了 `--dangerously-skip-permissions` 也会被拒绝。

---

## 四、常用命令示例

### 1. 启动时进入静默拒绝模式

```bash
ywcoder --permission-mode dontAsk
```

### 2. 静默模式下允许 git 和 npm 命令

```bash
ywcoder --permission-mode dontAsk --allowed-tools Read "Bash(git:*)" "Bash(npm:*)"
```

### 3. 计划模式 + 自动接受编辑

```bash
ywcoder --permission-mode plan
```

在计划确认后，如需自动接受编辑可改：

```bash
ywcoder --permission-mode acceptEdits
```

### 4. 危险沙箱中跳过权限检查

```bash
ywcoder --dangerously-skip-permissions
```

> ⚠️ **警告**：`bypassPermissions` 模式下，所有文件读写、命令执行、MCP 调用等敏感操作均**无需人工确认**即可执行。启用前请务必做好代码版本管理（如 `git commit`）并对重要文件进行备份，防止误删或覆盖。
>
> 该模式**不支持在 root 或 sudo 环境下启用**。叠加系统最高权限运行可能导致不可控的大范围操作风险，因此 YwCoder 会在检测到 root/sudo 时直接拒绝启动。

---

## 五、常用 `permissions.allow` 配置参考

以下配置按风险由低到高排列，放在 `settings.json` 的 `permissions` 字段中即可。

> 注意：`Bash` 规则中，`Bash(ls:*)` 表示命令以 `ls` 开头并跟随任意参数（如 `ls -la`、`ls src/`），等价于日常写法 `Bash(ls *)`；`Bash(pip list)` 表示精确匹配整条命令。

### 1. 只读审查（最低风险）

适合查看代码、日志、依赖，不做任何修改：

```json
{
  "permissions": {
    "defaultMode": "default",
    "allow": [
      "Read",
      "Bash(git:*)",
      "Bash(git status)",
      "Bash(git log)",
      "Bash(git diff)",
      "Bash(git branch)",
      "Bash(git show)",
      "Bash(ls:*)",
      "Bash(find:*)",
      "Bash(pip list)",
      "mcp__playwright__navigate",
      "mcp__playwright__screenshot"
    ]
  }
}
```

### 2. 日常开发（推荐）

覆盖本项目常用的构建、测试与代码编辑操作：

```json
{
  "permissions": {
    "defaultMode": "default",
    "allow": [
      "Read",
      "Bash(git:*)",
      "Bash(bun install)",
      "Bash(bun run build)",
      "Bash(bun run test)",
      "Bash(bun run dev)",
      "Bash(bun run smoke)",
      "Bash(bun test)",
      "Bash(npm run test)",
      "Bash(npm run build)",
      "Bash(ls:*)",
      "Bash(find:*)",
      "Bash(pip list)",
      "Edit(src/**)",
      "Edit(scripts/**)",
      "Edit(package.json)",
      "Edit(tsconfig.json)",
      "Edit(docs/**)"
    ]
  }
}
```

### 3. 自动接受编辑

适合需要大量修改文件但希望保留对命令的询问：

```json
{
  "permissions": {
    "defaultMode": "acceptEdits",
    "allow": [
      "Read",
      "Edit",
      "Bash(git:*)",
      "Bash(bun run test)",
      "Bash(bun run build)"
    ]
  }
}
```

### 4. `dontAsk` 严格白名单（CI / 批处理）

未命中 `allow` 的操作会被直接拒绝，建议用 `deny` 兜底高危命令：

```json
{
  "permissions": {
    "defaultMode": "dontAsk",
    "allow": [
      "Read",
      "Edit(src/**)",
      "Edit(scripts/**)",
      "Edit(package.json)",
      "Edit(tsconfig.json)",
      "Edit(docs/**)",
      "Bash(git status)",
      "Bash(git add)",
      "Bash(git diff)",
      "Bash(git log)",
      "Bash(ls:*)",
      "Bash(find:*)",
      "Bash(pip list)",
      "Bash(bun run test)",
      "Bash(bun run build)",
      "Bash(bun run smoke)",
      "mcp__playwright__*"
    ],
    "deny": [
      "Bash(rm -rf:*)",
      "Bash(sudo:*)",
      "Write(/etc/*)",
      "Write(~/.ssh/*)"
    ]
  }
}
```

### MCP Playwright 说明

Playwright MCP 工具名格式为 `mcp__playwright__<tool>`，常见只读工具包括：

- `mcp__playwright__navigate`：打开页面
- `mcp__playwright__screenshot`：截图
- `mcp__playwright__get_text`：获取页面文本
- `mcp__playwright__evaluate`：执行页面脚本

如需放行整个 Playwright server，可使用 `mcp__playwright__*`；如需仅放行只读操作，建议单独列出上述工具。

### 关于 `Bash(*)` 的提醒

配置 `Bash` 或 `Bash(*)` 会被安全机制视为过度宽泛而剥离。建议按命令前缀精确放行，例如 `Bash(git:*)`、`Bash(bun:*)`，而不是无条件允许所有命令。

## 六、模式细节

### `dontAsk` 模式

- 不主动弹窗询问。
- 如果某个操作没有命中任何 `allow` 规则，也没有被安全模式放行，则会被**直接拒绝**。
- 适合希望严格受控、不希望被打断的场景。

### `bypassPermissions` 模式

- 跳过所有权限检查，文件读写、命令执行、MCP 调用等敏感操作均默认可以执行。
- 仅在命令行明确传入 `--dangerously-skip-permissions` 时启用。
- 仅建议在完全隔离、无网络访问的沙箱中使用。
- **root/sudo 环境下无法启用**，启用前请做好代码版本管理和重要文件存档。

### `auto` 模式

- 由分类器自动判断每个工具调用是否安全。
- 需要 `TRANSCRIPT_CLASSIFIER` feature 开启。
- 可通过 `--enable-auto-mode` 或 `--permission-mode auto` 启用。

---

## 七、运行时切换模式

在交互式会话中，可以通过斜杠命令切换模式：

```
/set_permission_mode default
/set_permission_mode acceptEdits
/set_permission_mode plan
/set_permission_mode dontAsk
```

切换到 `bypassPermissions` 需要先通过 `--dangerously-skip-permissions` 启动会话。

---

## 八、相关文件位置

- 源码：`src/utils/permissions/`
- 模式定义：`src/types/permissions.ts`
- CLI 参数解析：`src/main.tsx`
- 初始模式计算：`src/utils/permissions/permissionSetup.ts`
- 权限判断主逻辑：`src/utils/permissions/permissions.ts`
