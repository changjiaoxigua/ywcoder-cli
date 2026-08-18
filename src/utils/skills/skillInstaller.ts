/**
 * 内网 skill 安装器（/skill-install 的核心逻辑）。
 *
 * 实施依据：note/feature_intranet_skill_install/design-option1-lite.md。
 * 本模块零 React 依赖，供命令层（local-jsx）与单测直接调用。
 */

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'

import axios from 'axios'

import { getSettingsForSource } from '../settings/settings.js'
import type { SettingsJson } from '../settings/types.js'
import { unzipFile, parseZipModes } from '../dxt/zip.js'
import { validateSkillId } from './skillInstallArgs.js'

// ---------------------------------------------------------------------------
// 常量（§3.1 / §6.3 / §9.3）
// ---------------------------------------------------------------------------

/** 清单请求超时（§6 第 7 步） */
export const MANIFEST_TIMEOUT_MS = 5_000
/** 清单体积上限 2 MB（§3.1） */
export const MANIFEST_MAX_BYTES = 2 * 1024 * 1024
/** zip 下载超时（§6 第 9 步） */
export const ZIP_TIMEOUT_MS = 60_000
/** zip 体积上限 64 MB（§9.3） */
export const ZIP_MAX_BYTES = 64 * 1024 * 1024
/** 清单条目数上限，超出截断并警告（§3.1） */
export const MANIFEST_MAX_ENTRIES = 500

export const SIDECAR_FILENAME = '.ywcoder-source.json'
export const SIDECAR_SCHEMA_VERSION = 1

// ---------------------------------------------------------------------------
// 配置读取（§4）：只读 policySettings / userSettings，优先级 policy > user
// ---------------------------------------------------------------------------

export type HubConfig = {
  /** 归一化后的 hub 根地址（以 / 结尾） */
  hubRoot: string
  source: 'policySettings' | 'userSettings'
}

type SettingsReader = (source: 'policySettings' | 'userSettings') =>
  SettingsJson | null

/**
 * 读取 ywdevhubUrl。严禁改用 getInitialSettings()——那是合并结果，
 * 含 project/local settings，会让仓库内容控制可执行内容的安装源（§4）。
 */
export function resolveHubConfig(
  readSettings: SettingsReader = source => getSettingsForSource(source),
): HubConfig | null {
  for (const source of ['policySettings', 'userSettings'] as const) {
    const raw = readSettings(source)?.ywdevhubUrl
    if (typeof raw === 'string' && raw.length > 0) {
      return { hubRoot: normalizeHubRoot(raw), source }
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// URL 派生（§3.2，纯函数）
// ---------------------------------------------------------------------------

/**
 * 归一化 hub 根地址：必须以 `/` 结尾，否则 new URL() 会吃掉最后一段路径。
 * 同时做协议与 userinfo 校验（§9.3）。非法输入抛错。
 */
export function normalizeHubRoot(raw: string): string {
  assertUrlAllowed(raw, 'ywdevhubUrl')
  return raw.endsWith('/') ? raw : raw + '/'
}

/** 清单地址 = hub 根下的 skills.json（路径约定，D20） */
export function deriveManifestUrl(hubRoot: string): string {
  return new URL('skills.json', hubRoot).toString()
}

/** zip 地址 = hub 根下的 skills/<filename>；条目 downloadUrl 存在时优先（§3.2） */
export function deriveZipUrl(
  hubRoot: string,
  entry: { filename?: string; downloadUrl?: string },
): string {
  const url = entry.downloadUrl
    ? entry.downloadUrl
    : new URL('skills/' + entry.filename, hubRoot).toString()
  // 最终地址无论来自拼接还是 downloadUrl，都必须过协议与 userinfo 校验
  assertUrlAllowed(url, 'downloadUrl')
  return url
}

/**
 * §9.3 传输校验：只允许 http/https，禁止 userinfo。
 * 对 ywdevhubUrl 与最终下载地址统一适用。
 */
export function assertUrlAllowed(raw: string, fieldName: string): void {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    // URL 无法解析时拿不到 origin；截掉 query/fragment 再回显，避免泄露敏感参数（§6.3）
    throw new Error(`${fieldName} 不是合法 URL：${raw.split(/[?#]/)[0]}`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`${fieldName} 只允许 http/https 协议：${url.protocol}`)
  }
  if (url.username || url.password) {
    throw new Error(`${fieldName} 不允许携带 userinfo（user:pass@）`)
  }
}

/** 日志与错误信息只输出 origin + pathname（§6.3），不输出 query 与 fragment */
export function urlForLog(raw: string): string {
  try {
    const url = new URL(raw)
    return url.origin + url.pathname
  } catch {
    return raw
  }
}

// ---------------------------------------------------------------------------
// 清单解析（§3.1，纯函数）
// ---------------------------------------------------------------------------

export type ManifestEntry = {
  id: string
  version: string
  filename?: string
  sha256?: string
  downloadUrl?: string
  name?: string
  description?: string
  tags?: string[]
  updatedAt?: string
  contact?: string
  source?: string
  /** 非 null 表示该条"仅查看"（不可选中），值为原因（§3.1） */
  viewOnlyReason: string | null
}

export type ParsedManifest = {
  entries: ManifestEntry[]
  warnings: string[]
}

const SHA256_REGEX = /^[a-f0-9]{64}$/i
/** 清单 version 长度上限（§3.1）。与 id 上限数值巧合一致，独立常量避免联动误伤 */
const VERSION_MAX_LENGTH = 64

/**
 * 解析清单 JSON（顶层数组）。单条字段非法只把该条标为"仅查看"，
 * 不阻断其余条目；id 重复保留第一条并警告。
 */
export function parseManifest(json: unknown): ParsedManifest {
  if (!Array.isArray(json)) {
    throw new Error('清单格式非法：顶层必须是数组')
  }
  const warnings: string[] = []
  let items = json
  if (items.length > MANIFEST_MAX_ENTRIES) {
    warnings.push(
      `清单条目数 ${items.length} 超过上限 ${MANIFEST_MAX_ENTRIES}，已截断`,
    )
    items = items.slice(0, MANIFEST_MAX_ENTRIES)
  }

  const seen = new Set<string>()
  const entries: ManifestEntry[] = []
  for (const raw of items) {
    const entry = parseManifestEntry(raw)
    if (entry === null) continue
    if (seen.has(entry.id)) {
      warnings.push(`清单存在重复 id：${entry.id}，已保留第一条`)
      continue
    }
    seen.add(entry.id)
    entries.push(entry)
  }
  return { entries, warnings }
}

function parseManifestEntry(raw: unknown): ManifestEntry | null {
  if (typeof raw !== 'object' || raw === null) return null
  const obj = raw as Record<string, unknown>

  const id = typeof obj.id === 'string' ? obj.id : ''
  const idError = validateSkillId(id)
  const version = typeof obj.version === 'string' ? obj.version : ''
  const filename =
    typeof obj.filename === 'string' && obj.filename ? obj.filename : undefined
  const downloadUrl =
    typeof obj.downloadUrl === 'string' && obj.downloadUrl
      ? obj.downloadUrl
      : undefined
  const sha256 =
    typeof obj.sha256 === 'string' && obj.sha256 ? obj.sha256 : undefined

  let viewOnlyReason: string | null = null
  if (idError) {
    viewOnlyReason = `id 非法：${idError}`
  } else if (!version || version.length > VERSION_MAX_LENGTH) {
    viewOnlyReason = 'version 缺失或过长'
  } else if (!filename && !downloadUrl) {
    viewOnlyReason = '缺 filename 且缺 downloadUrl，无法拼出下载地址'
  } else if (filename && !downloadUrl && !/^[^/\\]+$/.test(filename)) {
    // filename 语义是纯文件名。含路径序列虽会被 new URL() 无害化（仍落在
    // http(s) URL 上），但拦截能让清单错误尽早暴露。有 downloadUrl 时
    // filename 不参与拼接，无需拦截
    viewOnlyReason = 'filename 含路径字符，应为纯文件名'
  } else if (sha256 && !SHA256_REGEX.test(sha256)) {
    viewOnlyReason = 'sha256 格式非法'
  } else if (downloadUrl) {
    try {
      assertUrlAllowed(downloadUrl, 'downloadUrl')
    } catch (e) {
      viewOnlyReason = e instanceof Error ? e.message : String(e)
    }
  }

  return {
    id,
    version,
    filename,
    sha256,
    downloadUrl,
    name: typeof obj.name === 'string' ? obj.name : undefined,
    description:
      typeof obj.description === 'string' ? obj.description : undefined,
    tags: Array.isArray(obj.tags)
      ? obj.tags.filter((t): t is string => typeof t === 'string')
      : undefined,
    updatedAt:
      typeof obj.updatedAt === 'string' ? obj.updatedAt : undefined,
    contact: typeof obj.contact === 'string' ? obj.contact : undefined,
    source: typeof obj.source === 'string' ? obj.source : undefined,
    viewOnlyReason,
  }
}

// ---------------------------------------------------------------------------
// 网络（§6.3）：axios 统一走全局代理/证书拦截器；httpGet 可注入以便单测
// ---------------------------------------------------------------------------

export type HttpGetOptions = { timeout: number; maxContentLength: number }
export type HttpGet = (url: string, opts: HttpGetOptions) => Promise<Buffer>

/** 默认下载实现：arraybuffer、不跟随重定向（D14）、限时报体积 */
const defaultHttpGet: HttpGet = async (url, opts) => {
  const resp = await axios.get(url, {
    responseType: 'arraybuffer',
    maxRedirects: 0,
    timeout: opts.timeout,
    maxContentLength: opts.maxContentLength,
  })
  return Buffer.from(resp.data as ArrayBuffer)
}

export type FetchedManifest = ParsedManifest & { manifestUrl: string }

/** 拉取并解析清单。错误信息只含 origin + pathname，不带 query/fragment */
export async function fetchManifest(
  hubRoot: string,
  httpGet: HttpGet = defaultHttpGet,
): Promise<FetchedManifest> {
  // 防御性归一化：调用方可能传入未归一化的根地址，
  // 不归一化会让 new URL() 静默吃掉最后一段路径（§3.2）
  const manifestUrl = deriveManifestUrl(normalizeHubRoot(hubRoot))
  let body: Buffer
  try {
    body = await httpGet(manifestUrl, {
      timeout: MANIFEST_TIMEOUT_MS,
      maxContentLength: MANIFEST_MAX_BYTES,
    })
  } catch (e) {
    throw new Error(
      `拉取清单失败（${urlForLog(manifestUrl)}）：${errorText(e)}`,
    )
  }
  let json: unknown
  try {
    json = JSON.parse(body.toString('utf8'))
  } catch {
    throw new Error(`清单不是合法 JSON（${urlForLog(manifestUrl)}）`)
  }
  const parsed = parseManifest(json)
  return { ...parsed, manifestUrl }
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

// ---------------------------------------------------------------------------
// zip 下载与 sha256（§6 第 9-10 步）
// ---------------------------------------------------------------------------

/** 下载 zip 到内存。60s 超时、≤64MB、不跟随重定向（D14） */
export async function downloadZip(
  url: string,
  httpGet: HttpGet = defaultHttpGet,
): Promise<Buffer> {
  assertUrlAllowed(url, 'downloadUrl')
  try {
    return await httpGet(url, {
      timeout: ZIP_TIMEOUT_MS,
      maxContentLength: ZIP_MAX_BYTES,
    })
  } catch (e) {
    throw new Error(`下载 zip 失败（${urlForLog(url)}）：${errorText(e)}`)
  }
}

export function sha256Hex(buf: Buffer | Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex')
}

/**
 * §6 第 10 步：清单提供 sha256 时校验，不匹配立即抛错（此时 zip 还在内存，
 * 未落盘，满足"不落盘"要求）。清单未提供（现网现状）返回 false 表示未校验。
 */
export function verifyZipSha256(zipBuf: Buffer, expected?: string): boolean {
  if (!expected) return false
  const actual = sha256Hex(zipBuf)
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(
      `sha256 校验失败：期望 ${expected.toLowerCase()}，实际 ${actual.toLowerCase()}`,
    )
  }
  return true
}

// ---------------------------------------------------------------------------
// zip 结构判定（§3.3，三条规则）
// ---------------------------------------------------------------------------

export type ExtractedSkill = {
  /** 相对路径 → 内容（已按规则剥层；目录条目已剔除） */
  files: Record<string, Uint8Array>
  /** 相对路径 → unix mode，用于恢复 +x（参照 officialMarketplaceGcs 的做法） */
  modes: Record<string, number>
}

const SKILL_MD_REGEX = /^skill\.md$/i

/**
 * 解压并判定 zip 结构：
 * 1. 根目录有 SKILL.md → 整包原样（多 skill 包也走这条，命名空间由加载器生成）
 * 2. 否则恰好一个顶层目录且其下有 SKILL.md → 剥掉这层
 * 3. 否则报错，错误信息列出实际顶层条目
 */
export async function extractSkillFiles(zipBuf: Buffer): Promise<ExtractedSkill> {
  // unzipFile 自带路径穿越 / zip bomb / 体积防护（§6 第 11 步）
  const rawFiles = await unzipFile(zipBuf)
  const rawModes = parseZipModes(zipBuf)

  const filePaths = Object.keys(rawFiles).filter(p => !p.endsWith('/'))
  const rootHasSkillMd = filePaths.some(
    p => !p.includes('/') && SKILL_MD_REGEX.test(p),
  )

  let stripPrefix: string
  if (rootHasSkillMd) {
    stripPrefix = ''
  } else {
    // 顶层条目集合（文件取自身，目录取第一段）
    const topLevel = new Set(
      filePaths.map(p => (p.includes('/') ? p.slice(0, p.indexOf('/')) : p)),
    )
    const only =
      topLevel.size === 1 ? [...topLevel][0] : null
    const prefix = only ? `${only}/` : null
    const hasNestedSkillMd =
      prefix !== null &&
      filePaths.some(
        p => p.startsWith(prefix) && SKILL_MD_REGEX.test(p.slice(prefix.length)),
      )
    if (prefix === null || !hasNestedSkillMd) {
      throw new Error(
        `zip 结构无法识别：根目录没有 SKILL.md，且顶层不是单一目录。` +
          `实际顶层条目：${[...topLevel].join(', ')}`,
      )
    }
    stripPrefix = prefix
  }

  const files: Record<string, Uint8Array> = {}
  const modes: Record<string, number> = {}
  for (const p of filePaths) {
    const rel = p.slice(stripPrefix.length)
    if (!rel) continue // 被剥掉那层的目录自身条目
    files[rel] = rawFiles[p]
    const mode = rawModes[p]
    if (mode !== undefined) modes[rel] = mode
  }
  return { files, modes }
}

// ---------------------------------------------------------------------------
// sidecar（§8）：.ywcoder-source.json，客户端生成，随原子切换就位
// ---------------------------------------------------------------------------

export type SkillSidecar = {
  schemaVersion: number
  id: string
  version: string
  /** 安装时实际使用的 hub 根地址（归一化、以 / 结尾），用于来源变化检测（§7.2） */
  hubUrl: string
  /** 最终使用的完整下载地址（拼接结果或条目覆盖值） */
  downloadUrl: string
  /** 清单提供时才写入（D5 更新判定参与项） */
  sha256?: string
  installedAt: string
}

export function buildSidecar(fields: {
  id: string
  version: string
  hubUrl: string
  downloadUrl: string
  sha256?: string
}): SkillSidecar {
  return {
    schemaVersion: SIDECAR_SCHEMA_VERSION,
    id: fields.id,
    version: fields.version,
    hubUrl: fields.hubUrl,
    downloadUrl: fields.downloadUrl,
    ...(fields.sha256 ? { sha256: fields.sha256 } : {}),
    installedAt: new Date().toISOString(),
  }
}

export type SidecarReadResult =
  | { kind: 'valid'; sidecar: SkillSidecar }
  | { kind: 'missing' }
  /** 损坏 / schemaVersion 不支持 / id 与目录名不一致 → 一律视为"来源未知"（§7.1） */
  | { kind: 'invalid' }

export async function readSidecar(
  skillDir: string,
  expectedId: string,
): Promise<SidecarReadResult> {
  let raw: string
  try {
    raw = await readFile(join(skillDir, SIDECAR_FILENAME), 'utf8')
  } catch {
    return { kind: 'missing' }
  }
  try {
    const obj = JSON.parse(raw) as Partial<SkillSidecar>
    if (obj.schemaVersion !== SIDECAR_SCHEMA_VERSION) return { kind: 'invalid' }
    if (obj.id !== expectedId) return { kind: 'invalid' }
    if (
      typeof obj.version !== 'string' ||
      typeof obj.hubUrl !== 'string' ||
      typeof obj.downloadUrl !== 'string' ||
      typeof obj.installedAt !== 'string'
    ) {
      return { kind: 'invalid' }
    }
    // 可选字段同样要校验类型：sha256 被改成非 string 时，
    // decideOverwrite 的 toLowerCase() 会抛 TypeError 而非按 §7.1 落入"来源未知"
    if (obj.sha256 !== undefined && typeof obj.sha256 !== 'string') {
      return { kind: 'invalid' }
    }
    return { kind: 'valid', sidecar: obj as SkillSidecar }
  } catch {
    return { kind: 'invalid' }
  }
}

// ---------------------------------------------------------------------------
// staging 与原子切换（§5 / §6 / §6.2）
// ---------------------------------------------------------------------------

/** staging 根是 skills 根的兄弟目录（D7）：同文件系统可 rename，且不会被当 skill 加载 */
export function stagingRootFor(skillsRoot: string): string {
  return join(dirname(skillsRoot), 'skills-staging')
}

function newDirOf(stagingRoot: string, id: string): string {
  return join(stagingRoot, `${id}.new`)
}
function oldDirOf(stagingRoot: string, id: string): string {
  return join(stagingRoot, `${id}.old`)
}

/**
 * §6 第 13-14 步：把解压结果逐文件写入 <staging>/<id>.new/，
 * 恢复 +x，最后写 sidecar。返回 new 目录路径。
 */
export async function stageSkill(opts: {
  stagingRoot: string
  id: string
  extracted: ExtractedSkill
  sidecar: SkillSidecar
}): Promise<string> {
  const newDir = newDirOf(opts.stagingRoot, opts.id)
  await rm(newDir, { recursive: true, force: true })
  await mkdir(newDir, { recursive: true })
  for (const [rel, data] of Object.entries(opts.extracted.files)) {
    const dest = join(newDir, rel)
    await mkdir(dirname(dest), { recursive: true })
    await writeFile(dest, data)
    const mode = opts.extracted.modes[rel]
    if (mode !== undefined && mode & 0o111) {
      // 只在带可执行位时 chmod；EPERM/ENOTSUP 容忍（NFS root_squash 等），
      // 丢失 +x 好过整个安装失败
      await chmod(dest, mode & 0o777).catch(() => {})
    }
  }
  await writeFile(
    join(newDir, SIDECAR_FILENAME),
    JSON.stringify(opts.sidecar, null, 2),
  )
  return newDir
}

/**
 * §6.2 遗留恢复。安装开始时按顺序处理：
 * new 残留 → 删；old 残留且目标不存在 → 恢复为目标；old 残留且目标存在 → 删。
 */
export async function recoverStaging(opts: {
  stagingRoot: string
  id: string
  target: string
}): Promise<void> {
  const newDir = newDirOf(opts.stagingRoot, opts.id)
  const oldDir = oldDirOf(opts.stagingRoot, opts.id)
  await rm(newDir, { recursive: true, force: true })
  if (!existsSync(oldDir)) return
  if (!existsSync(opts.target)) {
    // 上次死在换出与换入之间：把旧版本恢复回目标
    await rename(oldDir, opts.target)
  } else {
    // 上次切换已成功，只残留旧目录
    await rm(oldDir, { recursive: true, force: true })
  }
}

/**
 * §6 第 15-18 步：切换前复核 → 换出旧目录 → 换入新目录（失败回滚）→ 删旧。
 * 成功后 staging 根内与本 id 相关的目录全部清除；staging 根为空时连根一起删（§5）。
 */
export async function atomicSwitch(opts: {
  stagingRoot: string
  id: string
  target: string
  /** 仅单测注入用：替换 rename 以模拟切换失败 */
  renameFn?: typeof rename
}): Promise<void> {
  const { stagingRoot, id, target } = opts
  const doRename = opts.renameFn ?? rename
  const newDir = newDirOf(stagingRoot, id)
  const oldDir = oldDirOf(stagingRoot, id)

  // 第 15 步：切换前复核——SKILL.md 存在（大小写不敏感）且 sidecar 可解析
  const entries = await readdir(newDir)
  if (!entries.some(e => SKILL_MD_REGEX.test(e))) {
    throw new Error(`切换前复核失败：${id}.new 内没有 SKILL.md`)
  }
  const sidecarResult = await readSidecar(newDir, id)
  if (sidecarResult.kind !== 'valid') {
    throw new Error(`切换前复核失败：${id}.new 内 sidecar 不可解析`)
  }

  // 第 16 步：换出旧目录
  if (existsSync(target)) {
    await rm(oldDir, { recursive: true, force: true })
    await doRename(target, oldDir)
  }
  // 第 17 步：换入新目录，失败则把旧目录恢复回去
  try {
    await doRename(newDir, target)
  } catch (e) {
    if (existsSync(oldDir)) {
      await doRename(oldDir, target).catch(() => {})
    }
    throw e
  }
  // 第 18 步：删旧
  await rm(oldDir, { recursive: true, force: true })
  // §5：staging 用完即删，空目录时连根一起删；非空（其他 id 残留）则保留
  await rmdir(stagingRoot).catch(() => {})
}

// ---------------------------------------------------------------------------
// 策略检查（§9.1）与路径逃逸校验（§9.2）
// ---------------------------------------------------------------------------

export type SkillScope = 'user' | 'project'

/**
 * 安装前策略检查，不通过直接抛错，--force 不可绕过。
 * --remove 不调本函数（清理不等于加载授权，§9.1）。
 */
export async function assertInstallAllowed(scope: SkillScope): Promise<void> {
  const { isRestrictedToPluginOnly } = await import(
    '../settings/pluginOnlyPolicy.js'
  )
  const { isSettingSourceEnabled } = await import('../settings/constants.js')
  if (
    isRestrictedToPluginOnly('skills') ||
    !isSettingSourceEnabled(
      scope === 'user' ? 'userSettings' : 'projectSettings',
    )
  ) {
    throw new Error(
      '组织策略要求 skills 通过 plugin 或受管来源提供，/skill-install 已被禁用',
    )
  }
}

/** scope → skills 根路径（§2.2）。lazy import 避免拖入整个 loadSkillsDir 依赖树 */
export async function resolveSkillsRoot(
  scope: SkillScope,
  cwd?: string,
): Promise<string> {
  const { getSkillsPath } = await import('../../skills/loadSkillsDir.js')
  return scope === 'user'
    ? getSkillsPath('userSettings', 'skills')
    : getSkillsPath('projectSettings', 'skills', cwd)
}

/**
 * §9.2 三层校验中的后两层（第一层 id 正则白名单在参数解析与清单校验已完成）：
 * 字符串包含 + realpath 包含。目标路径链上存在指向 skills 根之外的
 * 符号链接时拒绝安装。
 */
export async function assertPathInside(
  skillsRoot: string,
  target: string,
): Promise<void> {
  const resolvedRoot = resolve(skillsRoot)
  const resolvedTarget = resolve(target)
  if (!resolvedTarget.startsWith(resolvedRoot + sep)) {
    throw new Error(`目标路径不在 skills 根内：${resolvedTarget}`)
  }

  // skills 根本身可能是符号链接（§13.7-49：realpath 后仍一致则允许）
  const realRoot = await realpath(resolvedRoot).catch(() => null)
  if (realRoot === null) return // 根不存在（首次安装），无链接可查
  const realTarget = await realpath(resolvedTarget).catch(() => null)
  if (realTarget !== null && !realTarget.startsWith(realRoot + sep)) {
    throw new Error(
      `目标路径经符号链接指向 skills 根之外，拒绝安装：${realTarget}`,
    )
  }
}

// ---------------------------------------------------------------------------
// 目录三态（§7.1）与覆盖判定（§7.2）
// ---------------------------------------------------------------------------

export type SkillDirState =
  | { kind: 'absent' }
  | { kind: 'managed'; sidecar: SkillSidecar }
  | { kind: 'unknown' }

export async function scanSkillDir(
  target: string,
  id: string,
): Promise<SkillDirState> {
  if (!existsSync(target)) return { kind: 'absent' }
  const result = await readSidecar(target, id)
  return result.kind === 'valid'
    ? { kind: 'managed', sidecar: result.sidecar }
    : { kind: 'unknown' }
}

export type OverwriteDecision =
  | { action: 'install' }
  | { action: 'already-latest'; version: string }
  | { action: 'update'; previousVersion: string }
  | { action: 'confirm-hub-changed'; oldHub: string; newHub: string }
  | { action: 'confirm-unknown-source' }

/** §7.2 覆盖判定（纯函数）。更新判定见 D5：version 不同 || sha256 不同 */
export function decideOverwrite(
  state: SkillDirState,
  entry: ManifestEntry,
  hubRoot: string,
): OverwriteDecision {
  if (state.kind === 'absent') return { action: 'install' }
  if (state.kind === 'unknown') return { action: 'confirm-unknown-source' }

  const { sidecar } = state
  if (sidecar.hubUrl !== hubRoot) {
    return { action: 'confirm-hub-changed', oldHub: sidecar.hubUrl, newHub: hubRoot }
  }
  // sha256 比对：清单未提供 → 退化为 version-only；sidecar 存过而清单没给 →
  // 视为无法比对，按 version 判定（§7.2 附注）
  const versionSame = sidecar.version === entry.version
  const sha256Same =
    entry.sha256 === undefined || sidecar.sha256 === undefined
      ? true
      : sidecar.sha256.toLowerCase() === entry.sha256.toLowerCase()
  if (versionSame && sha256Same) {
    return { action: 'already-latest', version: sidecar.version }
  }
  return { action: 'update', previousVersion: sidecar.version }
}

// ---------------------------------------------------------------------------
// 安装 / 卸载编排（§6）
// ---------------------------------------------------------------------------

export type InstallerDeps = {
  httpGet?: HttpGet
  readSettings?: (source: 'policySettings' | 'userSettings') => SettingsJson | null
  /** 覆盖确认（§7.2）：传入即交互模式；不传则视为非交互，需确认时抛错要求 --force */
  confirm?: (message: string) => Promise<boolean>
  /** 成功切换后的缓存刷新（§10）；测试注入计数器断言调用时机 */
  refreshCaches?: () => void | Promise<void>
  /** 策略检查（§9.1）；测试注入以模拟策略锁定 */
  checkPolicy?: (scope: SkillScope) => void | Promise<void>
  /** 仅单测注入：模拟 rename / rm 失败 */
  renameFn?: typeof rename
  rmFn?: typeof rm
}

async function defaultRefreshCaches(): Promise<void> {
  const { clearCommandsCache } = await import('../../commands.js')
  clearCommandsCache()
  const { resetSentSkillNames } = await import('../attachments.js')
  resetSentSkillNames()
}

export type InstallResult =
  | {
      kind: 'installed' | 'updated'
      path: string
      version: string
      previousVersion?: string
      /** sha256 是否校验过（清单未提供则为 false，UI 标注"未校验"） */
      verified: boolean
      hubUrl: string
    }
  | { kind: 'already-latest'; path: string; version: string }

export async function installSkill(
  opts: { id: string; scope: SkillScope; skillsRoot: string; force?: boolean },
  deps: InstallerDeps = {},
): Promise<InstallResult> {
  const { id, scope, skillsRoot, force = false } = opts

  // 第 1 步：id 校验（参数解析已做过，这里兜底）
  const idError = validateSkillId(id)
  if (idError) throw new Error(idError)

  // 第 2 步：策略检查（§9.1，--force 不可绕过）
  await (deps.checkPolicy ?? assertInstallAllowed)(scope)

  // 第 3-4 步：路径解析与逃逸校验（§9.2）
  const target = join(skillsRoot, id)
  await assertPathInside(skillsRoot, target)

  // skills 根可能不存在（首次安装），先建出来——rename 要求目标父目录存在。
  // 注意：首次创建时 watcher 尚未监听该目录，缓存刷新依赖第 19 步（§10）
  await mkdir(skillsRoot, { recursive: true })

  // 第 5 步：清理 / 恢复遗留 staging（§6.2）
  const stagingRoot = stagingRootFor(skillsRoot)
  await recoverStaging({ stagingRoot, id, target })

  // 第 6 步：读取目标目录现状（§7.1）
  const state = await scanSkillDir(target, id)

  // 第 7 步：拉清单
  const hub = resolveHubConfig(deps.readSettings)
  if (hub === null) {
    const { getSettingsFilePathForSource } = await import(
      '../settings/settings.js'
    )
    const settingsPath = getSettingsFilePathForSource('userSettings')
    throw new Error(
      `未配置 ywdevhubUrl。请在 ${settingsPath} 中添加：\n` +
        `{ "ywdevhubUrl": "http://10.x.x.x/yw-devhub/" }`,
    )
  }
  const manifest = await fetchManifest(hub.hubRoot, deps.httpGet)
  const entry = manifest.entries.find(e => e.id === id)
  if (!entry) throw new Error(`清单中不存在 id 为 ${id} 的 skill`)
  if (entry.viewOnlyReason !== null) {
    throw new Error(`该条目不可安装：${entry.viewOnlyReason}`)
  }

  // 第 8 步：覆盖语义判定（§7.2）
  const decision = decideOverwrite(state, entry, hub.hubRoot)
  if (decision.action === 'already-latest') {
    return { kind: 'already-latest', path: target, version: decision.version }
  }
  let previousVersion: string | undefined
  if (decision.action === 'update') {
    previousVersion = decision.previousVersion
  } else if (decision.action === 'confirm-hub-changed') {
    const message =
      `该 skill 的安装来源已变化：\n  旧：${decision.oldHub}\n  新：${decision.newHub}\n` +
      `继续将按新来源覆盖安装。`
    await requireConfirm(deps, force, message,
      `来源已变化，非交互模式需加 --force（${message}）`)
    previousVersion = state.kind === 'managed' ? state.sidecar.version : undefined
  } else if (decision.action === 'confirm-unknown-source') {
    const message =
      `目标目录已存在且来源未知（非 /skill-install 安装）。` +
      `继续将永久删除其中的全部本地修改：${target}`
    await requireConfirm(deps, force, message,
      `目录来源未知，非交互模式需加 --force（会永久删除本地修改）：${target}`)
  }

  // 第 9-12 步：下载、sha256、解压、结构判定
  const zipUrl = deriveZipUrl(hub.hubRoot, entry)
  const zipBuf = await downloadZip(zipUrl, deps.httpGet)
  const verified = verifyZipSha256(zipBuf, entry.sha256)
  const extracted = await extractSkillFiles(zipBuf)

  // 第 13-14 步：写 staging 与 sidecar
  await stageSkill({
    stagingRoot,
    id,
    extracted,
    sidecar: buildSidecar({
      id,
      version: entry.version,
      hubUrl: hub.hubRoot,
      downloadUrl: zipUrl,
      sha256: entry.sha256,
    }),
  })

  // 第 15-18 步：复核与原子切换
  await atomicSwitch({ stagingRoot, id, target, renameFn: deps.renameFn })

  // 临时排障探针：人为拉长"写盘→settle"窗口，模拟内网慢盘（如 NFS），
  // 让 watcher reload 落在 local-jsx 挂起期间以验证卡死根因，修完即删
  if (process.env.YW_DEBUG_SETTLE_DELAY_MS) {
    await new Promise(r => setTimeout(r, Number(process.env.YW_DEBUG_SETTLE_DELAY_MS)))
  }

  // 第 19 步：只在切换成功后刷新缓存（§6.1）
  await (deps.refreshCaches ?? defaultRefreshCaches)()

  return {
    kind: state.kind === 'managed' ? 'updated' : 'installed',
    path: target,
    version: entry.version,
    previousVersion,
    verified,
    hubUrl: hub.hubRoot,
  }
}

/**
 * 覆盖确认的三种去向：--force 直通；无 confirm 回调视为非交互，抛引导
 * --force 的错误；confirm 拒答是用户主动取消，抛取消错误——不再把交互
 * 拒答误导性地提示为"非交互模式需加 --force"。
 */
async function requireConfirm(
  deps: InstallerDeps,
  force: boolean,
  message: string,
  nonInteractiveError: string,
): Promise<void> {
  if (force) return
  if (!deps.confirm) throw new Error(nonInteractiveError)
  if (!(await deps.confirm(message))) throw new Error('已取消安装')
}

export type RemoveResult = { removed: true; path: string }

/**
 * --remove（§9.1 / D13）：只删 sidecar 合法的目录；不做策略检查
 * （清理不等于加载授权）；拒绝时打印实际路径供手动删除。
 */
export async function removeSkill(
  opts: { id: string; skillsRoot: string },
  deps: InstallerDeps = {},
): Promise<RemoveResult> {
  const { id, skillsRoot } = opts
  const target = join(skillsRoot, id)
  // 与安装路径对称的三层校验（§9.2"缺一不可"）：当前 id 白名单 + rm 不跟随
  // 符号链接已无可利用路径，此处防未来改动（如先 realpath 再删）引入漏洞
  await assertPathInside(skillsRoot, target)
  const state = await scanSkillDir(target, id)
  if (state.kind !== 'managed') {
    throw new Error(
      `${id} 不是由 /skill-install 安装的，未执行删除。\n如需手动删除：${target}`,
    )
  }
  const doRm = deps.rmFn ?? ((p: string) => rm(p, { recursive: true }))
  await doRm(target)
  // 删除成功才刷新缓存；删除失败不刷新，不留下"已卸载"假状态（§13.5-35）
  await (deps.refreshCaches ?? defaultRefreshCaches)()
  return { removed: true, path: target }
}
