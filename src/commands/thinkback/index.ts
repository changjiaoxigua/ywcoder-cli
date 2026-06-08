import type { Command } from '../../commands.js'

const thinkback = {
  type: 'local-jsx',
  name: 'think-back',
  description: '你的 2025 YwCoder 年度回顾',
  // YwCoder: 年度回顾依赖云端生成，内网不提供，禁用（将来接 YwCoder 服务可重启用）
  isEnabled: () => false,
  load: () => import('./thinkback.js'),
} satisfies Command

export default thinkback
