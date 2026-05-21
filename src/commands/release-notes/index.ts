import type { Command } from '../../commands.js'

const releaseNotes: Command = {
  description: '查看版本更新说明',
  name: 'release-notes',
  type: 'local',
  supportsNonInteractive: true,
  load: () => import('./release-notes.js'),
}

export default releaseNotes
