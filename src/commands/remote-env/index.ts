import type { Command } from '../../commands.js'
import { isPolicyAllowed } from '../../services/policyLimits/index.js'
import { isYwCoderSubscriber } from '../../utils/auth.js'

export default {
  type: 'local-jsx',
  name: 'remote-env',
  description: '配置 teleport 会话使用的默认远程环境',
  isEnabled: () =>
    isYwCoderSubscriber() && isPolicyAllowed('allow_remote_sessions'),
  get isHidden() {
    return !isYwCoderSubscriber() || !isPolicyAllowed('allow_remote_sessions')
  },
  load: () => import('./remote-env.js'),
} satisfies Command
