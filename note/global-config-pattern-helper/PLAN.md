# 全局配置目录 helper 改造方案

> 关联背景：ywcoder 全局配置目录从 `~/.claude/` 迁移至 `~/.ywcoder/`。
> 加载器已通过 [`getYwCoderConfigHomeDir()`](../../src/utils/envUtils.ts) 完成切换，但
> prompt 文案、UI 字符串、权限模式串、识别函数等仍残留对 `~/.claude/` 的硬编码。
> 本方案聚焦"D1 真硬编码 bug"——影响实际功能的几处——并辅以"读时兼容 + 迁移期归一化"双轨策略。

---

## 1. 现象与根因

`~/.claude/skills/` 与 `~/.ywcoder/skills/` 都能识别 `/spms-check` 等斜杠命令（因为加载器走 helper），
但当用户用自然语言要求"把全局安装的 skill 打包到本项目"时，模型按 prompt 与权限常量里硬编码的
`~/.claude/skills/` 去 dir/ls，未命中真实位置。同时，权限模式
`GLOBAL_CLAUDE_FOLDER_PERMISSION_PATTERN = '~/.claude/**'` 在已迁移机器上也会失配。

## 2. 设计原则：写新读旧

| 时机 | 行为 |
|---|---|
| **写**（生成新规则、识别"全局文件夹"路径）| 走 `getYwCoderConfigHomeDir()`，跟随 helper 当前选定目录 |
| **读**（匹配存量规则字面量、识别历史安装）| 同时认 `~/.claude/**` 与动态前缀，老用户/老规则不失效 |
| **迁移**（一次性归一化）| `--migrate-config` 顺手把用户级 `settings.json` 里 `~/.claude/**` 字面量改写为新前缀 |

四类用户场景兼容矩阵：

| 场景 | 写规则前缀 | 读规则认前缀 | 结果 |
|---|---|---|---|
| 老用户未迁移（helper 回退 `~/.claude`）| `~/.claude/**` | `~/.claude/**` | ✅ |
| 已迁移用户（helper 返回 `~/.ywcoder`）| `~/.ywcoder/**` | `~/.ywcoder/**` ∪ `~/.claude/**` | ✅ |
| 新装用户 | `~/.ywcoder/**` | `~/.ywcoder/**` ∪ `~/.claude/**` | ✅ |
| `YWCODER_CONFIG_DIR=/custom`（CI/容器）| `/custom/**` | `/custom/**` ∪ `~/.claude/**` | ✅ |

## 3. 改造清单

### 3.1 新增 helper：`src/utils/permissions/globalConfigPattern.ts`

```ts
import { homedir } from 'os'
import { getYwCoderConfigHomeDir } from '../envUtils.js'

/** 当前全局配置目录的 glob 模式（用于生成新权限规则） */
export function getGlobalConfigPermissionPattern(): string {
  return `${displayPath(getYwCoderConfigHomeDir())}/**`
}

/** 读规则用：兼容前缀列表（当前 + 历史，去重） */
export function getGlobalConfigCompatPrefixes(): string[] {
  const current = `${displayPath(getYwCoderConfigHomeDir())}/`
  const legacy = '~/.claude/'
  return current === legacy ? [current] : [current, legacy]
}

/** 绝对路径前缀列表，用于 filesystem 层路径判断 */
export function getGlobalConfigDirCandidates(): string[] {
  const list = [getYwCoderConfigHomeDir(), `${homedir()}/.claude`]
  return list.filter((p, i, a) => a.indexOf(p) === i)
}

function displayPath(abs: string): string {
  return abs.startsWith(homedir()) ? abs.replace(homedir(), '~') : abs
}
```

> 单独成文件，因为 `FileEditTool/constants.ts` 注释指明"In its own file to avoid circular dependencies"——
> envUtils 引入 path/os，不能进 constants.ts。

### 3.2 调用点改造（6 处）

| 文件 | 行 | 改动 |
|---|---|---|
| `src/tools/FileEditTool/constants.ts` | 8 | 删除 `GLOBAL_CLAUDE_FOLDER_PERMISSION_PATTERN`；`CLAUDE_FOLDER_PERMISSION_PATTERN`（项目级）保留 |
| `src/utils/permissions/filesystem.ts` | 107-115 | `getClaudeSkillScope` 的 `bases` 中"全局" 项改用 `getGlobalConfigDirCandidates()` 展开 |
| `src/utils/permissions/filesystem.ts` | 1273-1300 | 存量规则前缀检查改为遍历 `[CLAUDE_FOLDER_PERMISSION_PATTERN.slice(0,-2), ...getGlobalConfigCompatPrefixes()]` |
| `src/components/permissions/FilePermissionDialog/permissionOptions.tsx` | 34-40 | `isInGlobalClaudeFolder` 改为遍历 `getGlobalConfigDirCandidates()` |
| `src/components/permissions/FilePermissionDialog/usePermissionHandler.ts` | 109-112 | `global-claude-folder` 分支调用 `getGlobalConfigPermissionPattern()` |
| `src/utils/localInstaller.ts` | 29-32 | `isRunningFromLocalInstallation` 同时认 `/.ywcoder/local/node_modules/` 与 `/.claude/local/node_modules/` |
| `src/utils/doctorDiagnostic.ts` | 212 | `localPath = join(getYwCoderConfigHomeDir(), 'local')` |

### 3.3 后续 PR（不在本 PR-1 范围）

- **PR-2**：`configMigration.ts` 在 cp 完成后改写 `~/.ywcoder/settings.json` 内 `~/.claude/**` 字面量
- **PR-3**：清理 A 类 21 处 prompt + B 类 14 处 UI 文案 + E 类 60 处注释

## 4. 测试覆盖

### 4.1 新建 `src/utils/permissions/globalConfigPattern.test.ts`
- 默认环境：`getGlobalConfigPermissionPattern()` 返回 `~/.ywcoder/**`
- `YWCODER_CONFIG_DIR=/tmp/foo`：返回 `/tmp/foo/**`
- 仅 `~/.claude` 存在、`~/.ywcoder` 不存在：返回 `~/.claude/**`
- 兼容前缀列表去重

### 4.2 扩展 `src/utils/permissions/filesystem.test.ts`（若已存在）
- 已迁移环境下存量规则 `~/.claude/**` 仍命中 1284 行前缀检查
- 新规则 `~/.ywcoder/skills/foo/**` 命中 narrowed 检查
- `getClaudeSkillScope` 对项目级 `/.claude/skills/` 与全局两种前缀都正确返回 skillName

### 4.3 新建 `src/components/permissions/FilePermissionDialog/permissionOptions.test.ts`
- `isInGlobalClaudeFolder('~/.ywcoder/settings.json')` → true
- `isInGlobalClaudeFolder('~/.claude/settings.json')` → true（向后兼容）
- `isInGlobalClaudeFolder('~/elsewhere/foo')` → false

## 5. 验证流程

```bash
bun test src/utils/permissions
bun test src/components/permissions
bun run build
bun run smoke
```

## 6. 风险与边界

1. **`~/.claude.json`**：本次不动，已由 configMigration 处理为 `~/.ywcoder/.config.json`
2. **项目级 `<project>/.claude/settings.json` 里残留 `~/.claude/**`**：靠"读时兼容"兜住
3. **`SYNC_KEYS.USER_SETTINGS`**：云同步标识符，不动
4. **`isRunningFromLocalInstallation` 双前缀容忍**：node_modules 子路径碰撞概率极低，可接受
5. **PR-1 不触碰 prompt/UI 文案**：那是 PR-3 的事；PR-1 只修真 bug

## 7. 实施顺序

1. 写本方案 ✅
2. 确认分支策略（当前 `feature/brand-replacement`，是否切到 `feature/global-config-pattern-helper`）
3. 新建 `globalConfigPattern.ts`
4. 6 个调用点改造
5. 配套测试
6. `bun test` + `bun run smoke`
7. 提交
