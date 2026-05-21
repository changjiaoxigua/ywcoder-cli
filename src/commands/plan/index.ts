import type { Command } from '../../commands.js'

const plan = {
  type: 'local-jsx',
  name: 'plan',
  description: '开启 plan 模式或查看当前会话的计划',
  argumentHint: '[open|<description>]',
  load: () => import('./plan.js'),
} satisfies Command

export default plan
