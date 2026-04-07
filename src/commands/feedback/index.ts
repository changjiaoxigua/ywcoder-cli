import type { Command } from '../../commands.js'
import { isPolicyAllowed } from '../../services/policyLimits/index.js'
import { isEnvTruthy, getYwCoderEnv } from '../../utils/envUtils.js'
import { isEssentialTrafficOnly } from '../../utils/privacyLevel.js'

const feedback = {
  aliases: ['bug'],
  type: 'local-jsx',
  name: 'feedback',
  description: `Submit feedback about Claude Code`,
  argumentHint: '[report]',
  isEnabled: () =>
    !(
      isEnvTruthy(getYwCoderEnv('USE_BEDROCK')) ||
      isEnvTruthy(getYwCoderEnv('USE_VERTEX')) ||
      isEnvTruthy(getYwCoderEnv('USE_FOUNDRY')) ||
      isEnvTruthy(process.env.DISABLE_FEEDBACK_COMMAND) ||
      isEnvTruthy(process.env.DISABLE_BUG_COMMAND) ||
      isEssentialTrafficOnly() ||
      process.env.USER_TYPE === 'ant' ||
      !isPolicyAllowed('allow_product_feedback')
    ),
  load: () => import('./feedback.js'),
} satisfies Command

export default feedback
