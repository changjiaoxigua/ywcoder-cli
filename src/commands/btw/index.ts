import type { Command } from '../../commands.js'

const btw = {
  type: 'local-jsx',
  name: 'btw',
  description:
    '在不打断主对话的前提下提个简短的旁支问题',
  immediate: true,
  argumentHint: '<问题>',
  load: () => import('./btw.js'),
} satisfies Command

export default btw
