import chalk from 'chalk'
import { logForDebugging } from 'src/utils/debug.js'
import { fileHistoryEnabled } from 'src/utils/fileHistory.js'
import {
  getInitialSettings,
  getSettings_DEPRECATED,
  getSettingsForSource,
} from 'src/utils/settings/settings.js'
import { shouldOfferTerminalSetup } from '../../commands/terminalSetup/terminalSetup.js'
import { getDesktopUpsellConfig } from '../../components/DesktopUpsell/DesktopUpsellStartup.js'
import { color } from '../../components/design-system/color.js'
import { shouldShowOverageCreditUpsell } from '../../components/LogoV2/OverageCreditUpsell.js'
import { getShortcutDisplay } from '../../keybindings/shortcutFormat.js'
import { isKairosCronEnabled } from '../../tools/ScheduleCronTool/prompt.js'
import { is1PApiCustomer } from '../../utils/auth.js'
import { countConcurrentSessions } from '../../utils/concurrentSessions.js'
import { getGlobalConfig } from '../../utils/config.js'
import {
  getEffortEnvOverride,
  modelSupportsEffort,
} from '../../utils/effort.js'
import { env } from '../../utils/env.js'
import { cacheKeys } from '../../utils/fileStateCache.js'
import { getWorktreeCount } from '../../utils/git.js'
import {
  detectRunningIDEsCached,
  getSortedIdeLockfiles,
  isCursorInstalled,
  isSupportedTerminal,
  isSupportedVSCodeTerminal,
  isVSCodeInstalled,
  isWindsurfInstalled,
} from '../../utils/ide.js'
import {
  getMainLoopModel,
  getUserSpecifiedModelSetting,
} from '../../utils/model/model.js'
import { getPlatform } from '../../utils/platform.js'
import { isPluginInstalled } from '../../utils/plugins/installedPluginsManager.js'
import { loadKnownMarketplacesConfigSafe } from '../../utils/plugins/marketplaceManager.js'
import { OFFICIAL_MARKETPLACE_NAME } from '../../utils/plugins/officialMarketplace.js'
import {
  getCurrentSessionAgentColor,
  isCustomTitleEnabled,
} from '../../utils/sessionStorage.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../analytics/growthbook.js'
import {
  formatGrantAmount,
  getCachedOverageCreditGrant,
} from '../api/overageCreditGrant.js'
import {
  checkCachedPassesEligibility,
  formatCreditAmount,
  getCachedReferrerReward,
} from '../api/referral.js'
import { getSessionsSinceLastShown } from './tipHistory.js'
import type { Tip, TipContext } from './types.js'

let _isOfficialMarketplaceInstalledCache: boolean | undefined
async function isOfficialMarketplaceInstalled(): Promise<boolean> {
  if (_isOfficialMarketplaceInstalledCache !== undefined) {
    return _isOfficialMarketplaceInstalledCache
  }
  const config = await loadKnownMarketplacesConfigSafe()
  _isOfficialMarketplaceInstalledCache = OFFICIAL_MARKETPLACE_NAME in config
  return _isOfficialMarketplaceInstalledCache
}

async function isMarketplacePluginRelevant(
  pluginName: string,
  context: TipContext | undefined,
  signals: { filePath?: RegExp; cli?: string[] },
): Promise<boolean> {
  if (!(await isOfficialMarketplaceInstalled())) {
    return false
  }
  if (isPluginInstalled(`${pluginName}@${OFFICIAL_MARKETPLACE_NAME}`)) {
    return false
  }
  const { bashTools } = context ?? {}
  if (signals.cli && bashTools?.size) {
    if (signals.cli.some(cmd => bashTools.has(cmd))) {
      return true
    }
  }
  if (signals.filePath && context?.readFileState) {
    const readFiles = cacheKeys(context.readFileState)
    if (readFiles.some(fp => signals.filePath!.test(fp))) {
      return true
    }
  }
  return false
}

const externalTips: Tip[] = [
  {
    id: 'new-user-warmup',
    content: async () =>
      // 'Start with small features or bug fixes, tell Claude to propose a plan, and verify its suggested edits'
      `从小功能或 bug 修复开始，让 YwCoder 先提出计划，然后确认它的修改建议`,
    cooldownSessions: 3,
    async isRelevant() {
      const config = getGlobalConfig()
      return config.numStartups < 10
    },
  },
  {
    id: 'plan-mode-for-complex-tasks',
    content: async () =>
      // `Use Plan Mode to prepare for a complex request before making changes. Press ${getShortcutDisplay('chat:cycleMode', 'Chat', 'shift+tab')} twice to enable.`
      `执行复杂任务前，先切换到计划模式规划方案。按 ${getShortcutDisplay('chat:cycleMode', 'Chat', 'shift+tab')} 两次启用`,
    cooldownSessions: 5,
    isRelevant: async () => {
      if (process.env.USER_TYPE === 'ant') return false
      const config = getGlobalConfig()
      // Show to users who haven't used plan mode recently (7+ days)
      const daysSinceLastUse = config.lastPlanModeUse
        ? (Date.now() - config.lastPlanModeUse) / (1000 * 60 * 60 * 24)
        : Infinity
      return daysSinceLastUse > 7
    },
  },
  {
    id: 'default-permission-mode-config',
    content: async () =>
      // 'Use /config to change your default permission mode (including Plan Mode)'
      `使用 /config 修改默认权限模式（包括计划模式）`,
    cooldownSessions: 10,
    isRelevant: async () => {
      try {
        const config = getGlobalConfig()
        const settings = getSettings_DEPRECATED()
        // Show if they've used plan mode but haven't set a default
        const hasUsedPlanMode = Boolean(config.lastPlanModeUse)
        const hasDefaultMode = Boolean(settings?.permissions?.defaultMode)
        return hasUsedPlanMode && !hasDefaultMode
      } catch (error) {
        logForDebugging(
          `Failed to check default-permission-mode-config tip relevance: ${error}`,
          { level: 'warn' },
        )
        return false
      }
    },
  },
  {
    id: 'git-worktrees',
    content: async () =>
      // 'Use git worktrees to run multiple Claude sessions in parallel.'
      '使用 git worktree 并行运行多个 YwCoder 会话',
    cooldownSessions: 10,
    isRelevant: async () => {
      try {
        const config = getGlobalConfig()
        const worktreeCount = await getWorktreeCount()
        return worktreeCount <= 1 && config.numStartups > 50
      } catch (_) {
        return false
      }
    },
  },
  {
    id: 'color-when-multi-clauding',
    content: async () =>
      // 'Running multiple Claude sessions? Use /color and /rename to tell them apart at a glance.'
      '同时运行多个 YwCoder 会话？使用 /color 和 /rename 一眼区分它们',
    cooldownSessions: 10,
    isRelevant: async () => {
      if (getCurrentSessionAgentColor()) return false
      const count = await countConcurrentSessions()
      return count >= 2
    },
  },
  {
    id: 'terminal-setup',
    content: async () =>
      // env.terminal === 'Apple_Terminal'
      //   ? 'Run /terminal-setup to enable convenient terminal integration like Option + Enter for new line and more'
      //   : 'Run /terminal-setup to enable convenient terminal integration like Shift + Enter for new line and more'
      env.terminal === 'Apple_Terminal'
        ? '运行 /terminal-setup 以启用终端集成，例如用 Option+Enter 换行等'
        : '运行 /terminal-setup 以启用终端集成，例如用 Shift+Enter 换行等',
    cooldownSessions: 10,
    async isRelevant() {
      const config = getGlobalConfig()
      if (env.terminal === 'Apple_Terminal') {
        return !config.optionAsMetaKeyInstalled
      }
      return !config.shiftEnterKeyBindingInstalled
    },
  },
  {
    id: 'shift-enter',
    content: async () =>
      // env.terminal === 'Apple_Terminal'
      //   ? 'Press Option+Enter to send a multi-line message'
      //   : 'Press Shift+Enter to send a multi-line message'
      env.terminal === 'Apple_Terminal'
        ? '按 Option+Enter 发送多行消息'
        : '按 Shift+Enter 发送多行消息',
    cooldownSessions: 10,
    async isRelevant() {
      const config = getGlobalConfig()
      return Boolean(
        (env.terminal === 'Apple_Terminal'
          ? config.optionAsMetaKeyInstalled
          : config.shiftEnterKeyBindingInstalled) && config.numStartups > 3,
      )
    },
  },
  {
    id: 'shift-enter-setup',
    content: async () =>
      // env.terminal === 'Apple_Terminal'
      //   ? 'Run /terminal-setup to enable Option+Enter for new lines'
      //   : 'Run /terminal-setup to enable Shift+Enter for new lines'
      env.terminal === 'Apple_Terminal'
        ? '运行 /terminal-setup 以启用 Option+Enter 换行'
        : '运行 /terminal-setup 以启用 Shift+Enter 换行',
    cooldownSessions: 10,
    async isRelevant() {
      if (!shouldOfferTerminalSetup()) {
        return false
      }
      const config = getGlobalConfig()
      return !(env.terminal === 'Apple_Terminal'
        ? config.optionAsMetaKeyInstalled
        : config.shiftEnterKeyBindingInstalled)
    },
  },
  {
    id: 'memory-command',
    // content: async () => 'Use /memory to view and manage Claude memory',
    content: async () => '使用 /memory 查看和管理 YwCoder 的记忆',
    cooldownSessions: 15,
    async isRelevant() {
      const config = getGlobalConfig()
      return config.memoryUsageCount <= 0
    },
  },
  {
    id: 'theme-command',
    // content: async () => 'Use /theme to change the color theme',
    content: async () => '使用 /theme 更改配色主题',
    cooldownSessions: 20,
    isRelevant: async () => true,
  },
  {
    id: 'colorterm-truecolor',
    content: async () =>
      // 'Try setting environment variable COLORTERM=truecolor for richer colors'
      '尝试设置环境变量 COLORTERM=truecolor 以获得更丰富的色彩',
    cooldownSessions: 30,
    isRelevant: async () => !process.env.COLORTERM && chalk.level < 3,
  },
  {
    id: 'powershell-tool-env',
    content: async () =>
      // 'Set CLAUDE_CODE_USE_POWERSHELL_TOOL=1 to enable the PowerShell tool (preview)'
      '设置 CLAUDE_CODE_USE_POWERSHELL_TOOL=1 以启用 PowerShell 工具（预览版）',
    cooldownSessions: 10,
    isRelevant: async () =>
      getPlatform() === 'windows' &&
      process.env.CLAUDE_CODE_USE_POWERSHELL_TOOL === undefined,
  },
  {
    id: 'status-line',
    content: async () =>
      // 'Use /statusline to set up a custom status line that will display beneath the input box'
      '使用 /statusline 设置自定义状态栏，显示在输入框下方',
    cooldownSessions: 25,
    isRelevant: async () => getSettings_DEPRECATED().statusLine === undefined,
  },
  {
    id: 'prompt-queue',
    content: async () =>
      // 'Hit Enter to queue up additional messages while Claude is working.'
      'YwCoder 工作时，可按 Enter 继续排队输入消息',
    cooldownSessions: 5,
    async isRelevant() {
      const config = getGlobalConfig()
      return config.promptQueueUseCount <= 3
    },
  },
  {
    id: 'enter-to-steer-in-relatime',
    content: async () =>
      // 'Send messages to Claude while it works to steer Claude in real-time'
      'YwCoder 工作时可随时发消息，实时调整方向',
    cooldownSessions: 20,
    isRelevant: async () => true,
  },
  {
    id: 'todo-list',
    content: async () =>
      // 'Ask Claude to create a todo list when working on complex tasks to track progress and remain on track'
      '处理复杂任务时，让 YwCoder 创建待办清单以追踪进度',
    cooldownSessions: 20,
    isRelevant: async () => true,
  },
  {
    id: 'vscode-command-install',
    content: async () =>
      // `Open the Command Palette (Cmd+Shift+P) and run "Shell Command: Install '${env.terminal === 'vscode' ? 'code' : env.terminal}' command in PATH" to enable IDE integration`
      `打开命令面板（Cmd+Shift+P），运行 "Shell Command: Install '${env.terminal === 'vscode' ? 'code' : env.terminal}' command in PATH" 以启用 IDE 集成`,
    cooldownSessions: 0,
    async isRelevant() {
      // Only show this tip if we're in a VS Code-style terminal
      if (!isSupportedVSCodeTerminal()) {
        return false
      }
      if (getPlatform() !== 'macos') {
        return false
      }

      // Check if the relevant command is available
      switch (env.terminal) {
        case 'vscode':
          return !(await isVSCodeInstalled())
        case 'cursor':
          return !(await isCursorInstalled())
        case 'windsurf':
          return !(await isWindsurfInstalled())
        default:
          return false
      }
    },
  },
  {
    id: 'ide-upsell-external-terminal',
    // content: async () => 'Connect Claude to your IDE · /ide',
    content: async () => '将 YwCoder 接入你的 IDE · /ide',
    cooldownSessions: 4,
    async isRelevant() {
      if (isSupportedTerminal()) {
        return false
      }

      // Use lockfiles as a (quicker) signal for running IDEs
      const lockfiles = await getSortedIdeLockfiles()
      if (lockfiles.length !== 0) {
        return false
      }

      const runningIDEs = await detectRunningIDEsCached()
      return runningIDEs.length > 0
    },
  },
  {
    id: 'install-github-app',
    content: async () =>
      // 'Run /install-github-app to tag @claude right from your Github issues and PRs'
      '运行 /install-github-app 以在 GitHub Issues 和 PR 中使用 @ywcoder',
    cooldownSessions: 10,
    isRelevant: async () => !getGlobalConfig().githubActionSetupCount,
  },
  {
    id: 'install-slack-app',
    // content: async () => 'Run /install-slack-app to use Claude in Slack',
    content: async () => '运行 /install-slack-app 以在 Slack 中使用 YwCoder',
    cooldownSessions: 10,
    isRelevant: async () => !getGlobalConfig().slackAppInstallCount,
  },
  {
    id: 'permissions',
    content: async () =>
      // 'Use /permissions to pre-approve and pre-deny bash, edit, and MCP tools'
      '使用 /permissions 预批准或预拒绝 bash、编辑和 MCP 工具',
    cooldownSessions: 10,
    async isRelevant() {
      const config = getGlobalConfig()
      return config.numStartups > 10
    },
  },
  {
    id: 'drag-and-drop-images',
    content: async () =>
      // 'Did you know you can drag and drop image files into your terminal?'
      '你知道吗？可以直接把图片文件拖拽到终端中',
    cooldownSessions: 10,
    isRelevant: async () => !env.isSSH(),
  },
  {
    id: 'paste-images-mac',
    content: async () =>
      // 'Paste images into YwCoder using control+v (not cmd+v!)'
      '使用 control+v（而非 cmd+v）将图片粘贴到 YwCoder',
    cooldownSessions: 10,
    isRelevant: async () => getPlatform() === 'macos',
  },
  {
    id: 'double-esc',
    content: async () =>
      // 'Double-tap esc to rewind the conversation to a previous point in time'
      '双击 esc 将对话回退到之前的某个时间点',
    cooldownSessions: 10,
    isRelevant: async () => !fileHistoryEnabled(),
  },
  {
    id: 'double-esc-code-restore',
    content: async () =>
      // 'Double-tap esc to rewind the code and/or conversation to a previous point in time'
      '双击 esc 将代码和/或对话回退到之前的某个时间点',
    cooldownSessions: 10,
    isRelevant: async () => fileHistoryEnabled(),
  },
  {
    id: 'continue',
    content: async () =>
      // 'Run claude --continue or claude --resume to resume a conversation'
      '运行 ywcoder --continue 或 ywcoder --resume 以继续之前的对话',
    cooldownSessions: 10,
    isRelevant: async () => true,
  },
  {
    id: 'rename-conversation',
    content: async () =>
      // 'Name your conversations with /rename to find them easily in /resume later'
      '使用 /rename 为对话命名，方便之后在 /resume 中快速找到',
    cooldownSessions: 15,
    isRelevant: async () =>
      isCustomTitleEnabled() && getGlobalConfig().numStartups > 10,
  },
  {
    id: 'custom-commands',
    content: async () =>
      // 'Create skills by adding .md files to .claude/skills/ in your project or ~/.claude/skills/ for skills that work in any project'
      '在项目的 .claude/skills/ 或 ~/.claude/skills/ 中添加 .md 文件，创建可复用的 skill',
    cooldownSessions: 15,
    async isRelevant() {
      const config = getGlobalConfig()
      return config.numStartups > 10
    },
  },
  {
    id: 'shift-tab',
    content: async () =>
      // process.env.USER_TYPE === 'ant'
      //   ? `Hit ${getShortcutDisplay('chat:cycleMode', 'Chat', 'shift+tab')} to cycle between default mode and auto mode`
      //   : `Hit ${getShortcutDisplay('chat:cycleMode', 'Chat', 'shift+tab')} to cycle between default mode, auto-accept edit mode, and plan mode`
      process.env.USER_TYPE === 'ant'
        ? `按 ${getShortcutDisplay('chat:cycleMode', 'Chat', 'shift+tab')} 在默认模式和自动模式之间切换`
        : `按 ${getShortcutDisplay('chat:cycleMode', 'Chat', 'shift+tab')} 在默认模式、自动接受编辑模式和计划模式之间切换`,
    cooldownSessions: 10,
    isRelevant: async () => true,
  },
  {
    id: 'image-paste',
    content: async () =>
      // `Use ${getShortcutDisplay('chat:imagePaste', 'Chat', 'ctrl+v')} to paste images from your clipboard`
      `按 ${getShortcutDisplay('chat:imagePaste', 'Chat', 'ctrl+v')} 从剪贴板粘贴图片`,
    cooldownSessions: 20,
    isRelevant: async () => true,
  },
  {
    id: 'custom-agents',
    content: async () =>
      // 'Use /agents to optimize specific tasks. Eg. Software Architect, Code Writer, Code Reviewer'
      '使用 /agents 针对特定任务优化输出，如：软件架构师、代码编写者、代码评审者',
    cooldownSessions: 15,
    async isRelevant() {
      const config = getGlobalConfig()
      return config.numStartups > 5
    },
  },
  {
    id: 'agent-flag',
    content: async () =>
      // 'Use --agent <agent_name> to directly start a conversation with a subagent'
      '使用 --agent <agent_name> 直接与子 agent 开启对话',
    cooldownSessions: 15,
    async isRelevant() {
      const config = getGlobalConfig()
      return config.numStartups > 5
    },
  },
  {
    id: 'desktop-app',
    content: async () =>
      'Run YwCoder locally or remotely using the Claude desktop app: clau.de/desktop',
    cooldownSessions: 15,
    // YwCoder: 禁用 — 指向 Anthropic Claude Desktop，YwCoder 不提供此功能
    isRelevant: async () => false,
  },
  {
    id: 'desktop-shortcut',
    content: async ctx => {
      const blue = color('suggestion', ctx.theme)
      return `Continue your session in Claude Code Desktop with ${blue('/desktop')}`
    },
    cooldownSessions: 15,
    // YwCoder: 禁用 — /desktop 命令连接 Anthropic Claude Desktop 协议，YwCoder 不提供此功能
    isRelevant: async () => false,
  },
  {
    id: 'web-app',
    content: async () =>
      'Run tasks in the cloud while you keep coding locally · clau.de/web',
    cooldownSessions: 15,
    // YwCoder: 禁用 — 指向 Anthropic 云运行服务，YwCoder 不提供此功能
    isRelevant: async () => false,
  },
  {
    id: 'mobile-app',
    content: async () =>
      '/mobile to use YwCoder from the Claude app on your phone',
    cooldownSessions: 15,
    // YwCoder: 禁用 — /mobile 命令打开 Anthropic Claude 手机 app，YwCoder 不提供此功能
    isRelevant: async () => false,
  },
  {
    id: 'opusplan-mode-reminder',
    content: async () =>
      // `Your default model setting is Opus Plan Mode. Press ${getShortcutDisplay('chat:cycleMode', 'Chat', 'shift+tab')} twice to activate Plan Mode and plan with Claude Opus.`
      `你的默认模型设置为 Opus 计划模式。按 ${getShortcutDisplay('chat:cycleMode', 'Chat', 'shift+tab')} 两次激活计划模式并使用 Claude Opus 规划`,
    cooldownSessions: 2,
    async isRelevant() {
      if (process.env.USER_TYPE === 'ant') return false
      const config = getGlobalConfig()
      const modelSetting = getUserSpecifiedModelSetting()
      const hasOpusPlanMode = modelSetting === 'opusplan'
      // Show reminder if they have Opus Plan Mode and haven't used plan mode recently (3+ days)
      const daysSinceLastUse = config.lastPlanModeUse
        ? (Date.now() - config.lastPlanModeUse) / (1000 * 60 * 60 * 24)
        : Infinity
      return hasOpusPlanMode && daysSinceLastUse > 3
    },
  },
  {
    id: 'frontend-design-plugin',
    content: async ctx => {
      const blue = color('suggestion', ctx.theme)
      // return `Working with HTML/CSS? Install the frontend-design plugin:\n${blue(`/plugin install frontend-design@${OFFICIAL_MARKETPLACE_NAME}`)}`
      return `正在处理 HTML/CSS？安装 frontend-design 插件：\n${blue(`/plugin install frontend-design@${OFFICIAL_MARKETPLACE_NAME}`)}`
    },
    cooldownSessions: 3,
    isRelevant: async context =>
      isMarketplacePluginRelevant('frontend-design', context, {
        filePath: /\.(html|css|htm)$/i,
      }),
  },
  {
    id: 'vercel-plugin',
    content: async ctx => {
      const blue = color('suggestion', ctx.theme)
      // return `Working with Vercel? Install the vercel plugin:\n${blue(`/plugin install vercel@${OFFICIAL_MARKETPLACE_NAME}`)}`
      return `正在使用 Vercel？安装 vercel 插件：\n${blue(`/plugin install vercel@${OFFICIAL_MARKETPLACE_NAME}`)}`
    },
    cooldownSessions: 3,
    isRelevant: async context =>
      isMarketplacePluginRelevant('vercel', context, {
        filePath: /(?:^|[/\\])vercel\.json$/i,
        cli: ['vercel'],
      }),
  },
  {
    id: 'effort-high-nudge',
    content: async ctx => {
      const blue = color('suggestion', ctx.theme)
      const cmd = blue('/effort high')
      const variant = getFeatureValue_CACHED_MAY_BE_STALE<
        'off' | 'copy_a' | 'copy_b'
      >('tengu_tide_elm', 'off')
      // return variant === 'copy_b'
      //   ? `Use ${cmd} for better one-shot answers. Claude thinks it through first.`
      //   : `Working on something tricky? ${cmd} gives better first answers`
      return variant === 'copy_b'
        ? `使用 ${cmd} 获得更好的一次性回答，YwCoder 会先深入思考`
        : `遇到棘手问题？${cmd} 能给出更好的第一次回答`
    },
    cooldownSessions: 3,
    isRelevant: async () => {
      if (!is1PApiCustomer()) return false
      if (!modelSupportsEffort(getMainLoopModel())) return false
      if (getSettingsForSource('policySettings')?.effortLevel !== undefined) {
        return false
      }
      if (getEffortEnvOverride() !== undefined) return false
      const persisted = getInitialSettings().effortLevel
      if (persisted === 'high' || persisted === 'max') return false
      return (
        getFeatureValue_CACHED_MAY_BE_STALE<'off' | 'copy_a' | 'copy_b'>(
          'tengu_tide_elm',
          'off',
        ) !== 'off'
      )
    },
  },
  {
    id: 'subagent-fanout-nudge',
    content: async ctx => {
      const blue = color('suggestion', ctx.theme)
      const variant = getFeatureValue_CACHED_MAY_BE_STALE<
        'off' | 'copy_a' | 'copy_b'
      >('tengu_tern_alloy', 'off')
      // return variant === 'copy_b'
      //   ? `For big tasks, tell Claude to ${blue('use subagents')}. They work in parallel and keep your main thread clean.`
      //   : `Say ${blue('"fan out subagents"')} and Claude sends a team. Each one digs deep so nothing gets missed.`
      return variant === 'copy_b'
        ? `处理大任务时，让 YwCoder ${blue('使用子 agents')} 并行执行，保持主线程清爽`
        : `说 ${blue('"fan out subagents"')}，YwCoder 会派出团队，每个 agent 深入挖掘，不遗漏任何细节`
    },
    cooldownSessions: 3,
    isRelevant: async () => {
      if (!is1PApiCustomer()) return false
      return (
        getFeatureValue_CACHED_MAY_BE_STALE<'off' | 'copy_a' | 'copy_b'>(
          'tengu_tern_alloy',
          'off',
        ) !== 'off'
      )
    },
  },
  {
    id: 'loop-command-nudge',
    content: async ctx => {
      const blue = color('suggestion', ctx.theme)
      const variant = getFeatureValue_CACHED_MAY_BE_STALE<
        'off' | 'copy_a' | 'copy_b'
      >('tengu_timber_lark', 'off')
      // return variant === 'copy_b'
      //   ? `Use ${blue('/loop 5m check the deploy')} to run any prompt on a schedule. Set it and forget it.`
      //   : `${blue('/loop')} runs any prompt on a recurring schedule. Great for monitoring deploys, babysitting PRs, or polling status.`
      return variant === 'copy_b'
        ? `使用 ${blue('/loop 5m check the deploy')} 按计划执行任意提示词，一次设置无需再管`
        : `${blue('/loop')} 按计划循环执行任意提示词，非常适合监控部署、跟进 PR 或轮询状态`
    },
    cooldownSessions: 3,
    isRelevant: async () => {
      if (!is1PApiCustomer()) return false
      if (!isKairosCronEnabled()) return false
      return (
        getFeatureValue_CACHED_MAY_BE_STALE<'off' | 'copy_a' | 'copy_b'>(
          'tengu_timber_lark',
          'off',
        ) !== 'off'
      )
    },
  },
  {
    id: 'guest-passes',
    content: async ctx => {
      const claude = color('claude', ctx.theme)
      const reward = getCachedReferrerReward()
      return reward
        // ? `Share YwCoder and earn ${claude(formatCreditAmount(reward))} of extra usage · ${claude('/passes')}`
        // : `You have free guest passes to share · ${claude('/passes')}`
        ? `分享 YwCoder 并获得 ${claude(formatCreditAmount(reward))} 的额外用量 · ${claude('/passes')}`
        : `你有免费访客通行证可分享 · ${claude('/passes')}`
    },
    cooldownSessions: 3,
    isRelevant: async () => {
      const config = getGlobalConfig()
      if (config.hasVisitedPasses) {
        return false
      }
      const { eligible } = checkCachedPassesEligibility()
      return eligible
    },
  },
  {
    id: 'overage-credit',
    content: async ctx => {
      const claude = color('claude', ctx.theme)
      const info = getCachedOverageCreditGrant()
      const amount = info ? formatGrantAmount(info) : null
      if (!amount) return ''
      // Copy from "OC & Bulk Overages copy" doc (#5 — CLI Rotating tip)
      // return `${claude(`${amount} in extra usage, on us`)} · third-party apps · ${claude('/extra-usage')}`
      return `${claude(`赠送 ${amount} 额外用量`)} · 第三方应用 · ${claude('/extra-usage')}`
    },
    cooldownSessions: 3,
    isRelevant: async () => shouldShowOverageCreditUpsell(),
  },
  {
    id: 'feedback-command',
    // content: async () => 'Use /feedback to help us improve!',
    content: async () => '使用 /feedback 帮助我们改进！',
    cooldownSessions: 15,
    async isRelevant() {
      if (process.env.USER_TYPE === 'ant') {
        return false
      }
      const config = getGlobalConfig()
      return config.numStartups > 5
    },
  },
]
const internalOnlyTips: Tip[] =
  process.env.USER_TYPE === 'ant'
    ? [
        {
          id: 'important-claudemd',
          content: async () =>
            '[internal] Use "IMPORTANT:" prefix for must-follow YWCODER.md rules',
          cooldownSessions: 30,
          isRelevant: async () => true,
        },
        {
          id: 'skillify',
          content: async () =>
            '[internal] Turn repeatable workflows into reusable project skills when they keep recurring',
          cooldownSessions: 15,
          isRelevant: async () => true,
        },
      ]
    : []

function getCustomTips(): Tip[] {
  const settings = getInitialSettings()
  const override = settings.spinnerTipsOverride
  if (!override?.tips?.length) return []

  return override.tips.map((content, i) => ({
    id: `custom-tip-${i}`,
    content: async () => content,
    cooldownSessions: 0,
    isRelevant: async () => true,
  }))
}

export async function getRelevantTips(context?: TipContext): Promise<Tip[]> {
  const settings = getInitialSettings()
  const override = settings.spinnerTipsOverride
  const customTips = getCustomTips()

  // If excludeDefault is true and there are custom tips, skip built-in tips entirely
  if (override?.excludeDefault && customTips.length > 0) {
    return customTips
  }

  // Otherwise, filter built-in tips as before and combine with custom
  const tips = [...externalTips, ...internalOnlyTips]
  const isRelevant = await Promise.all(tips.map(_ => _.isRelevant(context)))
  const filtered = tips
    .filter((_, index) => isRelevant[index])
    .filter(_ => getSessionsSinceLastShown(_.id) >= _.cooldownSessions)

  return [...filtered, ...customTips]
}
