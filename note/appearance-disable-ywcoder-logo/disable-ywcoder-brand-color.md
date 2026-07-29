# 关闭 YwCoder 品牌标识色

## 修改内容

文件：`src/utils/theme.ts`

将 `claude`（主品牌色）和 `claudeShimmer`（高亮色）从橙色改为绿色，避免 CLI 加载图标显示 YwCoder/OpenClaude 品牌橙。
旧值保留为注释，便于回滚。

### lightTheme（浅色主题）

| 字段 | 改前 | 改后 |
|---|---|---|
| `claude` | `'rgb(215,119,87)'` | `'rgb(127,179,130)'` |
| `claudeShimmer` | `'rgb(245,149,117)'` | `'rgb(147,209,160)'` |

位置：`src/utils/theme.ts:118-121`

### darkTheme（深色主题）

| 字段 | 改前 | 改后 |
|---|---|---|
| `claude` | `'rgb(215,119,87)'` | `'rgb(127,179,130)'` |
| `claudeShimmer` | `'rgb(235,159,127)'` | `'rgb(157,209,160)'` |

位置：`src/utils/theme.ts:445-448`

## 影响范围

`claude` 是主题主品牌键，被多处 UI 引用，包括但不限于：

- 加载 spinner 左侧旋转图标颜色（`src/components/Spinner/SpinnerGlyph.tsx`）
- 加载消息文本的 glimmer/shimmer 效果（`src/components/Spinner/GlimmerMessage.tsx`）
- 其它以 `claude` 为默认颜色的组件

因此本次改动会同时改变加载图标和消息文本的色调。

## 启动屏橙色元素

文件：`src/components/StartupScreen.ts`

欢迎页的橙色元素（顶部星星、Provider 值、状态圆点、`/help` 提示、版本号）由 256 色 `COL_ACCENT` 控制。

| 字段 | 改前 | 改后 |
|---|---|---|
| `COL_ACCENT` | `c(173)`（LightSalmon） | `c(114)`（鲜绿色） |

位置：`src/components/StartupScreen.ts:22`

原 `c(173)` 已注释保留，未删除。

## 备注

- `theme.ts` 和 `StartupScreen.ts` 中旧颜色值均已注释保留，未删除。
- 如果只想改 thinking 文本的灰色，应改 `src/components/Spinner/SpinnerAnimationRow.tsx` 里的 `THINKING_INACTIVE` / `THINKING_INACTIVE_SHIMMER`，而不是 theme 的 `claude`。
