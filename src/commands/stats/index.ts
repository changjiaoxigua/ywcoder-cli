import type { Command } from '../../commands.js'

const stats = {
  type: 'local-jsx',
  name: 'stats',
  description: '查看你的 YwCoder 使用统计与活动记录',
  load: () => import('./stats.js'),
} satisfies Command

export default stats
