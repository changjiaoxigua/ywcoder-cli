# 品牌替换人工复核项

**生成时间**: 2026-06-07
**总数**: 30 项

---

- src/bridge/trustedDevice.ts:150 — 文件路径含跳过目录: bridge/
  ```
  { display_name: `Claude Code on ${hostname()} · ${process.platform}` },
  ```

- src/bridge/envLessBridgeConfig.ts:150 — 文件路径含跳过目录: bridge/
  ```
  return `Your version of Claude Code (${MACRO.VERSION}) is too old for Remote Control.\nVersion ${cfg.min_version} or higher is required. Run \`claude update\` to update.`
  ```

- src/constants/product.ts:3 — 文件路径含跳过目录: constants/product.ts
  ```
  // Claude Code Remote session URLs
  ```

- src/bridge/bridgeEnabled.ts:169 — 文件路径含跳过目录: bridge/
  ```
  return `Your version of Claude Code (${MACRO.VERSION}) is too old for Remote Control.\nVersion ${config.minVersion} or higher is required. Run \`claude update\` to update.`
  ```

- src/constants/oauth.ts:109 — 文件路径含跳过目录: constants/oauth.ts
  ```
  * Claude Code uses this URL as its client_id instead of Dynamic Client Registration.
  ```

- src/utils/sideQuery.ts:54 — 外部 Anthropic 产品 token: OAuth
  ```
  /** Skip CLI system prompt prefix (keeps attribution header for OAuth). Default true — side queries are internal classifiers with their own prompt. Set false only for queries that need the full "You are Claude Code…" prefix. */
  ```

- src/utils/secureStorage/keychainPrefetch.ts:7 — 外部 Anthropic 产品 token: OAuth
  ```
  *   1. "Claude Code-credentials" (OAuth tokens)  — ~32ms
  ```

- src/utils/secureStorage/keychainPrefetch.ts:8 — keychain/secureStorage 硬编码服务名
  ```
  *   2. "Claude Code" (legacy API key)            — ~33ms
  ```

- src/utils/deepLink/registerProtocol.ts:34 — deepLink 协议注册标识（功能性）
  ```
  const APP_NAME = 'Claude Code URL Handler'
  ```

- src/utils/deepLink/registerProtocol.ts:36 — deepLink 协议注册标识（功能性）
  ```
  const MACOS_APP_NAME = 'Claude Code URL Handler.app'
  ```

- src/utils/deepLink/registerProtocol.ts:111 — deepLink 协议注册标识（功能性）
  ```
  <string>Claude Code Deep Link</string>
  ```

- src/utils/deepLink/registerProtocol.ts:149 — deepLink 协议注册标识（功能性）
  ```
  Comment=Handle ${DEEP_LINK_PROTOCOL}:// deep links for Claude Code
  ```

- src/cli/update.ts:34 — 指向上游官方 Claude Code
  ```
  // YwCoder build (with the OpenAI shim) with the upstream Claude Code
  ```

- src/utils/telemetry/perfettoTracing.ts:2 — perfettoTracing（Ant-only）
  ```
  * Perfetto Tracing for Claude Code (Ant-only)
  ```

- src/utils/telemetry/perfettoTracing.ts:19 — perfettoTracing（Ant-only）
  ```
  * 3. Run Claude Code normally
  ```

- src/components/DesktopUpsell/DesktopUpsellStartup.tsx:93 — 文件路径含跳过目录: DesktopUpsell
  ```
  label: "Open in Claude Code Desktop",
  ```

- src/components/DesktopUpsell/DesktopUpsellStartup.tsx:123 — 文件路径含跳过目录: DesktopUpsell
  ```
  t6 = <Box marginBottom={1}><Text>Same Claude Code with visual diffs, live app preview, parallel sessions, and more.</Text></Box>;
  ```

- src/components/DesktopUpsell/DesktopUpsellStartup.tsx:138 — 文件路径含跳过目录: DesktopUpsell
  ```
  t8 = <PermissionDialog title="Try Claude Code Desktop"><Box flexDirection="column" paddingX={2} paddingY={1}>{t6}<Select options={options} onChange={handleSelect} onCancel={t7} /></Box></PermissionDialog>;
  ```

- src/hooks/notifs/useCanSwitchToExistingSubscription.tsx:33 — 外部 Anthropic 产品 token: subscription
  ```
  jsx: <Text color="suggestion">Use your existing Claude {subscriptionType} plan with Claude Code<Text color="text" dimColor={true}>{" "}· /login to activate</Text></Text>,
  ```

- src/commands/review.ts:6 — 外部 Anthropic 产品 token: web
  ```
  // user triggers, so the description carries "Claude Code on the web" + URL.
  ```

- src/skills/bundled/scheduleRemoteAgents.ts:176 — Remote Agent（Anthropic 云服务）
  ```
  You are helping the user schedule, update, list, or run **remote** Claude Code agents. These are NOT local cron jobs — each trigger spawns a fully isolated remote session (CCR) in Anthropic's cloud infrastructure on a cron schedule. The agent runs in a sandboxed environment with its own git checkout, tools, and optional MCP connections.
  ```

- src/skills/bundled/scheduleRemoteAgents.ts:330 — Remote Agent（Anthropic 云服务）
  ```
  'When the user wants to schedule a recurring remote agent, set up automated tasks, create a cron job for Claude Code, or manage their scheduled agents/triggers.',
  ```

- ~~src/services/rateLimitMessages.ts:282 — rate limit upsell（Anthropic 订阅）~~ **【已裁决：改】**
  Pro/Max 限流告警活跃路径，用户可见。"keep using Claude Code" 中 Claude Code 指本工具自身，
  非外部产品/订阅；`/upgrade` 命令保留。已改为 `'/upgrade to keep using YwCoder'`（d343ff6 复核修）。
  ```
  return '/upgrade to keep using Claude Code'  →  '/upgrade to keep using YwCoder'
  ```

- src/services/voiceStreamSTT.ts:6 — 外部 Anthropic 产品 token: OAuth
  ```
  // OAuth credentials as Claude Code.  The endpoint uses conversation_engine
  ```

- src/services/voiceStreamSTT.ts:99 — 外部 Anthropic 产品 token: OAuth
  ```
  // voice_stream uses the same OAuth as Claude Code — available when the
  ```

- src/services/mcp/useManageMCPConnections.ts:857 — 硬性护栏命中: claude.ai
  ```
  // Two-phase loading: Claude Code configs first (fast), then claude.ai configs (may be slow)
  ```

- src/services/mcp/config.ts:1063 — 硬性护栏命中: claude.ai
  ```
  * Get Claude Code MCP configurations (excludes claude.ai servers from the
  ```

- src/services/tips/tipRegistry.ts:386 — 已禁用的 tip 注释
  ```
  // 'Paste images into Claude Code using control+v (not cmd+v!)'
  ```

- src/services/tips/tipRegistry.ts:489 — 外部 Anthropic 产品 token: Desktop
  ```
  return `Continue your session in Claude Code Desktop with ${blue('/desktop')}`
  ```

- src/services/api/firstTokenDate.ts:10 — 外部 Anthropic 产品 token: login
  ```
  * This is called after successful login to cache when they started using Claude Code.
  ```

- src/commands/install.tsx — 安装上游官方 Claude Code（已禁用命令，内网不可达）
  ```
  多行用户可见字符串：安装进度、成功/失败提示、命令描述等
  ```

- src/commands/stickers/index.ts:6 — 外部周边商品
  ```
  description: '订购 Claude Code 贴纸',
  ```

- src/commands/ultraplan.tsx — CCR（Claude Code Remote）云服务， Anthropic 云端会话
  ```
  多行用户可见字符串："Claude Code on the web"
  ```

- src/constants/github-app.ts — 安装 Claude Code GitHub App 工作流（外部产品）
  ```
  多行：PR 标题/正文、workflow 名称均指向 anthropics/claude-code-action
  ```

- src/components/WorkflowMultiselectDialog.tsx:21,24 — GitHub App 工作流标签（外部 bot handle @claude）
  ```
  label: '@Claude Code - Tag @claude in issues and PR comments'
  label: 'Claude Code Review - Automated code review on new PRs'
  ```

- src/commands/install-github-app/setupGitHubActions.ts:236 — GitHub 提交信息（与 workflow 内容不一致）
  ```
  message: 'Claude Code Review workflow',
  ```

- src/utils/claudeInChrome/setup.ts:184,201 — Chrome Native Messaging Host 功能性路径/描述
  ```
  return [join(appData, 'Claude Code', 'ChromeNativeHost')]
  description: 'Claude Code Browser Extension Native Host',
  ```

- src/utils/secureStorage/macOsKeychainHelpers.ts:44 — macOS 钥匙串硬编码服务名（功能性）
  ```
  return `Claude Code${getOauthConfig().OAUTH_FILE_SUFFIX}...`
  ```

- src/utils/secureStorage/platformStorage.test.ts:46 — 钥匙串服务名单元测试
  ```
  expect(otherName).toContain("Claude Code");
  ```

- src/tools/RemoteTriggerTool/prompt.ts:4 — Remote Agent 提示词（Anthropic CCR 外部服务）
  ```
  'Manage scheduled remote Claude Code agents (triggers) via the claude.ai CCR API.'
  ```

- src/main.tsx:4382 — 注释说明 install 命令已禁用原因（指向上游）
  ```
  // YwCoder: 禁用 — install 实为从 Anthropic GCS 下载上游官方 Claude Code
  ```
