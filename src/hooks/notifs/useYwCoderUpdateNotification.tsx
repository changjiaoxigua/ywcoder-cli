import { useEffect, useRef } from 'react'

import { getIsRemoteMode } from '../../bootstrap/state.js'
import { useNotifications } from '../../context/notifications.js'
import { logForDebugging } from '../../utils/debug.js'
import { resolveHubConfig } from '../../utils/skills/skillInstaller.js'
import {
  checkYwCoderUpdate,
  getCachedUpdate,
  onYwCoderUpdateAvailable,
  type YwUpdateInfo,
} from '../../utils/ywUpdateCheck.js'

// 构建期注入（scripts/build.ts）；版本比较只认 DISPLAY_VERSION（D4）
declare const MACRO: { VERSION: string; DISPLAY_VERSION?: string }

function currentDisplayVersion(): string {
  return typeof MACRO !== 'undefined' ? (MACRO.DISPLAY_VERSION ?? '') : ''
}

/** 单行提醒文案（§4.2）：新旧版本 + 本机平台安装包文件名 */
function messageFor(info: YwUpdateInfo, current: string): string {
  const base = `新版本可用：v${info.latestVersion}（当前 v${current}）`
  return info.packageFilename ? `${base} · 获取 ${info.packageFilename}` : base
}

/**
 * YwCoder 自身版本更新提醒（方案 A）。
 * 挂载即读 globalConfig 缓存（两次检查之间无需网络即可提醒，D6），
 * 并订阅本次会话的检查回调；每会话至多提醒一次（D7）。
 *
 * 挂载点即检查时机（审查 #4）：hook 只被交互式 REPL 挂载，因此挂载 effect 里
 * 直接触发 checkYwCoderUpdate——打开 CLI 即检查，不等首次提交（此前挂在
 * startBackgroundHousekeeping，被 submitCount===1 门控，未发消息的会话永不检查）。
 * headless 路径不挂载本 hook；bridge（远程控制/镜像）会挂载，按修订后 D10 允许
 * 提醒（有本地展示面）；remote mode 在上面提前 return。
 */
export function useYwCoderUpdateNotification(): void {
  const { addNotification } = useNotifications()
  const notifiedRef = useRef(false)

  useEffect(() => {
    if (getIsRemoteMode()) return

    const notify = (info: YwUpdateInfo) => {
      if (notifiedRef.current) return
      notifiedRef.current = true
      addNotification({
        key: 'ywcoder-update-available',
        text: messageFor(info, currentDisplayVersion()),
        color: 'warning',
        priority: 'medium',
        timeoutMs: 15_000,
      })
      logForDebugging(`ywUpdateCheck: 已提醒新版本 ${info.latestVersion}`)
    }

    // 挂载即读缓存。hub 配置非法时 resolveHubConfig 抛错——静默兜底（D9）
    try {
      const hub = resolveHubConfig()
      if (hub) {
        const cached = getCachedUpdate(hub.hubRoot, currentDisplayVersion())
        if (cached) notify(cached)
      }
    } catch (e) {
      logForDebugging(`ywUpdateCheck: 读取缓存提醒失败：${e}`)
    }

    const off = onYwCoderUpdateAvailable(notify)
    // 订阅就位后再触发检查（内部有节流/禁用/交互判定，全程静默失败）
    void checkYwCoderUpdate()
    return off
  }, [addNotification])
}
