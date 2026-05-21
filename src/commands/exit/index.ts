import type { Command } from '../../commands.js'

const exit = {
  type: 'local-jsx',
  name: 'exit',
  aliases: ['quit'],
  description: '退出当前 REPL',
  immediate: true,
  load: () => import('./exit.js'),
} satisfies Command

export default exit
