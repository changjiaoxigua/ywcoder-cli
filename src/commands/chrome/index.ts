import type { Command } from '../../commands.js'

const command: Command = {
  name: 'chrome',
  description: 'Chrome 浏览器集成（Beta）设置',
  availability: ['claude-ai'],
  // YwCoder: 依赖 Anthropic 的 Claude in Chrome 浏览器扩展，内网不提供，禁用
  isEnabled: () => false,
  type: 'local-jsx',
  load: () => import('./chrome.js'),
}

export default command
