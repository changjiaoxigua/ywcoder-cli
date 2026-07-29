# 阶段3配置目录迁移（~/.ywcoder）风险分析

## 背景

将 YwCoder 的默认配置目录从 `~/.claude` 迁移到 `~/.ywcoder`，同时保留对 `~/.claude` 的静默兼容，以满足与官方 Claude Code 并行安装的需求。

---

## 前置说明：两套存储系统的区别

YwCoder 的配置分散在**两个完全独立的位置**，职责不同，迁移影响也不同。

### `getYwCoderConfigHomeDir()` → 目录，存放运行时数据

返回 `~/.ywcoder`（或 fallback 到 `~/.claude`），下挂所有**操作性文件**：

```
~/.ywcoder/
├── history.jsonl          # 对话历史
├── keybindings.json       # 键位绑定
├── sessions/              # 并发会话
├── projects/              # 项目级会话存储
├── plans/                 # 计划文件
├── cache/                 # changelog 缓存
├── debug/                 # 调试日志
├── backups/               # 配置备份
├── uploads/               # 附件暂存
├── CLAUDE.md              # 全局 memory
├── .update.lock           # 自动更新锁
├── .credentials.json      # 部分凭证
└── local/                 # 本地安装包
```

约 **40+ 个调用点**，都是"把文件放在哪里"。**Phase 3 迁移的主要目标就是这一层。**

### `getGlobalClaudeFile()` → 单个 JSON 文件，存放用户身份和全局偏好

返回 `~/.claude.json`（固定在 homedir，**不在**配置目录里），内容是 `GlobalConfig` 结构：

```typescript
type GlobalConfig = {
  oauthAccount?: AccountInfo           // Anthropic OAuth 账户
  providerProfiles?: ProviderProfile[] // 全局保存的 provider 配置（/provider save 写入）
  activeProviderProfileId?: string     // 当前激活的 profile ID
  projects?: Record<string, ProjectConfig> // 每个项目的 trust 状态、MCP 服务器等
  // 主题、自动更新、显示偏好...
}
```

**18 个调用点全部在 `config.ts`**，有文件锁保护。**Phase 3 不触及这一层，该文件始终指向 `~/.claude.json`。**

### 第三套：项目本地 Profile（与目录迁移无关）

`.ywcoder-profile.json`（原 `.openclaude-profile.json`），存在**项目工作目录**下，存储当前项目使用的 provider 配置，可提交到 git。由 `providerProfile.ts` 管理，与上述两者完全独立。详见 [PROFILE_FILE_RENAME_PLAN.md](./PROFILE_FILE_RENAME_PLAN.md)。

---

## 1. 全局配置文件 `~/.claude.json` 始终共享

`getGlobalClaudeFile()` 的实现（`src/utils/env.ts:14-26`）：

```typescript
export const getGlobalClaudeFile = memoize((): string => {
  // legacy 分支：检查 {configHomeDir}/.config.json（旧格式）
  if (existsSync(join(getYwCoderConfigHomeDir(), '.config.json'))) {
    return join(getYwCoderConfigHomeDir(), '.config.json')
  }
  // 正常路径：始终用 CLAUDE_CONFIG_DIR || homedir()，忽略 YWCODER_CONFIG_DIR
  const filename = `.claude${fileSuffixForOauthConfig()}.json`
  return join(process.env.CLAUDE_CONFIG_DIR || homedir(), filename)
})
```

即使 `getYwCoderConfigHomeDir()` 已经返回 `~/.ywcoder`，`getGlobalClaudeFile()` 仍然返回 `~/.claude.json`。Phase 3 迁移完成后，运行时数据（历史、会话等）已隔离，但 OAuth 账户、全局 provider profiles、项目 trust 状态依然共享。

### 具体风险

| 场景 | 影响 |
|------|------|
| 全局 Provider Profile 交叉 | 用户在 YwCoder 中 `/provider save` 的 profile 写入 `~/.claude.json`，官方 Claude Code 也能读到（但不会激活） |
| OAuth 状态 | YwCoder 内网用户一般不使用 Anthropic OAuth，此项影响极小 |
| Trust Dialog 同步 | 项目 trust 接受状态双向同步，通常是期望行为 |
| 并发写入竞争 | `~/.claude.json` 写入有文件锁保护，风险可控 |

### 决策（2026-04-23）

**接受共享（方案A）**。内网用户不使用官方 Claude Code，无实际冲突。开发者场景（用官方 Claude Code 开发 YwCoder）中，全局 profile 互相可见但不会被激活，可接受。长期如需完全隔离，需修改 `getGlobalClaudeFile()` 改用 `getYwCoderConfigHomeDir()`，影响 20 个调用点，暂不实施。

---

## 2. 新安装用户的静默 Fallback 导致意外共享

如果用户电脑上已有官方 Claude Code，`~/.claude` 目录必然存在。YwCoder 第一次启动时：

- `~/.ywcoder` 不存在
- `~/.claude` 存在
- `getYwCoderConfigHomeDir()` 返回 `~/.claude`
- YwCoder **完全复用**官方 Claude Code 的所有子配置

这意味着 YwCoder 和官方 Claude Code 实际上**完全共享配置子目录**，直到用户手动创建 `~/.ywcoder` 或运行 `--migrate-config`。

### 具体风险

| 子目录/文件 | 风险 |
|-------------|------|
| `~/.claude/settings.json` | YwCoder 修改了某个 setting，官方 Claude Code 下次启动会读到 |
| `~/.claude/sessions/` | 两个工具的并发会话互相可见，`claude ps` / `ywcoder ps` 可能列出对方的会话 |
| `~/.claude/backups/` | 备份文件混杂，难以区分来源 |
| `~/.claude/plugins/` | 插件安装互相影响，版本冲突 |
| `~/.claude/.update.lock` | 自动更新锁竞争，可能导致更新检查异常 |
| `~/.claude/keybindings.json` | 键位绑定冲突 |

### 缓解

设计上的 trade-off，通过 `--migrate-config` 命令和首次启动提示缓解。内网用户（不安装官方 Claude Code）不受影响。

---

## 3. 子目录文件写入无锁保护

`getYwCoderConfigHomeDir()` 返回的目录下的子文件（如 `settings.json`、`keybindings.json`）写入时**没有**像 `~/.claude.json` 那样的文件锁保护。如果 YwCoder 和官方 Claude Code 同时运行并同时修改同一文件，可能产生：

- 写入覆盖（后写入者赢）
- JSON 截断/损坏
- 配置不一致

### 缓解

两个工具同时运行并同时修改同一配置文件的概率较低；且 settings.json 等修改频率不高。Phase 3 迁移完成后子目录已隔离，此风险自动消除。

---

## 4. 环境变量 `CLAUDE_CONFIG_DIR` 的冲突

官方 Claude Code 和 YwCoder 都读取 `CLAUDE_CONFIG_DIR` 环境变量（用于覆盖配置目录）。但 `getGlobalClaudeFile()` 的正常路径也会读取 `CLAUDE_CONFIG_DIR`：

```typescript
return join(process.env.CLAUDE_CONFIG_DIR || homedir(), filename)
```

若用户设置了 `CLAUDE_CONFIG_DIR`，则 `getGlobalClaudeFile()` 返回 `{CLAUDE_CONFIG_DIR}/.claude.json`，而非 homedir 下的 `~/.claude.json`，且 `YWCODER_CONFIG_DIR` 在此路径中被忽略。

### 缓解

`YWCODER_CONFIG_DIR` 在 `getYwCoderConfigHomeDir()` 中优先级更高，可独立控制目录。`getGlobalClaudeFile()` 不感知 `YWCODER_CONFIG_DIR` 是已知不一致（见风险1），可接受。

---

## 5. 深链接/协议注册冲突

`claude://` 深链接协议在 `registerProtocol.ts` 中注册。两个工具可能争夺协议注册权，导致点击 `claude://` 链接时启动的是不可预期的工具。

### 缓解

此功能为 Anthropic 内部特性，YwCoder 已因 `bin/claude` 删除而失效（见 `BRAND1_MIGRATION_SUMMARY.md` 阶段4）。实际影响有限。

---

## 6. 测试环境污染（memoize 缓存）

`getYwCoderConfigHomeDir()` 的 memoize resolver 仅依赖环境变量：

```typescript
() => process.env.YWCODER_CONFIG_DIR ?? process.env.CLAUDE_CONFIG_DIR
```

Phase 3 实施后，函数体内加入了 `existsSync` 检查，但 resolver 不变。这意味着：当两个环境变量均未设置时，cache key 为 `undefined`，函数只在进程生命周期内执行一次。测试中直接创建/删除 `~/.ywcoder` 或 `~/.claude` 目录，不会触发重新计算。

### 缓解

现有测试通过 `CLAUDE_CONFIG_DIR` 或 `YWCODER_CONFIG_DIR` 指向临时目录，不受影响。新增针对目录检测逻辑的测试时，需在每个 case 前后调用 `getYwCoderConfigHomeDir.cache.clear()`，或通过环境变量而非文件系统操作控制路径。

---

## 7. `--migrate-config` 的文件复制策略限制

`configMigration.ts` 使用 `cpSync(source, target, { recursive: true })`，不覆盖已有文件（保守策略）。如果用户之前运行过迁移，然后又回滚到 `~/.claude` 并修改了配置，再次运行 `--migrate-config` 时，新修改不会同步到 `~/.ywcoder`。

### 缓解

行为可预期，避免数据丢失。命令执行后的提示文本中需说明："如需强制同步，请手动删除 `~/.ywcoder` 后再次运行。"

---

## 8. `getYwCoderConfigHomeDir()` 与 `getGlobalClaudeFile()` 的不一致（已决策）

迁移到 `~/.ywcoder` 后配置文件分布：

```
~/.ywcoder/          ← getYwCoderConfigHomeDir() 管理（运行时数据）
  ├── history.jsonl
  ├── sessions/
  └── ...

~/.claude.json       ← getGlobalClaudeFile() 管理（用户身份和全局偏好）
  ├── providerProfiles[]
  ├── activeProviderProfileId
  └── projects{}

./项目目录/.ywcoder-profile.json   ← providerProfile.ts 管理（项目本地 provider 配置）
```

三个位置各司其职。`~/.claude.json` 不跟随 `~/.ywcoder` 迁移，是已知的设计不一致。

### 决策（2026-04-23）

接受此不一致（见风险1的决策）。可在文档中说明文件分布，避免用户困惑。

---

## 总结

| 风险等级 | 风险项 | 决策/状态 |
|----------|--------|----------|
| 🔴 高 | `~/.claude.json` 全局共享 | **接受**：内网用户无冲突，开发者场景影响可忽略 |
| 🔴 高 | 新安装 fallback 到 `~/.claude` 导致目录完全共享 | **通过迁移命令缓解**：`--migrate-config` + 启动提示 |
| 🟡 中 | 子目录文件无锁保护 | **可接受**：迁移后风险自动消除 |
| 🟡 中 | `CLAUDE_CONFIG_DIR` 环境变量冲突 | **已缓解**：`YWCODER_CONFIG_DIR` 优先级更高 |
| 🟢 低 | 深链接协议冲突 | **已消除**：bin/claude 已删除 |
| 🟢 低 | 测试 memoize 污染 | **已知**：新测试需调用 cache.clear() |
| 🟢 低 | 迁移不覆盖已有文件 | **可接受**：保守策略，命令文本中说明 |
| 🟢 低 | 目录与全局文件不一致 | **接受**：文档说明三套存储的分工 |

---

*文档初始生成时间: 2026-04-23*  
*最后更新: 2026-04-23（补充两套存储系统说明、开发者场景分析、各项风险决策）*
