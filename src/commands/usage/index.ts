import type { Command } from '../../commands.js'

export default {
  type: 'local-jsx',
  name: 'usage',
  description: '查看套餐的用量额度',
  availability: ['claude-ai'],
  load: () => import('./usage.js'),
} satisfies Command
