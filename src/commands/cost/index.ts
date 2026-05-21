/**
 * Cost command - minimal metadata only.
 * Implementation is lazy-loaded from cost.ts to reduce startup time.
 */
import type { Command } from '../../commands.js'
import { isYwCoderSubscriber } from '../../utils/auth.js'

const cost = {
  type: 'local',
  name: 'cost',
  description: '显示当前会话的总费用与时长',
  get isHidden() {
    // Keep visible for Ants even if they're subscribers (they see cost breakdowns)
    if (process.env.USER_TYPE === 'ant') {
      return false
    }
    return isYwCoderSubscriber()
  },
  supportsNonInteractive: true,
  load: () => import('./cost.js'),
} satisfies Command

export default cost
