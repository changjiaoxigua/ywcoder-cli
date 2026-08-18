import figures from 'figures'
import type { Command } from '../../commands.js'
import { SandboxManager } from '../../utils/sandbox/sandbox-adapter.js'

const command = {
  name: 'sandbox',
  get description() {
    const currentlyEnabled = SandboxManager.isSandboxingEnabled()
    const autoAllow = SandboxManager.isAutoAllowBashIfSandboxedEnabled()
    const allowUnsandboxed = SandboxManager.areUnsandboxedCommandsAllowed()
    const isLocked = SandboxManager.areSandboxSettingsLockedByPolicy()
    // 防御：内网构建中 sandbox-runtime 被桩化，checkDependencies 可能返回
    // 非预期值；此 getter 会在 React commit 阶段被 props diff 意外触发，
    // 必须保证任何情况下都不抛异常
    const hasDeps = SandboxManager.checkDependencies()?.errors?.length === 0

    // Show warning icon if dependencies missing, otherwise enabled/disabled status
    let icon: string
    if (!hasDeps) {
      icon = figures.warning
    } else {
      icon = currentlyEnabled ? figures.tick : figures.circle
    }

    let statusText = '沙箱已关闭'
    if (currentlyEnabled) {
      statusText = autoAllow ? '沙箱已开启（自动放行）' : '沙箱已开启'

      // 是否允许非沙箱回退
      statusText += allowUnsandboxed ? '，允许回退' : ''
    }

    if (isLocked) {
      statusText += '（策略锁定）'
    }

    return `${icon} ${statusText}（按 ⏎ 进行配置）`
  },
  argumentHint: 'exclude "命令模式"',
  get isHidden() {
    return (
      !SandboxManager.isSupportedPlatform() ||
      !SandboxManager.isPlatformInEnabledList()
    )
  },
  immediate: true,
  type: 'local-jsx',
  load: () => import('./sandbox-toggle.js'),
} satisfies Command

export default command
