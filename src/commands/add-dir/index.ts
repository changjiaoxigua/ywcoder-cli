import type { Command } from '../../commands.js'

const addDir = {
  type: 'local-jsx',
  name: 'add-dir',
  description: '新增一个工作目录',
  argumentHint: '<path>',
  load: () => import('./add-dir.js'),
} satisfies Command

export default addDir
