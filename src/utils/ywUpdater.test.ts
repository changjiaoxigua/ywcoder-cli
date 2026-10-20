import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'

import axios from 'axios'
import { downloadVerifiedPackage, fetchUpdateRelease, isExpectedPackageIdentity, resolveUpdatePackage } from './ywUpdater.js'

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

test('手动检查直接读取 hub 清单并返回当前平台的新版本', async () => {
  let requestedUrl = ''
  const release = await fetchUpdateRelease('1.3.1', 'linux', {
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
})
