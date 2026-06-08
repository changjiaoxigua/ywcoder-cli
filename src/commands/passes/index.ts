import type { Command } from '../../commands.js'
import {
  checkCachedPassesEligibility,
  getCachedReferrerReward,
} from '../../services/api/referral.js'

export default {
  type: 'local-jsx',
  name: 'passes',
  get description() {
    const reward = getCachedReferrerReward()
    if (reward) {
      return '邀请好友免费试用 YwCoder 一周，并赢取额外用量'
    }
    return '邀请好友免费试用 YwCoder 一周'
  },
  // YwCoder: Anthropic 订阅推荐返利功能，内网不提供，禁用
  isEnabled: () => false,
  get isHidden() {
    const { eligible, hasCache } = checkCachedPassesEligibility()
    return !eligible || !hasCache
  },
  load: () => import('./passes.js'),
} satisfies Command
