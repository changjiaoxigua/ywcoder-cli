import type { Command } from '../../commands.js'

const mobile = {
  type: 'local-jsx',
  name: 'mobile',
  aliases: ['ios', 'android'],
  description: '显示下载 Claude 手机 App 的二维码',
  // YwCoder 暂不提供手机端，禁用此命令 (2026-05-21)
  isEnabled: () => false,
  load: () => import('./mobile.js'),
} satisfies Command

export default mobile
