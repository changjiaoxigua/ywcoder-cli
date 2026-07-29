# 双版本策略说明文档

## 1. 背景：为什么需要双版本策略

YwCoder 是基于 Claude Code 的开源分叉版本。由于 Claude Code 原本是 Anthropic 的第一方产品，服务器端有严格的版本控制机制：

- **服务器配置 minVersion**：Anthropic 服务器会配置最低版本要求（如 `0.2.40`）
- **版本检查阻断**：客户端版本低于 minVersion 时，会被强制阻断使用并提示更新
- **开源版本的困境**：YwCoder 的真实版本是 `v1.0.0`，远低于服务器要求的 `0.2.40+`

### 如果不使用双版本策略会发生什么

```
客户端发送版本: v1.0.0
服务器配置 minVersion: v0.2.40
比较结果: v1.0.0 < v0.2.40 (SemVer 比较认为 1.0.0 是早期版本)
结果: 服务器返回 "版本过旧，请更新" 错误，阻断使用
```

## 2. 工作原理

### 2.1 宏定义（scripts/build.ts）

```javascript
'define': {
  // 内部兼容版本 - 用于服务器通信和版本检查
  'MACRO.VERSION': JSON.stringify('99.0.0'),
  // 真实展示版本 - 用于用户界面显示
  'MACRO.DISPLAY_VERSION': JSON.stringify('1.0.0'), // 从 package.json 读取
}
```

### 2.2 双版本分工

```
┌─────────────────────────────────────────────────────────────────┐
│                        构建时宏定义                               │
├─────────────────────────────┬───────────────────────────────────┤
│ MACRO.VERSION: "99.0.0"     │ MACRO.DISPLAY_VERSION: "1.0.0"    │
│ （内部兼容版本）              │ （真实展示版本）                   │
└─────────────┬───────────────┴───────────────┬───────────────────┘
              │                               │
      ┌───────▼────────┐             ┌───────▼────────┐
      │  服务器通信     │             │   用户界面显示   │
      │  ────────────  │             │  ────────────   │
      │ • API 请求头    │             │ • /help 标题    │
      │ • 版本检查      │             │ • --version     │
      │ • 遥测数据      │             │ • 启动画面      │
      │ • Remote Ctrl   │             │ • 更新提示      │
      └────────────────┘             └─────────────────┘
```

### 2.3 版本号比较逻辑

```
服务器检查:
  客户端版本: 99.0.0 (MACRO.VERSION)
  服务器 minVersion: 0.2.40
  比较: 99.0.0 > 0.2.40 ✓ 通过检查

用户看到:
  界面显示: YwCoder v1.0.0 (MACRO.DISPLAY_VERSION)
```

## 3. 使用场景分类

### 3.1 MACRO.VERSION（99.0.0）- 绝对不能修改

用于所有与 Anthropic 服务器通信的场景：

| 文件路径 | 用途 | 说明 |
|---------|------|------|
| `src/utils/autoUpdater.ts:89` | 服务器版本检查 | 与服务器 minVersion 比较，低于则阻断使用 |
| `src/bridge/bridgeEnabled.ts:168` | Remote Control 版本检查 | 检查客户端是否支持 bridge 功能 |
| `src/bridge/envLessBridgeConfig.ts:149` | Remote Control v2 版本检查 | 独立的 v2 bridge 版本检查 |
| `src/constants/system.ts:81` | API 归因头 | `x-anthropic-billing-header: cc_version=99.0.0.xxx` |
| `src/utils/http.ts:36` | User-Agent | `claude-cli/99.0.0` |
| `src/utils/http.ts:51` | MCP User-Agent | `claude-code/99.0.0` |
| `src/utils/messages/systemInit.ts:74` | 系统初始化 | `claude_code_version: 99.0.0` 发送到服务器 |
| `src/main.tsx:2480` | 诊断日志 | `logForDiagnosticsNoPII('started', {version: MACRO.VERSION})` |
| `src/main.tsx:3211` | SSH 会话 | `localVersion` 发送到远程服务器 |
| `src/utils/sideQuery.ts:143` | Fingerprint 计算 | 与服务器验证相关 |
| `src/services/analytics/*.ts` | 遥测数据上报 | 各种分析数据中的版本字段 |
| `src/utils/fingerprint.ts:81` | 请求指纹 | 用于服务器端请求追踪 |
| `src/utils/userAgent.ts:9` | User-Agent 生成 | `ywcoder/99.0.0` |

### 3.2 MACRO.DISPLAY_VERSION（1.0.0）- 用于用户界面

用于所有纯本地 UI 显示的场景：

| 文件路径 | 用途 | 说明 |
|---------|------|------|
| `src/main.tsx:3792` | `--version` 命令 | 命令行版本输出 |
| `src/entrypoints/cli.tsx:95` | CLI 直接版本输出 | `console.log(`v${DISPLAY_VERSION} (YwCoder)`)` |
| `src/components/LogoV2/WelcomeV2.tsx` | 欢迎界面 | `YwCoder v${DISPLAY_VERSION}` |
| `src/components/StartupScreen.ts:190` | 启动画面 | `const ver = DISPLAY_VERSION ?? VERSION` |
| `src/components/HelpV2/HelpV2.tsx:141` | Help 界面标题 | `YwCoder v${DISPLAY_VERSION}` |
| `src/components/Settings/Status.tsx:25` | 设置界面状态 | `value: DISPLAY_VERSION ?? VERSION` |
| `src/utils/logoV2Utils.ts:248` | Logo 工具函数 | `const version = DISPLAY_VERSION ?? VERSION` |

### 3.3 条件表达式模式

项目中推荐的使用模式：

```typescript
// 优先使用 DISPLAY_VERSION，如果不存在则回退到 VERSION
const displayVersion = MACRO.DISPLAY_VERSION ?? MACRO.VERSION;

// 实际应用示例
// main.tsx
}).version(`${MACRO.DISPLAY_VERSION ?? MACRO.VERSION} (YwCoder)`, '-v, --version');

// WelcomeV2.tsx
<Text dimColor={true}>v{MACRO.DISPLAY_VERSION ?? MACRO.VERSION}</Text>
```

## 4. 开发者指南

### 4.1 何时使用哪个版本

**使用 `MACRO.VERSION`（99.0.0）的情况：**
- 代码涉及与 Anthropic 服务器的网络请求
- 代码用于版本兼容性检查
- 代码涉及 Remote Control / Bridge 功能
- 代码发送遥测或分析数据到 Anthropic

**使用 `MACRO.DISPLAY_VERSION ?? MACRO.VERSION`（1.0.0）的情况：**
- 代码仅用于本地 UI 显示
- 代码向用户展示版本号
- 代码不涉及任何网络请求

### 4.2 修改注意事项

**⚠️ 警告：以下文件绝对不能修改版本号来源**

```
src/utils/autoUpdater.ts
src/bridge/bridgeEnabled.ts
src/bridge/envLessBridgeConfig.ts
src/constants/system.ts
src/utils/http.ts
src/utils/messages/systemInit.ts
src/main.tsx (第 2480 行和第 3211 行)
src/utils/sideQuery.ts
src/services/analytics/*.ts
```

**✅ 可以修改的文件（纯 UI 显示）：**

```
src/components/HelpV2/HelpV2.tsx
src/components/LogoV2/WelcomeV2.tsx (已正确实现)
src/components/StartupScreen.ts (已正确实现)
src/components/Settings/Status.tsx (已正确实现)
src/entrypoints/cli.tsx (已正确实现)
```

### 4.3 验证修改是否安全

在修改版本号使用前，问自己三个问题：

1. **这个值会发送到服务器吗？**
   - 如果会 → 使用 `MACRO.VERSION`
   - 如果不会 → 可以使用 `MACRO.DISPLAY_VERSION`

2. **这个值用于版本比较吗？**
   - 如果会 → 使用 `MACRO.VERSION`
   - 如果不会 → 可以使用 `MACRO.DISPLAY_VERSION`

3. **这个值会影响功能可用性吗？**（如 Remote Control）
   - 如果会 → 使用 `MACRO.VERSION`
   - 如果不会 → 可以使用 `MACRO.DISPLAY_VERSION`

## 5. 相关配置

### 5.1 构建配置（scripts/build.ts）

```typescript
const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'))
const version = pkg.version  // 1.0.0

const result = await Bun.build({
  define: {
    'MACRO.VERSION': JSON.stringify('99.0.0'),
    'MACRO.DISPLAY_VERSION': JSON.stringify(version),
    'MACRO.BUILD_TIME': JSON.stringify(new Date().toISOString()),
    // ...
  }
})
```

### 5.2 package.json 版本

```json
{
  "name": "@dcywzc/ywcoder",
  "version": "1.0.0",
  "description": "YwCoder - AI coding agent CLI"
}
```

## 6. 常见问题

**Q: 为什么不直接用 1.0.0，而是要用 99.0.0？**

A: 因为 Anthropic 服务器会配置 minVersion（如 0.2.40），如果客户端版本低于此值会被阻断。使用 99.0.0 可以确保永远高于服务器的 minVersion 要求。

**Q: 修改 HelpV2.tsx 会影响服务器检查吗？**

A: 不会。HelpV2.tsx 只是纯本地 UI 显示组件，不向服务器发送任何数据。服务器检查由 autoUpdater.ts、bridgeEnabled.ts 等文件处理。

**Q: 如果我想添加新的 UI 组件显示版本号，应该用哪个？**

A: 使用 `MACRO.DISPLAY_VERSION ?? MACRO.VERSION`，这样可以优先显示真实版本（1.0.0），同时有回退保护。

**Q: 遥测数据中的版本号应该用什么？**

A: 发送到 Anthropic 的遥测数据必须使用 `MACRO.VERSION`（99.0.0），以确保服务器正确处理。

## 7. 参考

- 构建脚本：`scripts/build.ts`（第 55-67 行）
- 版本检查：`src/utils/autoUpdater.ts`（第 71-100 行）
- 归因头生成：`src/constants/system.ts`（第 76-98 行）
- User-Agent：`src/utils/http.ts`（第 18-52 行）