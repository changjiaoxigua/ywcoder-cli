import type { Command } from '../../commands.js'

const buddy = {
  type: 'local-jsx',
  name: 'buddy',
  description: '孵化、抚养并管理你的 YwCoder 小伙伴',
  immediate: true,
  argumentHint: '[status|mute|unmute|help]',
  load: () => import('./buddy.js'),
} satisfies Command

export default buddy
