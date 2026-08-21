/**
 * YwCoder 自身版本的运行时检查与更新提醒（方案 A：只检查 + 提醒）。
 *
 * 实施依据：note/version-management-and-auto-update/04-runtime-version-check-design.md。
 * 直接消费 hub 上的 tools.json（id === "ywcoder-cli" 条目），发现更高版本时
 * 通过 notifications 系统提醒用户；不下载、不安装（D1）。
 *
 * 与上游 first-party 更新链路（autoUpdater.ts / nativeInstaller/）完全独立。
 * 本模块零 React 依赖，供 backgroundHousekeeping 与单测直接调用。
 */

import axios from 'axios'

import { getIsInteractive, getIsRemoteMode } from '../bootstrap/state.js'
import { getGlobalConfig, saveGlobalConfig } from './config.js'
import { logForDebugging } from './debug.js'
import { isEnvTruthy } from './envUtils.js'
import { getEssentialTrafficOnlyReason } from './privacyLevel.js'
import { gt, valid as semverValid } from './semver.js'
import {
  type HttpGet,
  normalizeHubRoot,
  resolveHubConfig,
  urlForLog,
} from './skills/skillInstaller.js'

// ---------------------------------------------------------------------------
// 常量（§3.2 / §4）
// ---------------------------------------------------------------------------

// 构建期注入（scripts/build.ts）；bun test 下未定义，入口函数有 typeof 守卫
declare const MACRO: { VERSION: string; DISPLAY_VERSION?: string }

/** 清单请求超时：启动期请求必须快速失败（01 文档 C3） */
export const CHECK_TIMEOUT_MS = 1_500
/** tools.json 体积上限（随资源条目增长预留余量，§3.2） */
export const MANIFEST_MAX_BYTES = 64 * 1024
/** 检查节流间隔（D6） */
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
/** tools.json 中本 CLI 的条目 id（D3） */
export const YWCODER_CLI_ENTRY_ID = 'ywcoder-cli'
/** version 字段长度上限（§3.1） */
const VERSION_MAX_LENGTH = 64

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export type ToolsPackage = { platform?: unknown; filename?: unknown }

export type ToolsManifestEntry = {
  id: string
  version?: unknown
  packages?: unknown
}

/** 提醒所需信息（缓存与回调共用的载荷） */
export type YwUpdateInfo = {
  latestVersion: string
  /** 本机平台对应安装包的 basename（提醒文案用），缺失时为空串 */
  packageFilename: string
}

/** globalConfig.ywcoderUpdateCheck 的形状（§4.1） */
export type YwUpdateCheckCache = {
  lastCheckedAt: number
  hubRoot?: string
  latestVersion?: string
  packageFilename?: string
}

// ---------------------------------------------------------------------------
// 清单解析与平台匹配（纯函数）
// ---------------------------------------------------------------------------

/**
 * 从 tools.json（顶层数组）提取 ywcoder-cli 条目。
 * 找不到 / 顶层不是数组 / 条目不是对象 → null（静默，§3.1）。重复条目取第一条。
 */
export function extractYwCoderEntry(json: unknown): ToolsManifestEntry | null {
  if (!Array.isArray(json)) return null
  for (const item of json) {
    if (
      item !== null &&
      typeof item === 'object' &&
      (item as { id?: unknown }).id === YWCODER_CLI_ENTRY_ID
    ) {
      return item as ToolsManifestEntry
    }
  }
  return null
}

/**
 * version 合法性：严格 SemVer（npm semver.valid，Bun/Node 行为一致，审查 P2）。
 * 注意 valid() 的两点宽容需要额外收紧：接受 v/= 前缀与首尾空白（返回规范化串）、
 * 返回值会剥掉 build metadata——故显式拒绝这些形态后再判 valid，这样
 * "1.2.3+build.1" 合法而 "v1.2.3" 非法。覆盖项目的 release "1.3.0" 与
 * dev "1.3.0-dev.94cbf90" 形态；长度上限防清单侧注入超长串。
 */
export function isValidVersion(v: unknown): v is string {
  if (typeof v !== 'string' || v.length === 0 || v.length > VERSION_MAX_LENGTH) {
    return false
  }
  if (v !== v.trim() || v.startsWith('v') || v.startsWith('=')) return false
  return semverValid(v) !== null
}

/**
 * 更新判定：gt(清单版本, 当前版本)，任一侧非法 → false（D5，静默）。
 * 永不抛出（审查 P2）：gt 在 Node 18 走 npm semver loose 比较，理论上仍可能
 * 对边界输入抛 TypeError——吞掉按「无更新」处理，保证外层 markChecked 一定执行。
 */
export function isNewerVersion(latest: unknown, current: unknown): boolean {
  if (!isValidVersion(latest) || !isValidVersion(current)) return false
  try {
    return gt(latest, current)
  } catch {
    return false
  }
}

/** process.platform → 清单 platform 字符串映射（§3.3） */
const PLATFORM_MAP: Record<string, string> = {
  win32: 'Windows',
  linux: 'Linux',
  darwin: 'macOS',
}

/**
 * 平台匹配：精确匹配（大小写不敏感）优先，"通用"兜底；都无 → null（D11 静默跳过）。
 * 返回包文件名的 basename（提醒文案只展示文件名，§4.2）。
 */
export function matchPlatformPackageFilename(
  packages: unknown,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (!Array.isArray(packages)) return null
  const want = PLATFORM_MAP[platform]
  if (!want) return null

  const entries = packages.filter(
    (p): p is ToolsPackage => p !== null && typeof p === 'object',
  )
  const byPlatform = (pred: (platform: string) => boolean): string | null => {
    for (const p of entries) {
      if (typeof p.platform === 'string' && pred(p.platform)) {
        if (typeof p.filename === 'string' && p.filename.length > 0) {
          const base = p.filename.split('/').pop() ?? ''
          return base || null
        }
        // 平台命中但缺 filename：视为无匹配，不让提醒展示空文件名
        return null
      }
    }
    return null
  }

  const exact = byPlatform(s => s.toLowerCase() === want.toLowerCase())
  if (exact) return exact
  return byPlatform(s => s === '通用')
}

// ---------------------------------------------------------------------------
// 禁用判定（D8）
// ---------------------------------------------------------------------------

/**
 * 自定义禁用判定。严禁改用 isAutoUpdaterDisabled()——它在 ywcoder build 中
 * 恒为 true（config.ts 对上游 GCS 轮询的兜底补丁），复用它本功能永不执行。
 */
export function isYwUpdateCheckDisabled(
  readConfig: () => { autoUpdates?: boolean } | undefined = () =>
    getGlobalConfig(),
): boolean {
  if (isEnvTruthy(process.env.DISABLE_AUTOUPDATER)) return true
  if (getEssentialTrafficOnlyReason()) return true
  if (readConfig()?.autoUpdates === false) return true
  return false
}

// ---------------------------------------------------------------------------
// 缓存读写（globalConfig，可注入以便单测）
// ---------------------------------------------------------------------------

export type YwUpdateCheckStore = {
  read(): YwUpdateCheckCache | undefined
  write(cache: YwUpdateCheckCache): void
}

const defaultStore: YwUpdateCheckStore = {
  read: () => getGlobalConfig().ywcoderUpdateCheck,
  write: cache =>
    saveGlobalConfig(current => ({ ...current, ywcoderUpdateCheck: cache })),
}

/** 节流判定：距上次检查不足 24h 则跳过（成功失败都节流，§4.1） */
export function shouldCheckNow(
  cache: YwUpdateCheckCache | undefined,
  now: number,
): boolean {
  if (!cache || typeof cache.lastCheckedAt !== 'number') return true
  return now - cache.lastCheckedAt >= CHECK_INTERVAL_MS
}

/**
 * REPL 挂载时读缓存：hubRoot 一致（防串源）且缓存版本高于当前版本 → 提醒信息。
 */
export function getCachedUpdate(
  hubRoot: string,
  currentVersion: string,
  store: YwUpdateCheckStore = defaultStore,
): YwUpdateInfo | null {
  const cache = store.read()
  if (!cache || cache.hubRoot !== hubRoot) return null
  if (!isNewerVersion(cache.latestVersion, currentVersion)) return null
  return {
    latestVersion: cache.latestVersion as string,
    packageFilename: cache.packageFilename ?? '',
  }
}

// ---------------------------------------------------------------------------
// 网络：拉取 tools.json
// ---------------------------------------------------------------------------

/** 默认实现与 skillInstaller 同参数（arraybuffer / 不跟随重定向 / 限时限量） */
const defaultHttpGet: HttpGet = async (url, opts) => {
  const resp = await axios.get(url, {
    responseType: 'arraybuffer',
    maxRedirects: 0,
    timeout: opts.timeout,
    maxContentLength: opts.maxContentLength,
  })
  return Buffer.from(resp.data as ArrayBuffer)
}

// ---------------------------------------------------------------------------
// 结果回调（参照 pluginAutoupdate 的 pending 模式）
// ---------------------------------------------------------------------------

export type YwUpdateCallback = (info: YwUpdateInfo) => void

let updateCallback: YwUpdateCallback | null = null
/** 回调注册前已产出的结果，注册时补发（REPL 挂载晚于检查完成的竞态） */
let pendingUpdate: YwUpdateInfo | null = null

export function onYwCoderUpdateAvailable(callback: YwUpdateCallback): () => void {
  updateCallback = callback
  if (pendingUpdate !== null) {
    callback(pendingUpdate)
    pendingUpdate = null
  }
  return () => {
    updateCallback = null
  }
}

function emitUpdate(info: YwUpdateInfo): void {
  if (updateCallback) {
    updateCallback(info)
  } else {
    pendingUpdate = info
  }
}

/** 仅测试用：清空模块级回调与 pending 状态 */
export function resetYwUpdateCheckForTest(): void {
  updateCallback = null
  pendingUpdate = null
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

export type CheckDeps = {
  httpGet?: HttpGet
  store?: YwUpdateCheckStore
  now?: number
  /** 默认读 MACRO.DISPLAY_VERSION；MACRO.VERSION 是 99.0.0 占位符，严禁使用（D4） */
  currentVersion?: string
  platform?: NodeJS.Platform
  isInteractive?: () => boolean
  isRemoteMode?: () => boolean
  isDisabled?: () => boolean
  resolveHub?: typeof resolveHubConfig
}

function defaultCurrentVersion(): string {
  // bun test 下 MACRO 未注入；本地 dev build 有 DISPLAY_VERSION 但本检查无意义，由调用方决定
  return typeof MACRO !== 'undefined' ? (MACRO.DISPLAY_VERSION ?? '') : ''
}

/**
 * 启动期版本检查。任何失败静默（只写 debug log），绝不向用户输出错误（D9）。
 * 跳过条件：非交互 / remote mode / 用户禁用 / 未配置 hub / 24h 节流（§4）。
 */
export async function checkYwCoderUpdate(deps: CheckDeps = {}): Promise<void> {
  const {
    httpGet = defaultHttpGet,
    store = defaultStore,
    now = Date.now(),
    currentVersion = defaultCurrentVersion(),
    platform = process.platform,
    isInteractive = getIsInteractive,
    isRemoteMode = getIsRemoteMode,
    isDisabled = isYwUpdateCheckDisabled,
    resolveHub = resolveHubConfig,
  } = deps

  try {
    // D10：交互判定必须在函数内部做——headless 路径同样调 startBackgroundHousekeeping
    if (!isInteractive() || isRemoteMode()) return
    if (isDisabled()) return
    const hub = resolveHub()
    if (!hub) return

    // 审查 P1：hubRoot 不一致 = 换源，整条缓存作废——节流时间、latestVersion、
    // packageFilename 一律不继承（旧源数据不得挂到新源名下展示）。
    const storedCache = store.read()
    const cache = storedCache?.hubRoot === hub.hubRoot ? storedCache : undefined
    if (!shouldCheckNow(cache, now)) return

    // 失败也要节流：写 lastCheckedAt，保留既有 latest 缓存（§4.1）
    const markChecked = () =>
      store.write({ ...cache, lastCheckedAt: now, hubRoot: hub.hubRoot })

    const manifestUrl = new URL(
      'tools.json',
      normalizeHubRoot(hub.hubRoot),
    ).toString()

    let body: Buffer
    try {
      body = await httpGet(manifestUrl, {
        timeout: CHECK_TIMEOUT_MS,
        maxContentLength: MANIFEST_MAX_BYTES,
      })
    } catch (e) {
      logForDebugging(
        `ywUpdateCheck: 拉取失败（${urlForLog(manifestUrl)}）：${e}`,
      )
      markChecked()
      return
    }

    let json: unknown
    try {
      json = JSON.parse(body.toString('utf8'))
    } catch {
      logForDebugging('ywUpdateCheck: tools.json 不是合法 JSON')
      markChecked()
      return
    }

    const entry = extractYwCoderEntry(json)
    const latestVersion = entry?.version
    const packageFilename = entry
      ? matchPlatformPackageFilename(entry.packages, platform)
      : null

    if (isNewerVersion(latestVersion, currentVersion) && packageFilename) {
      const info: YwUpdateInfo = {
        latestVersion: latestVersion as string,
        packageFilename,
      }
      store.write({
        lastCheckedAt: now,
        hubRoot: hub.hubRoot,
        latestVersion: info.latestVersion,
        packageFilename: info.packageFilename,
      })
      emitUpdate(info)
      return
    }

    // 无更新 / 条目缺失 / version 非法 / 本机平台无包：清掉 latest 缓存（§6）
    store.write({ lastCheckedAt: now, hubRoot: hub.hubRoot })
  } catch (e) {
    // 兜底：任何意外（如 globalConfig 写失败）不得影响启动
    logForDebugging(`ywUpdateCheck: 意外失败：${e}`)
  }
}
