import type { Command } from '../../commands.js'
import { isYwCoderSubscriber } from '../../utils/auth.js'

const rateLimitOptions = {
  type: 'local-jsx',
  name: 'rate-limit-options',
  description: '触发限流时显示可选操作',
  isEnabled: () => {
    if (!isYwCoderSubscriber()) {
      return false
    }

    return true
  },
  isHidden: true, // Hidden from help - only used internally
  load: () => import('./rate-limit-options.js'),
} satisfies Command

export default rateLimitOptions
