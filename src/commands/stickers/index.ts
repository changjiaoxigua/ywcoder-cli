import type { Command } from '../../commands.js'

const stickers = {
  type: 'local',
  name: 'stickers',
  description: '订购 Claude Code 贴纸',
  supportsNonInteractive: false,
  // YwCoder: 禁用 — 此命令打开 Anthropic 周边商品订购页面，与 YwCoder 无关
  isEnabled: () => false,
  load: () => import('./stickers.js'),
} satisfies Command

export default stickers
