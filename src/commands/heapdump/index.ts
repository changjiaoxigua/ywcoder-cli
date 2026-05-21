import type { Command } from '../../commands.js'

const heapDump = {
  type: 'local',
  name: 'heapdump',
  description: '将 JS 堆快照导出到 ~/Desktop',
  isHidden: true,
  supportsNonInteractive: true,
  load: () => import('./heapdump.js'),
} satisfies Command

export default heapDump
