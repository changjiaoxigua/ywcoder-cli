import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test'
import * as diagnostic from '../utils/doctorDiagnostic.js'
import * as updater from '../utils/ywUpdater.js'
import { ywUpdate } from './ywUpdate.js'

const originalMacro = (globalThis as Record<string, unknown>).MACRO
const pkg: updater.UpdatePackage = {
  filename: 'ywcoder-1.4.0.tgz',
  url: 'https://hub.example/tools/ywcoder-1.4.0.tgz',
  size: 100,
  sha256: 'a'.repeat(64),
}

beforeEach(() => {
  ;(globalThis as Record<string, unknown>).MACRO = { DISPLAY_VERSION: '1.3.2' }
  spyOn(console, 'log').mockImplementation(() => {})
  spyOn(updater, 'fetchUpdateRelease').mockResolvedValue({
    version: '1.4.0',
    packageFilename: pkg.filename,
    installablePackage: pkg,
  })
  spyOn(diagnostic, 'getCurrentInstallationType').mockResolvedValue('npm-global')
  spyOn(updater, 'installUpdatePackage').mockResolvedValue()
  spyOn(updater, 'downloadUpdateForManualInstall').mockResolvedValue('/tmp/ywcoder-1.4.0.tgz')
})

afterEach(() => {
  mock.restore()
  ;(globalThis as Record<string, unknown>).MACRO = originalMacro
})

test('执行更新直接安装，无需 --yes 或读取终端确认', async () => {
  await ywUpdate({})
  expect(updater.installUpdatePackage).toHaveBeenCalledWith(pkg, '1.4.0')
  expect(updater.downloadUpdateForManualInstall).not.toHaveBeenCalled()
})

test('兼容旧版 --yes 参数', async () => {
  await ywUpdate({ yes: true })
  expect(updater.installUpdatePackage).toHaveBeenCalledWith(pkg, '1.4.0')
})

test('--check 仅检查，即使带 --yes 也不下载安装', async () => {
  await ywUpdate({ check: true, yes: true })
  expect(diagnostic.getCurrentInstallationType).not.toHaveBeenCalled()
  expect(updater.installUpdatePackage).not.toHaveBeenCalled()
  expect(updater.downloadUpdateForManualInstall).not.toHaveBeenCalled()
})

test('缺少校验信息时仍然拒绝安装', async () => {
  spyOn(updater, 'fetchUpdateRelease').mockResolvedValue({
    version: '1.4.0', packageFilename: pkg.filename, installablePackage: null,
  })
  await expect(ywUpdate({})).rejects.toThrow('无法安全安装')
  expect(updater.installUpdatePackage).not.toHaveBeenCalled()
})
