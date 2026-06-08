import type { Command } from '../../commands.js'

const feedback = {
  aliases: ['bug'],
  type: 'local-jsx',
  name: 'feedback',
  description: `提交关于 YwCoder 的反馈`,
  argumentHint: '[问题报告]',
  // YwCoder: 反馈提交至公网 GitHub，内网不可达，禁用（将来接内网反馈渠道可重启用）
  isEnabled: () => false,
  load: () => import('./feedback.js'),
} satisfies Command

export default feedback
