# 项目本地 Profile 文件名改造计划

## 背景

项目本地 provider 配置文件（`ywcoder /provider save` 写入当前工作目录的文件）沿用了旧品牌名 `.openclaude-profile.json`，需改为 `.ywcoder-profile.json`。

该文件与 `~/.ywcoder/`（运行时数据目录）和 `~/.claude.json`（全局配置）完全独立，是第三套独立的存储机制，改造影响范围可独立评估。

---

## 受影响文件清单

| 文件 | 类型 | 改动内容 |
|------|------|---------|
| `src/utils/providerProfile.ts:18` | 常量定义 | `PROFILE_FILE_NAME` 改为 `.ywcoder-profile.json`；`resolveProfileFilePath()` 加 fallback 读取逻辑 |
| `src/commands/provider/provider.tsx:487` | UI 文本 | description 字符串中的文件名 |
| `scripts/provider-recommend.ts:116` | 控制台输出 | console.log 中的文件名提示 |
| `vscode-extension/openclaude-vscode/src/extension.js:18` | VSCode 扩展常量 | 扩展内独立的 `PROFILE_FILE_NAME` 常量 |
| `.gitignore:7` | 忽略规则 | 新增 `.ywcoder-profile.json`，保留旧名（避免旧文件被意外提交） |
| `README.md:118` | 文档 | 文件名引用 |
| `PLAYBOOK.md:55,263` | 文档 | 文件名引用（2处） |
| `docs/advanced-setup.md:232` | 文档 | 文件名引用 |
| `package/README.md:118` | 文档 | 文件名引用 |
| `vscode-extension/openclaude-vscode/README.md:13,52` | 扩展文档 | 文件名引用（2处） |
| `src/utils/providerProfile.test.ts:399` | 测试 | 临时目录名前缀（`openclaude-profile-file-`），可顺带更新但不影响功能 |
| `src/commands/provider/provider.test.tsx:194,211,227` | 测试 | 测试数据中的路径字符串（3处），需同步更新否则测试失败 |
| `vscode-extension/openclaude-vscode/src/extension.test.js` | 扩展测试 | 路径字符串（2处） |
| `vscode-extension/openclaude-vscode/src/presentation.test.js` | 扩展测试 | 路径字符串（6处） |

**不需要改动**：`docs/backup/` 目录下的 HTML 存档文件（历史快照，不影响功能）。

---

## 向后兼容策略

已有项目目录中存在 `.openclaude-profile.json` 的用户，如果不处理，YwCoder 更新后将**读不到**原有配置，等同于 provider 设置丢失，需重新配置。

### 方案：读取时 fallback，写入时用新名

在 `resolveProfileFilePath()` 中加入 fallback 逻辑：

```typescript
function resolveProfileFilePath(options?: ProfileFileLocation): string {
  if (options?.filePath) return options.filePath

  const cwd = options?.cwd ?? process.cwd()
  const newPath = resolve(cwd, '.ywcoder-profile.json')
  const legacyPath = resolve(cwd, '.openclaude-profile.json')

  // 新文件不存在但旧文件存在时，读取旧文件（兼容已有项目）
  if (!existsSync(newPath) && existsSync(legacyPath)) {
    return legacyPath
  }
  return newPath
}
```

`saveProfileFile()` 不做特殊处理，始终写入 `resolveProfileFilePath()` 返回的路径：
- 新安装用户：写入 `.ywcoder-profile.json` ✓
- 已有旧文件的用户：首次 `/provider save` 后，写入 `.openclaude-profile.json`（因为 fallback 仍返回旧路径）；**用户删除旧文件后**，后续写入 `.ywcoder-profile.json` ✓

若希望自动升级旧文件，可在 `saveProfileFile()` 中加入一次性重命名（见"可选增强"章节）。

---

## 分步改造计划

### 第一步：核心常量和 fallback 逻辑（`src/utils/providerProfile.ts`）

```typescript
// 修改前
export const PROFILE_FILE_NAME = '.openclaude-profile.json'

// 修改后
export const PROFILE_FILE_NAME = '.ywcoder-profile.json'
const LEGACY_PROFILE_FILE_NAME = '.openclaude-profile.json'

function resolveProfileFilePath(options?: ProfileFileLocation): string {
  if (options?.filePath) return options.filePath

  const cwd = options?.cwd ?? process.cwd()
  const newPath = resolve(cwd, PROFILE_FILE_NAME)
  const legacyPath = resolve(cwd, LEGACY_PROFILE_FILE_NAME)

  if (!existsSync(newPath) && existsSync(legacyPath)) {
    return legacyPath
  }
  return newPath
}
```

需在文件顶部补充 `import { existsSync } from 'fs'`（若尚未引入）。

### 第二步：UI 文本（`src/commands/provider/provider.tsx:487`）

```typescript
// 修改前
description: 'Remove saved profile (.openclaude-profile.json) and return to normal startup',

// 修改后
description: 'Remove saved profile (.ywcoder-profile.json) and return to normal startup',
```

### 第三步：脚本输出（`scripts/provider-recommend.ts:116`）

```typescript
// 修改前
console.log('\nSaved provider profile at .openclaude-profile.json.')

// 修改后
console.log('\nSaved provider profile at .ywcoder-profile.json.')
```

### 第四步：VSCode 扩展（`vscode-extension/openclaude-vscode/src/extension.js:18`）

```javascript
// 修改前
const PROFILE_FILE_NAME = '.openclaude-profile.json';

// 修改后
const PROFILE_FILE_NAME = '.ywcoder-profile.json';
```

注意：扩展有独立的 `PROFILE_FILE_NAME` 副本，需与主代码保持同步。扩展中若也有读取逻辑，需同样加 fallback（检查旧文件名）。

### 第五步：.gitignore

```
# 修改前（第7行）
.openclaude-profile.json

# 修改后（两行都保留）
.ywcoder-profile.json
.openclaude-profile.json
```

保留旧规则，防止已有旧文件被意外提交到 git。

### 第六步：测试文件

`src/commands/provider/provider.test.tsx`（3处路径字符串）、`vscode-extension/` 下的测试文件（8处）中的硬编码路径字符串，统一替换为 `.ywcoder-profile.json`。

### 第七步：文档

`README.md`、`PLAYBOOK.md`、`docs/advanced-setup.md`、`package/README.md`、`vscode-extension/openclaude-vscode/README.md` 中所有 `.openclaude-profile.json` 字样替换为 `.ywcoder-profile.json`。

---

## 可选增强：首次保存时自动升级旧文件

如果希望用户不必手动删除旧文件，可在 `saveProfileFile()` 中加入一次性自动重命名：

```typescript
export function saveProfileFile(
  profileFile: ProfileFile,
  options?: ProfileFileLocation,
): string {
  const cwd = options?.cwd ?? process.cwd()
  const newPath = resolve(cwd, PROFILE_FILE_NAME)
  const legacyPath = resolve(cwd, LEGACY_PROFILE_FILE_NAME)

  // 首次写入新文件时，自动删除旧文件（避免两者同时存在造成混淆）
  if (existsSync(legacyPath) && !existsSync(newPath)) {
    unlinkSync(legacyPath)
  }

  const targetPath = options?.filePath ?? newPath
  // ... 原有写入逻辑
  return targetPath
}
```

此增强可选，不加也能正常工作（旧文件作为 fallback 继续被读取，直到用户手动删除）。

---

## 改造后的文件分布

```
项目根目录/
├── .ywcoder-profile.json      ← 新文件名（新安装 / 迁移后）
└── .openclaude-profile.json   ← 旧文件名（兼容读取，建议用户手动删除）

~/.ywcoder/                    ← 运行时数据（Phase 3 迁移目标）
~/.claude.json                 ← 全局用户偏好（始终共享）
```

---

## 风险评估

| 风险 | 说明 | 处置 |
|------|------|------|
| 已有项目配置丢失 | 旧文件不自动迁移 | fallback 读取兼容 |
| VSCode 扩展与主代码不同步 | 扩展有独立副本 | 两处同步修改 |
| 测试失败 | 硬编码路径字符串未更新 | 同步更新测试 |
| 旧文件被提交到 git | `.gitignore` 未更新 | 保留旧规则 |

---

*文档创建时间: 2026-04-23*
