import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { spyOn } from 'bun:test'

import axios from 'axios'
import * as execaModule from 'execa'
import { downloadVerifiedPackage, fetchUpdateRelease, installUpdatePackage, isExpectedInstalledVersion, isExpectedPackageIdentity, resolveUpdatePackage } from './ywUpdater.js'
import { checkYwCoderUpdate, getCachedUpdate, resetYwUpdateCheckForTest, type YwUpdateCheckCache } from './ywUpdateCheck.js'

const HUB = 'http://example.invalid/yw-devhub/'
const CONTENT = Buffer.from('测试安装包')
const SHA = createHash('sha256').update(CONTENT).digest('hex')

test('选择当前平台包并限制下载路径、摘要和大小', () => {
  const packages = [
    { platform: 'Linux', filename: 'tools/ywcoder-linux.tgz', size: CONTENT.length, sha256: SHA },
    { platform: 'Windows', filename: 'tools/ywcoder-win.tgz', size: CONTENT.length, sha256: SHA },
  ]
  assert.deepEqual(resolveUpdatePackage(packages, 'linux', HUB), {
    filename: 'ywcoder-linux.tgz',
    url: `${HUB}tools/ywcoder-linux.tgz`,
    size: CONTENT.length,
    sha256: SHA,
  })
  assert.equal(resolveUpdatePackage(packages, 'darwin', HUB), null)
  for (const filename of ['../other.tgz', 'https://evil.test/p.tgz', '/p.tgz', 'tools/p.zip']) {
    assert.equal(resolveUpdatePackage([{ platform: 'Linux', filename, size: CONTENT.length, sha256: SHA }], 'linux', HUB), null)
  }
  assert.equal(resolveUpdatePackage([{ platform: 'Linux', filename: 'p.tgz', size: CONTENT.length, sha256: 'bad' }], 'linux', HUB), null)
  assert.equal(resolveUpdatePackage([{ platform: 'Linux', filename: 'p.tgz', size: 0, sha256: SHA }], 'linux', HUB), null)
})

test('下载后按字节数和 SHA-256 校验，篡改包不能安装', async () => {
  const original = axios.get
  const directory = await mkdtemp(join(tmpdir(), 'ywcoder-update-test-'))
  const pkg = {
    filename: 'ywcoder-linux.tgz', url: `${HUB}tools/ywcoder-linux.tgz`,
    size: CONTENT.length, sha256: SHA,
  }
  try {
    axios.get = (async () => ({ data: Readable.from([CONTENT]) })) as typeof axios.get
    const path = await downloadVerifiedPackage(pkg, directory)
    assert.deepEqual(await readFile(path), CONTENT)

    axios.get = (async () => ({ data: Readable.from([Buffer.from('已篡改安装包')]) })) as typeof axios.get
    await assert.rejects(downloadVerifiedPackage(pkg, directory), /校验失败|超过/)
  } finally {
    axios.get = original
    await rm(directory, { recursive: true, force: true })
  }
})

test('安装前核对包名和基础版本，兼容开发版显示后缀', () => {
  assert.equal(isExpectedPackageIdentity({ name: '@dcywzc/ywcoder', version: '1.3.2' }, '1.3.2-dev.abc123'), true)
  assert.equal(isExpectedPackageIdentity({ name: '@dcywzc/ywcoder', version: '1.3.1' }, '1.3.2'), false)
  assert.equal(isExpectedPackageIdentity({ name: 'other', version: '1.3.2' }, '1.3.2'), false)
})

test('安装后版本校验兼容 CI 开发版，但拒绝旧版本、不同构建和异常输出', () => {
  assert.equal(isExpectedInstalledVersion('1.3.3 (YwCoder, build #1, 2026-10-26)', '1.3.3'), true)
  assert.equal(isExpectedInstalledVersion('1.3.3-dev.0728f36 (YwCoder, build #1, 2026-10-26)\n', '1.3.3'), true)
  assert.equal(isExpectedInstalledVersion('1.3.3-dev.0728f36 (YwCoder)', '1.3.3-dev.0728f36'), true)
  assert.equal(isExpectedInstalledVersion('1.3.3-dev.old (YwCoder)', '1.3.3-dev.0728f36'), false)
  assert.equal(isExpectedInstalledVersion('1.3.2-dev.e3c0137 (YwCoder)', '1.3.3'), false)
  assert.equal(isExpectedInstalledVersion('1.3.30 (YwCoder)', '1.3.3'), false)
  assert.equal(isExpectedInstalledVersion('1.3.3-beta.1 (YwCoder)', '1.3.3'), false)
  assert.equal(isExpectedInstalledVersion('1.3.3 (OtherApp)', '1.3.3'), false)
  assert.equal(isExpectedInstalledVersion('启动失败', '1.3.3'), false)
})

for (const actual of ['1.3.3-dev.0728f36', '1.3.2-dev.e3c0137']) {
  test(`完整安装流程核对实际输出 ${actual}，正确处理临时包`, async () => {
    const originalGet = axios.get
    const run = spyOn(execaModule, 'execa')
      .mockResolvedValueOnce({ exitCode: 0, stdout: JSON.stringify({ name: '@dcywzc/ywcoder', version: '1.3.3' }) } as never)
      .mockResolvedValueOnce({ exitCode: 0, stdout: '' } as never)
      .mockResolvedValueOnce({ exitCode: 0, stdout: `${actual} (YwCoder, build #1, 2026-10-26)\n` } as never)
    let path: string | undefined
    try {
      axios.get = (async () => ({ data: Readable.from([CONTENT]) })) as typeof axios.get
      const install = installUpdatePackage({
        filename: 'ywcoder-1.3.3.tgz', url: `${HUB}tools/ywcoder-1.3.3.tgz`,
        size: CONTENT.length, sha256: SHA,
      }, '1.3.3')
      if (actual.startsWith('1.3.3-')) {
        await install
      } else {
        await assert.rejects(install, /安装后版本验证失败（清单版本 1\.3\.3，实际输出 1\.3\.2-dev\.e3c0137/)
      }
      assert.deepEqual(run.mock.calls.map(call => call[0]), ['tar', 'npm', 'ywcoder'])
      path = (run.mock.calls[0]![1] as string[])[1]!
      if (actual.startsWith('1.3.3-')) await assert.rejects(access(path))
      else await access(path)
    } finally {
      // 子进程全部使用替身，测试不会运行真实 npm 安装。
      path ??= (run.mock.calls[0]?.[1] as string[] | undefined)?.[1]
      axios.get = originalGet
      run.mockRestore()
      if (path) await rm(dirname(path), { recursive: true, force: true })
    }
  })
}

test('手动检查直接读取 hub 清单并返回当前平台的新版本', async () => {
  let requestedUrl = ''
  let cache: YwUpdateCheckCache | undefined
  const store = {
    read: () => cache,
    write: (value: YwUpdateCheckCache) => { cache = value },
  }
  const release = await fetchUpdateRelease('1.3.1', 'linux', {
    store,
    now: 1000,
    resolveHub: () => ({ hubRoot: HUB, source: 'userSettings' }),
    httpGet: async url => {
      requestedUrl = url
      return Buffer.from(JSON.stringify([{
        id: 'ywcoder-cli', version: '1.3.2',
        packages: [{ platform: 'Linux', filename: 'tools/ywcoder-linux.tgz', size: CONTENT.length, sha256: SHA }],
      }]))
    },
  })
  assert.equal(requestedUrl, `${HUB}tools.json`)
  assert.equal(release?.version, '1.3.2')
  assert.equal(release?.installablePackage?.sha256, SHA)
  // 模拟下一次启动：直接读手动检查缓存显示提示，且不重复访问清单。
  assert.deepEqual(getCachedUpdate(HUB, '1.3.1', store), {
    latestVersion: '1.3.2',
    packageFilename: 'ywcoder-linux.tgz',
  })
  await checkYwCoderUpdate({
    store,
    now: 1001,
    currentVersion: '1.3.1',
    isInteractive: () => true,
    isRemoteMode: () => false,
    isDisabled: () => false,
    resolveHub: () => ({ hubRoot: HUB, source: 'userSettings' }),
    httpGet: async () => { throw new Error('不应重复请求') },
  })
  assert.equal(cache?.lastCheckedAt, 1000)
  resetYwUpdateCheckForTest()
})

test('手动检查已是最新版或无本机包时清除旧提醒，失败时保留缓存', async () => {
  for (const [currentVersion, platform] of [['1.3.2', 'linux'], ['1.3.1', 'darwin']] as const) {
    let cache: YwUpdateCheckCache = {
      lastCheckedAt: 1,
      hubRoot: HUB,
      latestVersion: '9.9.9',
      packageFilename: 'old.tgz',
    }
    const store = {
      read: () => cache,
      write: (value: YwUpdateCheckCache) => { cache = value },
    }
    const deps = {
      store,
      now: 1000,
      resolveHub: () => ({ hubRoot: HUB, source: 'userSettings' as const }),
      httpGet: async () => Buffer.from(JSON.stringify([{
        id: 'ywcoder-cli', version: '1.3.2',
        packages: [{ platform: 'Linux', filename: 'tools/ywcoder-linux.tgz' }],
      }])),
    }
    const previous = cache
    await assert.rejects(fetchUpdateRelease(currentVersion, platform, {
      ...deps,
      httpGet: async () => { throw new Error('网络不可达') },
    }), /网络不可达/)
    assert.equal(cache, previous)

    await fetchUpdateRelease(currentVersion, platform, deps)
    assert.equal(getCachedUpdate(HUB, currentVersion, store), null)
    assert.deepEqual(cache, { lastCheckedAt: 1000, hubRoot: HUB, currentVersion })
  }
})
