import type { Command } from '../../commands.js'

export default {
  type: 'local-jsx',
  name: 'diff',
  description: '查看未提交的改动以及每轮对话的 diff',
  load: () => import('./diff.js'),
} satisfies Command
