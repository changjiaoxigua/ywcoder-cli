# ASCII 艺术渲染页面完整报告

- **修改日期**：2026/07/03
- **版本号**：v1.2.1-dev.7b532c0
- **分支**：feature/brand-replacement

## 改动目标

禁用所有 ASCII 艺术渲染页面，仅保留 `StartupScreen` 的 Tagline + Provider / Model / Endpoint 信息框。同时将剩余代码中的 `"OPEN CLAUDE"` 字样改为 `"YwCoder"`。

---

## 汇总表

### LogoV2 目录

| 文件 | 内容 | 触发方式 | 本次改动 | 状态 |
|------|------|----------|----------|------|
| `WelcomeV2.tsx` | 云/星/月亮/牛图案 + "Welcome to YwCoder" | 原在 `Onboarding.tsx` (line 18,203) 和 `cli/handlers/util.tsx` (line 10,30)，Onboarding 流程启动时渲染 | 已注释（v1.2.1-dev.7b532c0，见 `disable-ywcoder-welcome-v2.md`） | **已禁用** |
| `LogoV2.tsx` | "OPEN CLAUDE" + "YwCoder" 边框标题 + "Welcome to YwCoder" + Clawd + Feed 列 | `Messages.tsx:679` 作为 `LogoHeader`，消息列表顶部；有 release notes 或 onboarding 时显示完整版 | `"OPEN CLAUDE"` → `"YwCoder"`；该组件已是死代码（`Messages.tsx` 中 `LogoHeader` 已移除 `<LogoV2 />` 渲染，commit `9d464f3`） | **已是死代码** |
| `CondensedLogo.tsx` | "OPEN CLAUDE" + "Open terminal for any LLM" + Clawd（精简版） | `LogoV2.tsx:190`，当无 release notes 且无 onboarding 且未设 `CLAUDE_CODE_FORCE_FULL_LOGO=1` 时 | `"OPEN CLAUDE"` → `"YwCoder"`（2处）；该组件已是死代码 | **已是死代码** |
| `Clawd.tsx` | Clawd 字符画 `╭◌ ◌╮` + "OC" 身体，多 pose 变体 | 被 LogoV2/CondensedLogo/AnimatedClawd 内部引用，不独立触发 | 未改动（父组件已是死代码） | **已是死代码** |
| `AnimatedClawd.tsx` | 可点击交互 Clawd（跳跃、环视动画） | `CondensedLogo.tsx:84`，当 `isFullscreenEnvEnabled()` 为 true 时; 仅在交替屏幕/全屏模式下可点击 | 未改动（父组件已是死代码） | **已是死代码** |
| `AnimatedAsterisk.tsx` | ✻ 色相旋转动画字符（红→橙→黄→绿→蓝→紫，1.5s/轮，共 2 轮，最终停在灰色） | 作为 `VoiceModeNotice` 和 `Opus1mMergeNotice` 的子组件出现 | 未改动（通知组件保留，仅字符动画） | **保留** |

### 其他位置

| 文件 | 内容 | 触发方式 | 本次改动 | 状态 |
|------|------|----------|----------|------|
| `StartupScreen.ts` | 大号 YWCODER 块字符 logo（`█` 拼字）+ Tagline + 信息框 | CLI 启动时最先输出（`entrypoints/cli.tsx:167-168`），Ink UI 挂载前 `process.stdout.write()` | 未改动（logo 行已在之前注释，tagline + 信息框保留） | **保留（仅信息框）** |
| `Grove/Grove.tsx` | `NEW_TERMS_ASCII` — 条款更新弹窗的 ASCII 对话框 | 启动时条件弹出（`interactiveHelpers.tsx:204`），`isQualifiedForGrove()` 判断；或 `/privacy-settings` 手动触发 | 注释 `NEW_TERMS_ASCII` 常量及渲染行 | **已禁用 ASCII** |
| `Passes/Passes.tsx` | Guest Pass 票券 ASCII 图 `┌──────────┐` | `/passes` 命令（`commands/passes/passes.tsx:22`） | 注释 `renderTicket` 函数及调用 | **已禁用 ASCII** |
| `logoV2Utils.ts` | `formatWelcomeMessage()` 中 "Welcome to YwCoder" 默认文案 | 被 LogoV2 调用，作为工具函数 | 未改动（调用方已是死代码） | **已是死代码** |
| `thinkback.tsx` | 年度回顾 "personalized ASCII animation" | `/thinkback` 命令 | 注释 `commands.ts` 中的 import 和命令注册（功能依赖 Anthropic 内部仓库无法访问） | **已禁用** |

### Messages.tsx 清理

| 文件 | 内容 | 本次改动 |
|------|------|----------|
| `Messages.tsx:36` | `import { LogoV2 } from './LogoV2/LogoV2.js'` | 注释死导入 |

---

## 各页面渲染效果

### 1. StartupScreen — YWCODER 块字符 Logo（已注释，不显示）

```
 █     █ █     █  █████  ███████ ██████  ███████ ██████ 
  █   █  █  █  █ █     █ █     █ █     █ █       █     █ 
   █ █   █  █  █ █       █     █ █     █ █       █     █ 
    █    █  █  █ █       █     █ █     █ █████   ██████   
    █    █  █  █ █       █     █ █     █ █       █   █  
    █    █  █  █ █     █ █     █ █     █ █       █    █  
    █     ██ ██   █████  ███████ ██████  ███████ █     █ 
```

### 2. StartupScreen — Tagline + 信息框（当前生效，保留）

```
✦ ✦ ✦ 数据中心·运维支持部出品 ✦ ✦ ✦ 

  ┌────────────────────────────────────────────────┐
  │ Provider  OpenAI                               │
  │ Model     gpt-4o                               │
  │ Endpoint  https://api.openai.com/v1            │
  ├────────────────────────────────────────────────┤
  │ ● cloud    Ready — type /help to begin         │
  └────────────────────────────────────────────────┘
  YwCoder v1.2.1-dev.7b532c0
```

### 3. WelcomeV2 — ASCII 艺术欢迎图（已禁用）

```
Welcome to YwCoder v1.2.1-dev
⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯
                                                          
     *                                       █████▒▒░     
                                 *         ███▒░     ░░   
            ░░░░░░                        ███▒░           
    ░░░   ░░░░░░░░░░                      ███▒░           
   ░░░░░░░░░░░░░░░░░░░    *                ██▒░░      ▓   
                                             ░▒▒███▒▒░    
 *                                 ░░░░                   
                                 ░░░░░░░░                 
                               ░░░░░░░░░░░░░░░░           
                           ░░░░                     ██    
                         ░░░░░░░░░░               ██▒▒██  
                                            ▒▒      ██   ▒
                                          ▒▒░░▒▒      ▒ ▒▒
      █████████                          ▒▒         ▒▒ 
      ██▄█████▄██                                     ▒   
      █████████                          ░          ▒   
                                                      * 
      █████████                        *                
      ██▄█████▄██                                       
      █████████      *                                  
⋯⋯⋯⋯⋯⋯⋯█ █   █ █⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯
```

> 元素：░ 云、█ 山/牛身、▒ 山/地、* 星星、█ █ █ █ 牛腿

### 4. LogoV2 — 完整版（已是死代码，不显示）

```
  ┌─ YwCoder v1.2.1 ──────────────────────────────────────────────┐
  │                                                                │
  │         YwCoder                                            │
  │    open terminal for any LLM         │  Recent Activity        │
  │              •                       │  · Fix bug in login...  │
  │      Welcome back, username          │  · Add feature X        │
  │                                      │  · Refactor module Y    │
  │           ╭◌ ◌ ╮                      │                         │
  │           ┆ OC  ┆                     │  What's New            │
  │           ╰─◠─╯                      │  · v1.2.1 changelog    │
  │                                      │  · v1.2.0 changelog    │
  │        ────────────                  │  · v1.1.9 changelog    │
  │        Model  gpt-5.4 (high)         │                         │
  │        Path   ~/code/project         │                         │
  └────────────────────────────────────────────────────────────────┘
```

### 5. CondensedLogo — 精简版（已是死代码，不显示）

```
  ┌──────────────────────────┐
  │ •        YwCoder       │
  │ ╭◌ ◌ ╮   Open terminal   │
  │ ┆ OC  ┆   for any LLM    │
  │ ╰─◠─╯                    │
  │ •        YwCoder       │
  │          v1.2.1          │
  │                          │
  │ Model  gpt-5.4 · API     │
  │ Path   ~/code/project    │
  └──────────────────────────┘
```

### 6. LogoV2 — compact 模式（<70 列窄终端，已是死代码，不显示）

```
  ┌─ YwCoder ──────────────────────────────┐
  │          Welcome back, username         │
  │               ╭◌ ◌ ╮                    │
  │               ┆ OC  ┆                   │
  │               ╰─◠─╯                    │
  │          gpt-5.4 (high)                │
  │          API Usage Billing             │
  │          @agent · ~/code/project       │
  └────────────────────────────────────────┘
```

### 7. Clawd — 角色字符画（父组件已是死代码，不显示）

```
  默认:         向左看:        向右看:        举手跳跃:

  ╭◌ ◌ ╮       ╭◔ ◌ ╮       ╭◌ ◔ ╮       \╭◌ ◌ ╮/
  ┆ OC  ┆       ┆ OC  ┆       ┆ OC  ┆        ┆ OC  ┆
  ╰─◠─╯       ╰─◠─╯       ╰─◠─╯        ╰─◠─╯
```

**Apple Terminal 版:**
```
  ▗ ◌ ◌  ▖
  ▔▔▔▔▔▔▔
  ▘▘ ▝▝
```

### 8. Grove — 条款更新弹窗（ASCII 已注释禁用）

```
  _____________
  |          \  \
  | NEW TERMS \__\
  |              |
  |  ----------  |
  |  ----------  |
  |  ----------  |
  |  ----------  |
  |  ----------  |
  |              |
  |______________|
```

### 9. /passes — Guest Pass 票券（ASCII 已注释禁用）

```
  可用:                  已兑换:
  ┌──────────┐          ┌─────────╱
  ) CC ✻ ┊ (           ) CC ✻ ┊╱
  └──────────┘          └───────╱
```

### 10. AnimatedAsterisk — ✻ 动画字符（保留，作为通知组件的一部分）

```
  静止态: ✻ (灰色 #999)
  动画: 色相旋转 红→橙→黄→绿→蓝→紫, 1.5s/轮 × 2 轮, 最终停在灰色
```

---

## 本次改动文件清单

| 文件 | 改动 |
|------|------|
| `src/components/LogoV2/CondensedLogo.tsx` | line 91, 144: `"OPEN CLAUDE"` → `"YwCoder"` |
| `src/components/LogoV2/LogoV2.tsx` | line 367: `"OPEN CLAUDE"` → `"YwCoder"` |
| `src/components/grove/Grove.tsx` | line 16-26: 注释 `NEW_TERMS_ASCII` 常量; line 279: 注释渲染行 |
| `src/components/Passes/Passes.tsx` | line 135-154: 注释 `renderTicket` 函数; line 162: 注释调用处 |
| `src/components/Messages.tsx` | line 36: 注释死导入 `import { LogoV2 }` |
| `src/commands.ts` | line 127-128: 注释 thinkback 导入; line 338-339: 注释命令注册 |

---

## 和之前 logo patch 的区别

| 项目 | `disable-ywcoder-logo.patch` | `disable-ywcoder-welcome-v2.md` | 本次改动 |
|------|------------------------------|----------------------------------|----------|
| 屏蔽对象 | `StartupScreen.ts` 中 YWCODER 块字符 logo | `WelcomeV2` 组件 ASCII 艺术欢迎图 | Grove/Psses 装饰 ASCII + thinkback 命令 + 死代码清理 + "OPEN CLAUDE"→"YwCoder" |
| 是否保留信息框 | 保留 | 保留 | 保留 |
| 改动方式 | 注释 for 循环 | 注释 import 和 JSX | 注释常量/函数/导入/命令注册 |
| 是否可恢复 | 取消注释即可 | 取消注释即可 | 取消注释即可 |

---

## 如何恢复

分别编辑各文件，取消对应注释即可（详见上表各文件改动说明），恢复后重新执行 `bun run build`。

## 备注

- 所有改动均采用注释方式保留原代码，不删除。
- `LogoV2.tsx`、`CondensedLogo.tsx`、`Clawd.tsx`、`AnimatedClawd.tsx` 经代码追踪确认为死代码（`Messages.tsx` 的 `LogoHeader` 已移除对 `<LogoV2 />` 的渲染），未做额外禁用。
- `/thinkback` 命令依赖 `anthropics/claude-code-marketplace` 内部仓库，用户无法访问，故一并注释。
- 如需更长期的开关控制，建议改为环境变量或 feature flag 方案。
