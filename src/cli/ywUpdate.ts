/** YwCoder 内网更新命令。 */
import { createInterface } from 'node:readline/promises'
import { getCurrentInstallationType } from '../utils/doctorDiagnostic.js'
import { downloadUpdateForManualInstall, fetchUpdateRelease, installUpdatePackage } from '../utils/ywUpdater.js'

declare const MACRO: { DISPLAY_VERSION?: string }

export async function ywUpdate(options: { check?: boolean; yes?: boolean }): Promise<void> {
  const current = MACRO.DISPLAY_VERSION
  if (!current) throw new Error('当前构建缺少可比较的版本号。')

  const release = await fetchUpdateRelease(current)
  if (!release) {
    console.log(`已是最新版（${current}）。`)
    return
  }
  console.log(`发现新版本：${current} → ${release.version}`)
  if (!release.packageFilename) {
    console.log('内网清单尚无适用于当前平台的安装包。')
    return
  }
  console.log(`安装包：${release.packageFilename}`)
  if (options.check) return
  if (!release.installablePackage) {
    throw new Error('清单缺少该平台 .tgz 安装包的 size 或 sha256，无法安全安装。')
  }
  if (await getCurrentInstallationType() !== 'npm-global') {
    const path = await downloadUpdateForManualInstall(release.installablePackage)
    console.log(`当前安装方式不支持自动替换。已校验安装包保留在：${path}`)
    console.log('请按原安装方式使用该包升级。')
    return
  }
  if (!options.yes) {
    if (!process.stdin.isTTY) throw new Error('非交互环境安装请显式指定 --yes。')
    const input = createInterface({ input: process.stdin, output: process.stdout })
    try {
      const answer = await input.question('下载并安装此版本？[y/N] ')
      if (!/^(y|yes)$/i.test(answer.trim())) {
        console.log('已取消更新。')
        return
      }
    } finally {
      input.close()
    }
  }
  await installUpdatePackage(release.installablePackage, release.version)
  console.log('安装完成。请重启 YwCoder，以加载新版本。')
}
