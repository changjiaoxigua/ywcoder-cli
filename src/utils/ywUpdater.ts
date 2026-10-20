/** YwCoder 内网离线包更新：清单检查、下载校验与全局 npm 安装。 */
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import axios from 'axios'
import { execa } from 'execa'

import { assertUrlAllowed, normalizeHubRoot, resolveHubConfig } from './skills/skillInstaller.js'
import { extractYwCoderEntry, isNewerVersion, isValidVersion, MANIFEST_MAX_BYTES, matchPlatformPackage, matchPlatformPackageFilename } from './ywUpdateCheck.js'

export const UPDATE_PACKAGE_MAX_BYTES = 256 * 1024 * 1024
const DOWNLOAD_TIMEOUT_MS = 60_000

export type UpdatePackage = {
  filename: string
  url: string
  size: number
  sha256: string
}

export type UpdateRelease = {
  version: string
  packageFilename: string | null
  installablePackage: UpdatePackage | null
}

/** 包内身份必须与清单一致；开发版的包版本仍是基础版本号。 */
export function isExpectedPackageIdentity(identity: unknown, expectedVersion: string): boolean {
  if (!identity || typeof identity !== 'object') return false
  const value = identity as { name?: unknown; version?: unknown }
  return value.name === '@dcywzc/ywcoder' &&
    value.version === expectedVersion.split(/[+-]/, 1)[0]
}

/** 路径必须是 hub 内的相对路径；清单不能指定其他主机或父目录。 */
export function resolveUpdatePackage(
  packages: unknown,
  platform: NodeJS.Platform,
  hubRoot: string,
): UpdatePackage | null {
  const matching = matchPlatformPackage(packages, platform)
  if (!matching || typeof matching.filename !== 'string' ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*\.tgz$/.test(matching.filename) ||
      matching.filename.split('/').some(part => part === '..' || part === '.') ||
      typeof matching.sha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(matching.sha256) ||
      !Number.isSafeInteger(matching.size) || (matching.size as number) <= 0 ||
      (matching.size as number) > UPDATE_PACKAGE_MAX_BYTES) return null
  const root = normalizeHubRoot(hubRoot)
  const url = new URL(matching.filename, root).toString()
  assertUrlAllowed(url, '更新包地址')
  if (!url.startsWith(root)) return null
  return {
    filename: basename(matching.filename),
    url,
    size: matching.size as number,
    sha256: matching.sha256.toLowerCase(),
  }
}

/** 手动检查始终拉取最新清单，不受启动检查的 24 小时缓存限制。 */
export async function fetchUpdateRelease(
  currentVersion: string,
  platform: NodeJS.Platform = process.platform,
  deps: {
    resolveHub?: typeof resolveHubConfig
    httpGet?: (url: string) => Promise<Buffer>
  } = {},
): Promise<UpdateRelease | null> {
  const hub = (deps.resolveHub ?? resolveHubConfig)()
  if (!hub) throw new Error('未配置 ywdevhubUrl，请联系管理员配置内网更新源。')
  const manifestUrl = new URL('tools.json', hub.hubRoot).toString()
  const body = deps.httpGet
    ? await deps.httpGet(manifestUrl)
    : Buffer.from((await axios.get(manifestUrl, {
      responseType: 'arraybuffer',
      timeout: 1_500,
      maxRedirects: 0,
      maxContentLength: MANIFEST_MAX_BYTES,
    })).data as ArrayBuffer)
  if (body.length > MANIFEST_MAX_BYTES) throw new Error('更新清单超过大小上限。')
  const entry = extractYwCoderEntry(JSON.parse(body.toString('utf8')))
  if (!entry || !isValidVersion(entry.version)) throw new Error('更新清单缺少有效的 ywcoder-cli 版本。')
  if (!isNewerVersion(entry.version, currentVersion)) return null
  return {
    version: entry.version,
    packageFilename: matchPlatformPackageFilename(entry.packages, platform),
    installablePackage: resolveUpdatePackage(entry.packages, platform, hub.hubRoot),
  }
}

/** 流式下载并检查字节数与摘要，避免将整个安装包载入内存。 */
export async function downloadVerifiedPackage(pkg: UpdatePackage, directory: string): Promise<string> {
  const response = await axios.get(pkg.url, {
    responseType: 'stream',
    timeout: DOWNLOAD_TIMEOUT_MS,
    maxRedirects: 0,
  })
  const path = join(directory, pkg.filename)
  const hash = createHash('sha256')
  let bytes = 0
  const verify = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length
      if (bytes > pkg.size || bytes > UPDATE_PACKAGE_MAX_BYTES) {
        callback(new Error('更新包超过清单声明的大小。'))
        return
      }
      hash.update(chunk)
      callback(null, chunk)
    },
  })
  await pipeline(response.data as NodeJS.ReadableStream, verify, createWriteStream(path, { mode: 0o600 }))
  if (bytes !== pkg.size || hash.digest('hex') !== pkg.sha256) {
    throw new Error('更新包大小或 SHA-256 校验失败。')
  }
  return path
}

/** 不支持自动安装时，保留经校验的包供管理员按原安装方式使用。 */
export async function downloadUpdateForManualInstall(pkg: UpdatePackage): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'ywcoder-update-'))
  try {
    return await downloadVerifiedPackage(pkg, directory)
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

/** 安装包只使用 npm 本地离线安装；失败时保留已校验包供手动处理。 */
export async function installUpdatePackage(pkg: UpdatePackage, expectedVersion: string): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'ywcoder-update-'))
  let verified = false
  let installed = false
  try {
    const path = await downloadVerifiedPackage(pkg, directory)
    verified = true
    const archive = await execa('tar', ['-xOzf', path, 'package/package.json'], {
      reject: false,
      maxBuffer: 256 * 1024,
    })
    if (archive.exitCode !== 0) {
      throw new Error(`更新包无法读取 package.json。已校验安装包保留在：${path}`)
    }
    let identity: unknown
    try {
      identity = JSON.parse(archive.stdout)
    } catch {
      throw new Error(`更新包的 package.json 无效。已校验安装包保留在：${path}`)
    }
    if (!isExpectedPackageIdentity(identity, expectedVersion)) {
      throw new Error(`更新包身份或版本与清单不符。已校验安装包保留在：${path}`)
    }
    const result = await execa('npm', [
      'install', '-g', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', path,
    ], { stdio: 'inherit', reject: false })
    if (result.exitCode !== 0) {
      throw new Error(`安装失败（退出码 ${result.exitCode}）。已校验安装包保留在：${path}。请用有权限的终端按原安装方式重试。`)
    }
    const verifiedVersion = await execa('ywcoder', ['--version'], { reject: false })
    if (verifiedVersion.exitCode !== 0 || !verifiedVersion.stdout.startsWith(`${expectedVersion} (`)) {
      throw new Error(`安装后版本验证失败。已校验安装包保留在：${path}`)
    }
    installed = true
  } finally {
    if (!verified || installed) await rm(directory, { recursive: true, force: true })
  }
}
