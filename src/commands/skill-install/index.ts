import type { Command } from '../../commands.js'

const skillInstall = {
  type: 'local-jsx',
  name: 'skill-install',
  description: '安装 / 卸载内网 yw-devhub 提供的 skill',
  argumentHint: '[<id> | --remove <id>] [--project] [--force]',
  load: () => import('./skill-install.js'),
} satisfies Command

export default skillInstall
