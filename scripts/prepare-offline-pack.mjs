#!/usr/bin/env node
/**
 * prepare-offline-pack.mjs
 *
 * 为离线 npm pack 做准备，具体步骤：
 *   1. 删除构建期 node_modules（体积庞大，构建完成后不再需要）
 *   2. 只安装 cli.mjs 运行时真正需要的 external 包
 *   3. 改写 package.json：让 dependencies 只列运行时包，
 *      bundledDependencies 覆盖精简 node_modules 中的所有包
 *
 * 原因：完整 node_modules 约 276 MB。Bun 打包后只有少数包仍以
 * external 方式存在，必须在运行时从 node_modules 加载。
 * 只打包这些包可将离线 tgz 从 300 MB 压缩到约 12 MB，
 * 同时保证内网离线环境可以完整安装使用。
 *
 * 支持跨平台运行（macOS/Linux/Windows），使用原生 Node + npm。
 */

import { execSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

// cli.mjs 在运行时真正需要的 external 包。
//
// PR-4（2025-04-11）之后，云服务商 SDK（@aws-sdk/*、google-auth-library）
// 已在 scripts/build.ts 中以桩模块替换，不再需要出现在 node_modules 里。
// 当前只需打包以下两类：
//
//   - sharp：原生图像处理库。JS 部分已 bundle 进 cli.mjs，但平台专属的
//     .node 二进制（@img/sharp-<平台>）无法 bundle，必须通过 npm 安装，
//     由 Node.js 在运行时通过 dlopen() 加载。
//   - @opentelemetry/*：7 个包在 src/ 中有静态 import，保持 external 是
//     因为它们的具名导出过多，不适合用桩模块替换。
//
// 如需恢复云服务商 SDK 支持：
//   1. 删除 scripts/build.ts 中的云服务商 SDK 桩模块代码块。
//   2. 将对应包重新加入下方 RUNTIME_DEPENDENCIES。
//   3. 重新跑 CI 即可。
const RUNTIME_DEPENDENCIES = {
  sharp: '^0.34.5',
  '@opentelemetry/api': '1.9.1',
  '@opentelemetry/api-logs': '0.214.0',
  '@opentelemetry/resources': '2.6.1',
  '@opentelemetry/sdk-logs': '0.214.0',
  '@opentelemetry/sdk-metrics': '2.6.1',
  '@opentelemetry/sdk-trace-base': '2.6.1',
  '@opentelemetry/semantic-conventions': '1.40.0',
}

const PROJECT_ROOT = process.cwd()
const PACK_TEMP_DIR = join(PROJECT_ROOT, '.pack-deps-temp')
const NODE_MODULES = join(PROJECT_ROOT, 'node_modules')
const PACKAGE_JSON = join(PROJECT_ROOT, 'package.json')

function log(msg) {
  console.log(`[prepare-offline-pack] ${msg}`)
}

function rmrf(path) {
  if (existsSync(path)) {
    rmSync(path, { recursive: true, force: true })
  }
}

// Step 1: remove the build-time node_modules
if (existsSync(NODE_MODULES)) {
  log('Removing build-time node_modules...')
  rmrf(NODE_MODULES)
}

// Step 2: install only the runtime externals in a temp directory
log('Installing runtime externals into temp directory...')
rmrf(PACK_TEMP_DIR)
mkdirSync(PACK_TEMP_DIR, { recursive: true })

const tempPackageJson = {
  name: 'pack-deps-temp',
  version: '1.0.0',
  private: true,
  dependencies: RUNTIME_DEPENDENCIES,
}
writeFileSync(
  join(PACK_TEMP_DIR, 'package.json'),
  JSON.stringify(tempPackageJson, null, 2),
)

// Use --omit=dev so npm only installs production deps. npm will auto-select
// the correct @img/sharp-* binary for the current platform via sharp's
// optionalDependencies (e.g. @img/sharp-win32-x64 on a Windows runner).
execSync('npm install --omit=dev --no-package-lock', {
  cwd: PACK_TEMP_DIR,
  stdio: 'inherit',
})

// Step 3: move the minimal node_modules into the project root
log('Moving minimal node_modules into project root...')
renameSync(join(PACK_TEMP_DIR, 'node_modules'), NODE_MODULES)
rmrf(PACK_TEMP_DIR)

// Step 4: rewrite package.json to match the minimal node_modules
// - `dependencies` is narrowed to the runtime externals only, so a consumer
//   `npm install -g the.tgz` won't try to re-resolve the full build-time tree.
// - `bundledDependencies` lists every top-level package under the minimal
//   node_modules so `npm pack` actually includes them in the tarball. (Without
//   bundledDependencies, npm ignores node_modules even if it's listed in
//   `files`.)
log('Scanning node_modules to build bundledDependencies list...')
const bundled = []
for (const entry of readdirSync(NODE_MODULES, { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name.startsWith('.')) continue
  if (entry.name.startsWith('@')) {
    const scopeDir = join(NODE_MODULES, entry.name)
    for (const sub of readdirSync(scopeDir, { withFileTypes: true })) {
      if (sub.isDirectory()) bundled.push(`${entry.name}/${sub.name}`)
    }
  } else {
    bundled.push(entry.name)
  }
}

const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8'))
pkg.dependencies = { ...RUNTIME_DEPENDENCIES }
pkg.bundledDependencies = bundled
writeFileSync(PACKAGE_JSON, JSON.stringify(pkg, null, 2))

log(`Runtime dependencies: ${Object.keys(pkg.dependencies).length}`)
log(`Bundled packages: ${bundled.length}`)
log('Ready for: npm pack --ignore-scripts')
