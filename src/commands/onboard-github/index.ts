import type { Command } from '../../commands.js'

const onboardGithub: Command = {
  name: 'onboard-github',
  aliases: ['onboarding-github', 'onboardgithub', 'onboardinggithub'],
  description:
    '交互式配置 GitHub Models：设备登录或 PAT，凭据安全存储',
  type: 'local-jsx',
  load: () => import('./onboard-github.js'),
}

export default onboardGithub
