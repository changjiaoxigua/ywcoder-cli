import type { Command } from '../../commands.js'

const status = {
  type: 'local-jsx',
  name: 'status',
  description:
    '显示 YwCoder 状态，包括版本、模型、账号、API 连接性以及各工具状态',
  immediate: true,
  load: () => import('./status.js'),
} satisfies Command

export default status
