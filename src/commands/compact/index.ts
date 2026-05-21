import type { Command } from '../../commands.js'
import { isEnvTruthy } from '../../utils/envUtils.js'

const compact = {
  type: 'local',
  name: 'compact',
  description:
    '清空对话历史但在上下文中保留摘要。可选：/compact [总结指引]',
  isEnabled: () => !isEnvTruthy(process.env.DISABLE_COMPACT),
  supportsNonInteractive: true,
  argumentHint: '[可选的自定义摘要指令]',
  load: () => import('./compact.js'),
} satisfies Command

export default compact
