# 禁用首页 YWCODER Logo 渲染

## 改动说明

- **目标**：启动时不再打印大大的 `YWCODER` ASCII logo。
- **方案**：注释 `src/components/StartupScreen.ts` 中负责绘制 logo 的 `for` 循环，保留下方的 Provider / Model / Endpoint 信息框、状态行和版本号。
- **影响范围**：仅影响终端启动视觉，不改动任何业务逻辑。

## 相关文件

- `src/components/StartupScreen.ts`（第 146~149 行附近）

## 如何恢复

### 方式一：直接应用反向补丁

```bash
git apply -R note/appearance-disable-ywcoder-logo/disable-ywcoder-logo.patch
```

### 方式二：手动取消注释

编辑 `src/components/StartupScreen.ts`，把以下注释恢复为正常代码：

```ts
// 放开for循环显示YWCODER logo
//   for (const line of LOGO_LINES) {
//     out.push(`  ${COL_LOGO}${line}${RESET}`)
//   }
```

恢复为：

```ts
// YW logo — single color, no per-character gradient (avoids color issues)
for (const line of LOGO_LINES) {
  out.push(`  ${COL_LOGO}${line}${RESET}`)
}
```

## 备注

- 当前注释文案里带有"放开for循环显示YWCODER logo"，是临时标注，恢复时建议同步清理。
- 如果想**完全**去掉整个启动屏（包括信息框），则应走方案 A：注释 `src/entrypoints/cli.tsx` 中的 `printStartupScreen()` 调用。
