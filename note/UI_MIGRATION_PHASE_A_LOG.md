# UI 品牌替换方案A执行记录

**执行时间**: 2026-04-12  
**执行方案**: 方案A（关键用户提示）  
**执行目标**: 修改用户直接可见且会造成困惑的UI文本

---

## 执行摘要

| 步骤 | 文件 | 修改数 | 状态 |
|------|------|--------|------|
| Step 1 | src/utils/gracefulShutdown.ts | 1处 | ✅ 通过 |
| Step 2 | src/commands/provider/provider.tsx | 3处 | ✅ 通过 |
| Step 3 | src/components/Feedback.tsx | 1处 | ✅ 通过 |
| Step 4 | 验证修改 | 5处 | ✅ 通过 |
| Step 5 | 构建测试 | - | ✅ 通过 |
| Step 6 | 冒烟测试 | - | ✅ 通过 |

**总计**: 3个文件，5处修改，全部成功

---

## 详细修改记录

### Step 1: gracefulShutdown.ts（最关键）

**文件**: `src/utils/gracefulShutdown.ts`  
**行号**: 181  
**修改原因**: 用户Ctrl+C退出时会复制粘贴这个命令，如果显示`openclaude --resume`而命令不存在会导致困惑

**修改前**:
```typescript
`\nResume this session with:\nopenclaude --resume ${resumeArg}\n`,
```

**修改后**:
```typescript
`\nResume this session with:\nywcoder --resume ${resumeArg}\n`,
```

**验证**:
```bash
grep -n "ywcoder --resume" src/utils/gracefulShutdown.ts
# 输出: 181:          `\nResume this session with:\nywcoder --resume ${resumeArg}\n`, ✅
```

---

### Step 2: provider.tsx（3处）

**文件**: `src/commands/provider/provider.tsx`

#### 修改 2.1 - 保存配置后提示（第338行）

**修改前**:
```typescript
lines.push('Restart OpenClaude to use it.')
```

**修改后**:
```typescript
lines.push('Restart YwCoder to use it.')
```

#### 修改 2.2 - Provider命令描述（第355行）

**修改前**:
```typescript
'Choose Auto, Ollama, OpenAI-compatible, Gemini, or Codex, then save a profile for the next OpenClaude restart.',
```

**修改后**:
```typescript
'Choose Auto, Ollama, OpenAI-compatible, Gemini, or Codex, then save a profile for the next YwCoder restart.',
```

#### 修改 2.3 - 清除配置后提示（第976行）

**修改前**:
```typescript
onDone(`Removed saved provider profile at ${filePath}. Restart OpenClaude to go back to normal startup.`, {
```

**修改后**:
```typescript
onDone(`Removed saved provider profile at ${filePath}. Restart YwCoder to go back to normal startup.`, {
```

**验证**:
```bash
grep -n "Restart YwCoder\|next YwCoder restart" src/commands/provider/provider.tsx
# 输出:
# 338:  lines.push('Restart YwCoder to use it.') ✅
# 355:  '...next YwCoder restart...' ✅
# 976:  '...Restart YwCoder to go back...' ✅
```

---

### Step 3: Feedback.tsx（GitHub链接）

**文件**: `src/components/Feedback.tsx`  
**行号**: 36  
**修改原因**: 用户点击反馈按钮时跳转到正确的GitHub仓库

**修改前**:
```typescript
const GITHUB_ISSUES_REPO_URL = 'https://github.com/Gitlawb/openclaude/issues';
```

**修改后**:
```typescript
const GITHUB_ISSUES_REPO_URL = 'https://github.com/dcywzc/ywcoder/issues';
```

**验证**:
```bash
grep -n "github.com/dcywzc/ywcoder" src/components/Feedback.tsx
# 输出: 36:const GITHUB_ISSUES_REPO_URL = 'https://github.com/dcywzc/ywcoder/issues'; ✅
```

---

## 测试记录

### 构建测试

**命令**: `bun run build`

**输出**:
```
$ bun run scripts/build.ts
  🔇 no-telemetry: stubbed 21 modules
✓ Built openclaude v1.0.0 → dist/cli.mjs
```

**结果**: ✅ 构建成功

---

### 冒烟测试

**命令**: `bun run smoke`

**输出**:
```
$ bun run build && node dist/cli.mjs --version
$ bun run scripts/build.ts
  🔇 no-telemetry: stubbed 21 modules
✓ Built openclaude v1.0.0 → dist/cli.mjs
v1.0.0 (YwCoder)
```

**结果**: ✅ 版本显示正确 (`v1.0.0 (YwCoder)`)

---

## 未修改的项（符合预期）

以下项**未被修改**，因为它们要么不是用户直接可见，要么有功能依赖：

| 文件 | 内容 | 原因 |
|------|------|------|
| `src/components/StartupScreen.ts:2` | `OpenClaude startup screen` 注释 | 注释不可见 |
| `src/utils/providerFlag.ts:8-11` | `openclaude --provider` 注释 | 代码注释 |
| `src/proto/openclaude.proto` | `package openclaude.v1` | gRPC协议 |
| `src/grpc/server.ts` | 使用 proto package | 功能依赖 |

---

## 风险评估

| 风险 | 可能性 | 影响 | 缓解措施 |
|------|--------|------|---------|
| 代码语法错误 | 极低 | 高 | 构建测试通过 |
| 功能异常 | 极低 | 中 | 冒烟测试通过 |
| 遗漏的UI文本 | 低 | 低 | 方案A只改关键提示，可接受 |

---

## 回滚方案

如有问题，可以单文件回滚：

```bash
# 回滚单个文件
git checkout HEAD -- src/utils/gracefulShutdown.ts

# 回滚所有修改
git checkout HEAD -- src/utils/gracefulShutdown.ts \
                     src/commands/provider/provider.tsx \
                     src/components/Feedback.tsx

# 重新构建
bun run build && bun run smoke
```

---

## 后续建议

1. **手动测试 resume 提示**:
   ```bash
   ./dist/cli.mjs
   # 按 Ctrl+C，确认显示: ywcoder --resume
   ```

2. **手动测试 Provider 提示**:
   ```bash
   ./dist/cli.mjs
   # /provider → 选择配置，确认显示 "Restart YwCoder"
   ```

3. **检查是否还有其他用户可见的UI文本**:
   ```bash
   grep -rn "OpenClaude" src/ --include="*.ts" --include="*.tsx" | grep -v "test" | grep -v "// "
   ```

---

**执行完成时间**: 2026-04-12  
**执行状态**: ✅ 全部完成并通过测试
