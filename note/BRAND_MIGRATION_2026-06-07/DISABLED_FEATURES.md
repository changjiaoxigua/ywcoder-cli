# 已禁用功能清单（D5）

**目的**: 内网暂不提供的 Anthropic 云/账号/专有功能，全部禁用并隐藏。本表记录【功能 → 禁用方式 → 将来如何重启用（接 YwCoder）】。
**原则**: 不删代码，注释/守卫/flag 可一行回滚。
**最后更新**: 2026-06-08

---

## A. 本次显式禁用（YwCoder 守卫）

| 功能 | 文件 | 禁用方式 | 重启用方式 |
|------|------|---------|-----------|
| `/think-back` 年度回顾 | [thinkback/index.ts](../../src/commands/thinkback/index.ts) | `isEnabled: () => false` | 改回 statsig gate 或接 YwCoder 生成服务 |
| `/feedback`·`/bug` 反馈 | [feedback/index.ts](../../src/commands/feedback/index.ts) | `isEnabled: () => false` | 接内网反馈渠道后改回条件 |
| `/passes` 订阅返利 | [passes/index.ts](../../src/commands/passes/index.ts) | `isEnabled: () => false` | Anthropic 订阅专有，一般不重启用 |
| `/desktop`·`/app` 桌面端续接 | [desktop/index.ts](../../src/commands/desktop/index.ts) | `isEnabled: () => false`（另有 availability gate） | Anthropic 专有 |
| `/chrome` 浏览器集成 | [chrome/index.ts](../../src/commands/chrome/index.ts) | `isEnabled: () => false`（另有 availability gate） | Anthropic 专有 |
| 桌面端升级弹窗（启动） | [DesktopUpsellStartup.tsx:25](../../src/components/DesktopUpsell/DesktopUpsellStartup.tsx) | `shouldShowDesktopUpsellStartup()` 顶部 `return false`，原逻辑注释保留 | 删守卫即恢复 |
| `/model` 硬编码 Anthropic 模型（payg3p） | [modelOptions.ts:474+](../../src/utils/model/modelOptions.ts) | 注释掉 Sonnet/Opus/Haiku 兜底 push，保留自定义映射 | 取消注释即恢复 |
| CLI `auth login` / `auth logout` | [main.tsx:4086/4117](../../src/main.tsx) | `if (false)` 守卫（`auth status` 保留） | 改 `if (true)` 恢复 |
| CLI `install`（下载上游官方 CC） | [main.tsx:4380](../../src/main.tsx) | `if (false)` 守卫 | 改 `if (true)` 恢复 |
| CLI `mcp add-from-claude-desktop` | [main.tsx:3930](../../src/main.tsx) | `if (false)` 守卫 | 改 `if (true)` 恢复 |
| `/insights` 会话分析报告 | [commands.ts:194](../../src/commands.ts) | `isEnabled: () => false` | 做内网启用适配（去 S3 上传或接内网存储）后改回 |
| 在线更新 · CLI `update`/`upgrade` | [main.tsx:4350](../../src/main.tsx) | action 改打印「暂未开启在线更新。请联系管理员获取新版本。」；移除对 `cli/update.js` 的动态 import（update.ts 被 tree-shake 移出 dist） | 恢复 `import('src/cli/update.js')` + `await update()` |
| 在线更新 · 后台 auto-updater（每 30 分钟轮询 GCS） | [config.ts:1792](../../src/utils/config.ts) `getAutoUpdaterDisabledReason()` | 默认分支 `return null`（启用）→ `return { type: 'ywcoder' }`（恒禁）；`isAutoUpdaterDisabled()` 随之恒真，Native/PackageManager updater 发网络前早退。`/doctor` 显示「暂未开启在线更新」 | 改回 `return null` 即恢复 |

## B. 已被现有机制禁用（无需改动，仅记录）

| 功能 | 既有 gate | 说明 |
|------|----------|------|
| `/ultraplan` | `isEnabled: () => "external"==='ant'` | 恒 false |
| `/ultrareview` | `isUltrareviewEnabled()`（statsig gate 返回 null） | 恒 false |
| `/stickers` | `isEnabled: () => false`（早前已禁） | 已禁 |
| `/remote-setup`·`/upgrade`·`/usage`·`/install-slack-app`·`/voice` | `availability: ['claude-ai']` → 仅 `isYwCoderSubscriber()` 为真才显示 | 内网无 Anthropic 认证，全部隐藏 |
| `TranscriptSharePrompt`（"Can Anthropic look at your transcript"） | [useMemorySurvey.tsx:90](../../src/components/FeedbackSurvey/useMemorySurvey.tsx) `if ("external"!=='ant') return false` | 恒不展示（记忆调查其余部分保留） |
| Teleport（`--teleport`/CCR） | feature flag（未列出 → 默认 false） | 编译期关闭 |
| KAIROS Channels（`ChannelsNotice`） | `KAIROS`/`KAIROS_CHANNELS` flag = false | 编译期关闭 |
| Bridge / Daemon / BG sessions / SSH remote / Web browser tool | build.ts featureFlags = false + stub 模块 | 编译期关闭/抛错 |
| `standardOptions`·`payg1POptions` 中的 Anthropic 模型 | `isMaxSubscriber()`/`getAPIProvider()==='firstParty'` | 内网无 firstParty 认证，不可达（休眠） |
| `getClaudeAiUserDefaultModelDescription` | 仅 firstParty/claude.ai 默认项 | 休眠 |
| `mcp xaa`（XAA/SEP-990 IdP 子命令） | [main.tsx:3898](../../src/main.tsx) `if (isXaaEnabled())` 守卫；`isXaaEnabled()` = env `ENABLE_XAA` 默认关 | Anthropic 专有跨账号 IdP，内网无。子命令注册已被现有 env 门控，默认不注册/不可见（2026-06-09 Phase B 核实，无需改动）。dist 中 `mcp xaa`×5 为 runtime-gated 残留字符串 |

## C. 🔶 待你拍板 / 后续处理

| 事项 | 现状 | 建议 |
|------|------|------|
| `ConsoleOAuthFlow` | Anthropic Console 登录流程，firstParty 触发，内网休眠 | 已休眠;如要彻底可在登录入口守卫 |
| `cost` 文案 | 命令本地保留，但含 Anthropic 订阅/overage 文案（仅订阅者可见，休眠） | 低优先级:软化文案 |

> CLI 子命令 `auth login`/`auth logout`、`install`、`add-from-claude-desktop`、`/insights` 已于本批禁用，见 A 节。

## D. 验证

- `bun run build` ✅ / `bun test --max-concurrency=1` → 562 pass / 0 fail（本次禁用后）
- 复核命令是否消失:启动后 `/help` 不应再出现上述 A/B 命令。
