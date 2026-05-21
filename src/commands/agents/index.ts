import type { Command } from '../../commands.js'

const agents = {
  type: 'local-jsx',
  name: 'agents',
  description: '管理 agent 配置',
  load: () => import('./agents.js'),
} satisfies Command

export default agents
