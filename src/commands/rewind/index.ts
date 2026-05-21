import type { Command } from '../../commands.js'

const rewind = {
  description: `将代码或对话回滚到之前的某个时间点`,
  name: 'rewind',
  aliases: ['checkpoint'],
  argumentHint: '',
  type: 'local',
  supportsNonInteractive: false,
  load: () => import('./rewind.js'),
} satisfies Command

export default rewind
