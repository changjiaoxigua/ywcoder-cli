import type { Command } from '../../commands.js'

const provider = {
  type: 'local-jsx',
  name: 'provider',
  description: '管理 API 服务商配置档案',
  load: () => import('./provider.js'),
} satisfies Command

export default provider
