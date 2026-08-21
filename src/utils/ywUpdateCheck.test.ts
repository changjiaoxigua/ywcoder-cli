import assert from 'node:assert/strict'
import test from 'node:test'

import { mock } from 'bun:test'

import { isAutoUpdaterDisabled } from './config.ts'
import {
  CHECK_INTERVAL_MS,
  CHECK_TIMEOUT_MS,
  checkYwCoderUpdate,
  extractYwCoderEntry,
  getCachedUpdate,
  isNewerVersion,
  isValidVersion,
  isYwUpdateCheckDisabled,
  MANIFEST_MAX_BYTES,
  matchPlatformPackageFilename,
  onYwCoderUpdateAvailable,
  resetYwUpdateCheckForTest,
  shouldCheckNow,
  type CheckDeps,
  type YwUpdateCheckCache,
  type YwUpdateCheckStore,
  type YwUpdateInfo,
} from './ywUpdateCheck.ts'

// ---------------------------------------------------------------------------
// 公共夹具
// ---------------------------------------------------------------------------

const NOW = 1_800_000_000_000

/** 标准清单：ywcoder-cli 1.4.0，仅 Windows/Linux 包（对齐现网形态） */
const MANIFEST = [
  {
    id: 'other-tool',
    version: 'not-a-version', // 其他条目字段非法不影响本功能（§3.1）
    packages: 'garbage',
  },
  {
    id: 'ywcoder-cli',
    version: '1.4.0',
    packages: [
      {
        platform: 'Windows',
        filename: 'tools/YwCoder-Cli/ywcoder-1.4.0-win-x64.zip',
      },
      {
        platform: 'Linux',
        filename: 'tools/YwCoder-Cli/ywcoder-1.4.0-linux-x64.zip',
      },
    ],
  },
]

/** 内存版 globalConfig 缓存 */
function makeStore(initial?: YwUpdateCheckCache) {
  let cache = initial
  const writes: YwUpdateCheckCache[] = []
  const store: YwUpdateCheckStore = {
    read: () => cache,
    write: c => {
      cache = c
      writes.push(c)
    },
  }
  return { store, writes, current: () => cache }
}

/** 全注入的 checkYwCoderUpdate 依赖；httpGet 默认返回标准清单 */
function makeDeps(
  overrides: Partial<CheckDeps> = {},
): CheckDeps & { httpCalls: () => number } {
  let httpCalls = 0
  return {
    now: NOW,
    currentVersion: '1.3.0',
    platform: 'win32',
    isInteractive: () => true,
    isRemoteMode: () => false,
    isDisabled: () => false,
    resolveHub: () => ({
      hubRoot: 'http://h/yw-devhub/',
      source: 'userSettings',
    }),
    httpGet: async () => {
      httpCalls++
      return Buffer.from(JSON.stringify(MANIFEST))
    },
    ...overrides,
    httpCalls: () => httpCalls,
  }
}

// ---------------------------------------------------------------------------
// §7.1 条目提取
// ---------------------------------------------------------------------------

test('1a：顶层数组中找到 ywcoder-cli 条目', () => {
  const entry = extractYwCoderEntry(MANIFEST)
  assert.equal(entry?.version, '1.4.0')
})

test('1b：找不到条目 / 顶层不是数组 → null（静默）', () => {
  assert.equal(extractYwCoderEntry([{ id: 'other' }]), null)
  assert.equal(extractYwCoderEntry({ id: 'ywcoder-cli' }), null)
  assert.equal(extractYwCoderEntry('[]'), null)
  assert.equal(extractYwCoderEntry(null), null)
})

test('1c：重复条目取第一条；其他条目非法不影响', () => {
  const entry = extractYwCoderEntry([
    'garbage',
    null,
    { id: 'ywcoder-cli', version: '1.0.0' },
    { id: 'ywcoder-cli', version: '2.0.0' },
  ])
  assert.equal(entry?.version, '1.0.0')
})

// ---------------------------------------------------------------------------
// §7.2 version 校验
// ---------------------------------------------------------------------------

test('2：version 校验：release / dev 后缀合法；缺失 / 非法 / 超长拒绝', () => {
  assert.equal(isValidVersion('1.3.0'), true)
  assert.equal(isValidVersion('1.3.0-dev.94cbf90'), true)
  assert.equal(isValidVersion('0.0.1-rc.1'), true)

  assert.equal(isValidVersion(undefined), false)
  assert.equal(isValidVersion(123), false)
  assert.equal(isValidVersion(''), false)
  assert.equal(isValidVersion('1.1'), false) // 不完整形态（D5）
  assert.equal(isValidVersion('v1.2.3'), false)
  assert.equal(isValidVersion('1.2.3.4'), false)
  assert.equal(isValidVersion('1.2.3-'), false) // 空预发布后缀
  assert.equal(isValidVersion(`1.2.3-${'a'.repeat(58)}`), true) // 恰好 64 字符
  assert.equal(isValidVersion(`1.2.3-${'a'.repeat(59)}`), false) // 超长
})

// 审查 P2：改用严格 SemVer（npm semver.valid）后的边界形态
test('2b：严格 SemVer：前导零/空段拒绝；build metadata 接受', () => {
  assert.equal(isValidVersion('01.2.3'), false) // 主版本前导零
  assert.equal(isValidVersion('1.2.3-01'), false) // 数字预发布段前导零
  assert.equal(isValidVersion('1.2.3-a..b'), false) // 空预发布段
  assert.equal(isValidVersion('1.2.3-a.'), false) // 尾部空段
  assert.equal(isValidVersion('1.2.3+build.1'), true) // 合法 build metadata
  assert.equal(isValidVersion('1.2.3-rc.1+build.1'), true)
})

// ---------------------------------------------------------------------------
// §7.3 平台匹配
// ---------------------------------------------------------------------------

test('3a：win32→Windows / linux→Linux 取到对应包文件名（basename）', () => {
  const packages = MANIFEST[1].packages
  assert.equal(
    matchPlatformPackageFilename(packages, 'win32'),
    'ywcoder-1.4.0-win-x64.zip',
  )
  assert.equal(
    matchPlatformPackageFilename(packages, 'linux'),
    'ywcoder-1.4.0-linux-x64.zip',
  )
})

test('3b：darwin 在现网清单（无 macOS 包）下 → null（D11 静默跳过）', () => {
  assert.equal(matchPlatformPackageFilename(MANIFEST[1].packages, 'darwin'), null)
})

test('3c：精确匹配优先于「通用」；无精确时「通用」兜底；大小写不敏感', () => {
  const both = [
    { platform: '通用', filename: 'universal.zip' },
    { platform: 'windows', filename: 'win.zip' }, // 小写也应命中
  ]
  assert.equal(matchPlatformPackageFilename(both, 'win32'), 'win.zip')
  assert.equal(matchPlatformPackageFilename(both, 'darwin'), 'universal.zip')

  const universalOnly = [{ platform: '通用', filename: 'universal.zip' }]
  assert.equal(matchPlatformPackageFilename(universalOnly, 'linux'), 'universal.zip')
})

test('3d：平台命中但缺 filename / packages 非数组 → null', () => {
  assert.equal(
    matchPlatformPackageFilename([{ platform: 'Windows' }], 'win32'),
    null,
  )
  assert.equal(
    matchPlatformPackageFilename([{ platform: 'Windows', filename: '' }], 'win32'),
    null,
  )
  assert.equal(matchPlatformPackageFilename('garbage', 'win32'), null)
  assert.equal(matchPlatformPackageFilename(undefined, 'win32'), null)
})

// ---------------------------------------------------------------------------
// §7.4 版本比较
// ---------------------------------------------------------------------------

test('4：gt 语义：更高提醒；相等 / 更旧 / dev 落后同名 release / 非法静默', () => {
  assert.equal(isNewerVersion('1.3.1', '1.3.0'), true)
  assert.equal(isNewerVersion('1.3.0', '1.3.0'), false)
  assert.equal(isNewerVersion('1.2.9', '1.3.0'), false)
  // dev 构建按 semver 预发布规则落后于同名 release → 应提醒（D5）
  assert.equal(isNewerVersion('1.3.0', '1.3.0-dev.94cbf90'), true)
  assert.equal(isNewerVersion('1.3.0-dev.1', '1.3.0-dev.2'), false)

  assert.equal(isNewerVersion('garbage', '1.3.0'), false)
  assert.equal(isNewerVersion('1.3.1', undefined), false)
  assert.equal(isNewerVersion(undefined, undefined), false)
})

// 审查 P2：非法/边界输入下 isNewerVersion 永不抛出（Node 18 的 npm semver
// loose 比较对非法版本会抛 TypeError；静默 false 保证外层 markChecked 一定执行）
test('4b：isNewerVersion 对边界输入不抛异常，按「无更新」处理', () => {
  assert.doesNotThrow(() => isNewerVersion('1.2.3-a..b', '1.3.0'))
  assert.equal(isNewerVersion('1.2.3-a..b', '1.3.0'), false)
  assert.equal(isNewerVersion('1.3.1', '1.2.3-01'), false)
})

// ---------------------------------------------------------------------------
// §7.5 节流
// ---------------------------------------------------------------------------

test('5a：shouldCheckNow：无缓存 / lastCheckedAt 非法 → 检查；24h 内外分界', () => {
  assert.equal(shouldCheckNow(undefined, NOW), true)
  assert.equal(
    shouldCheckNow({} as YwUpdateCheckCache, NOW),
    true,
  )
  assert.equal(
    shouldCheckNow({ lastCheckedAt: NOW - CHECK_INTERVAL_MS + 1 }, NOW),
    false,
  )
  assert.equal(
    shouldCheckNow({ lastCheckedAt: NOW - CHECK_INTERVAL_MS }, NOW),
    true,
  )
})

test('5b：距上次检查 < 24h → 不发请求；≥ 24h → 发请求', async () => {
  // 真实缓存一定带 hubRoot（写入路径见 7a/8b）；不带 hubRoot 的缓存按换源作废（5d）
  const recent = makeStore({ lastCheckedAt: NOW - 1000, hubRoot: 'http://h/yw-devhub/' })
  const depsRecent = makeDeps({ store: recent.store })
  await checkYwCoderUpdate(depsRecent)
  assert.equal(depsRecent.httpCalls(), 0)
  assert.equal(recent.writes.length, 0) // 节流命中时连写都不发生

  const stale = makeStore({
    lastCheckedAt: NOW - CHECK_INTERVAL_MS,
    hubRoot: 'http://h/yw-devhub/',
  })
  const depsStale = makeDeps({ store: stale.store })
  await checkYwCoderUpdate(depsStale)
  assert.equal(depsStale.httpCalls(), 1)
})

test('5c：拉取失败同样写 lastCheckedAt：24h 内不重试（§4.1）', async () => {
  const { store, writes } = makeStore()
  let calls = 0
  const deps = makeDeps({
    store,
    httpGet: async () => {
      calls++
      throw new Error('connect timeout')
    },
  })
  await checkYwCoderUpdate(deps)
  assert.equal(calls, 1)
  assert.deepEqual(writes, [
    { lastCheckedAt: NOW, hubRoot: 'http://h/yw-devhub/' },
  ])

  // 紧接着的第二次启动：节流命中，不再请求
  await checkYwCoderUpdate(deps)
  assert.equal(calls, 1)
})

// 审查 P1：hubRoot 不一致 = 换源，旧源的节流时间不继承（否则新 hub 最长
// 23h 不被检查）
test('5d：hub 切换后旧节流时间作废：旧缓存 1h 内但 hubRoot 不同 → 立即发请求', async () => {
  const { store } = makeStore({
    lastCheckedAt: NOW - 3_600_000, // 旧源 1 小时前刚检查过
    hubRoot: 'http://old-hub/yw-devhub/',
  })
  const deps = makeDeps({ store })
  await checkYwCoderUpdate(deps)
  assert.equal(deps.httpCalls(), 1)
})

// ---------------------------------------------------------------------------
// §7.6 禁用判定（D8）
// ---------------------------------------------------------------------------

/** 隔离三类相关环境变量执行 fn，结束后恢复 */
function withCleanEnv(fn: () => void) {
  const keys = [
    'DISABLE_AUTOUPDATER',
    'YWCODER_DISABLE_NONESSENTIAL_TRAFFIC',
    'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  ]
  const saved = keys.map(k => [k, process.env[k]] as const)
  for (const k of keys) delete process.env[k]
  try {
    fn()
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

test('6a：DISABLE_AUTOUPDATER / essential-traffic env / autoUpdates:false 各自生效', () => {
  withCleanEnv(() => {
    assert.equal(isYwUpdateCheckDisabled(() => ({})), false)

    process.env.DISABLE_AUTOUPDATER = '1'
    assert.equal(isYwUpdateCheckDisabled(() => ({})), true)
    delete process.env.DISABLE_AUTOUPDATER

    process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
    assert.equal(isYwUpdateCheckDisabled(() => ({})), true)
    delete process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC

    assert.equal(
      isYwUpdateCheckDisabled(() => ({ autoUpdates: false })),
      true,
    )
  })
})

test('6b：回归断言——严禁复用 isAutoUpdaterDisabled()（ywcoder build 恒 true）', () => {
  withCleanEnv(() => {
    // ywcoder build 中 isAutoUpdaterDisabled 无条件为 true（config.ts:1800 的
    // { type: 'ywcoder' } 兜底）；若 D8 复用它，本功能永不执行
    assert.equal(isAutoUpdaterDisabled(), true)
    // 自定义判定在同一环境下必须为 false——功能可用
    assert.equal(isYwUpdateCheckDisabled(() => ({})), false)
  })
})

test('6c：跳过条件链：非交互 / remote / 禁用 / 未配置 hub → 均不发请求', async () => {
  const cases: Array<[string, Partial<CheckDeps>]> = [
    ['非交互', { isInteractive: () => false }],
    ['remote mode', { isRemoteMode: () => true }],
    ['用户禁用', { isDisabled: () => true }],
    ['未配置 hub', { resolveHub: () => null }],
  ]
  for (const [name, override] of cases) {
    const { store, writes } = makeStore()
    const deps = makeDeps({ store, ...override })
    await checkYwCoderUpdate(deps)
    assert.equal(deps.httpCalls(), 0, `${name} 不应发请求`)
    assert.equal(writes.length, 0, `${name} 不应写缓存`)
  }
})

// ---------------------------------------------------------------------------
// §7.7 缓存读写
// ---------------------------------------------------------------------------

test('7a：有更新 → 写 hubRoot + latestVersion + packageFilename，并触发回调', async () => {
  resetYwUpdateCheckForTest()
  const received: YwUpdateInfo[] = []
  const off = onYwCoderUpdateAvailable(info => received.push(info))
  try {
    const { store, current } = makeStore()
    await checkYwCoderUpdate(makeDeps({ store }))
    assert.deepEqual(current(), {
      lastCheckedAt: NOW,
      hubRoot: 'http://h/yw-devhub/',
      latestVersion: '1.4.0',
      packageFilename: 'ywcoder-1.4.0-win-x64.zip',
    })
    assert.deepEqual(received, [
      { latestVersion: '1.4.0', packageFilename: 'ywcoder-1.4.0-win-x64.zip' },
    ])
  } finally {
    off()
    resetYwUpdateCheckForTest()
  }
})

test('7b：无更新（清单版本更旧）→ 清掉 latest 缓存，不触发回调', async () => {
  resetYwUpdateCheckForTest()
  const received: YwUpdateInfo[] = []
  const off = onYwCoderUpdateAvailable(info => received.push(info))
  try {
    const { store, current } = makeStore({
      lastCheckedAt: 0,
      hubRoot: 'http://h/yw-devhub/',
      latestVersion: '1.4.0',
      packageFilename: 'old.zip',
    })
    await checkYwCoderUpdate(
      makeDeps({ store, currentVersion: '9.9.9' }), // 本地已高于清单
    )
    assert.deepEqual(current(), {
      lastCheckedAt: NOW,
      hubRoot: 'http://h/yw-devhub/',
    })
    assert.equal(received.length, 0)
  } finally {
    off()
    resetYwUpdateCheckForTest()
  }
})

test('7c：本机平台无包（darwin + 现网清单）→ 不缓存 latestVersion、不回调（D11）', async () => {
  resetYwUpdateCheckForTest()
  const received: YwUpdateInfo[] = []
  const off = onYwCoderUpdateAvailable(info => received.push(info))
  try {
    const { store, current } = makeStore()
    await checkYwCoderUpdate(makeDeps({ store, platform: 'darwin' }))
    assert.deepEqual(current(), {
      lastCheckedAt: NOW,
      hubRoot: 'http://h/yw-devhub/',
    })
    assert.equal(received.length, 0)
  } finally {
    off()
    resetYwUpdateCheckForTest()
  }
})

test('7d：失败只写 lastCheckedAt，保留既有 latest 缓存', async () => {
  const { store, current } = makeStore({
    lastCheckedAt: 0,
    hubRoot: 'http://h/yw-devhub/',
    latestVersion: '1.4.0',
    packageFilename: 'old.zip',
  })
  await checkYwCoderUpdate(
    makeDeps({
      store,
      httpGet: async () => {
        throw new Error('boom')
      },
    }),
  )
  assert.deepEqual(current(), {
    lastCheckedAt: NOW,
    hubRoot: 'http://h/yw-devhub/',
    latestVersion: '1.4.0',
    packageFilename: 'old.zip',
  })
})

test('7e：getCachedUpdate：hubRoot 不一致整条作废；缓存版本不高于当前不提醒', () => {
  const { store } = makeStore({
    lastCheckedAt: NOW,
    hubRoot: 'http://h/yw-devhub/',
    latestVersion: '1.4.0',
    packageFilename: 'win.zip',
  })
  // 用户改了 ywdevhubUrl → 旧 hub 的缓存立即失效（防串源）
  assert.equal(getCachedUpdate('http://other/hub/', '1.3.0', store), null)
  // 用户已升级到 1.4.0 → 不再提醒
  assert.equal(getCachedUpdate('http://h/yw-devhub/', '1.4.0', store), null)
  // 正常命中
  assert.deepEqual(getCachedUpdate('http://h/yw-devhub/', '1.3.0', store), {
    latestVersion: '1.4.0',
    packageFilename: 'win.zip',
  })
})

// 审查 P1：换源后请求失败，写入结果不得继承旧源的 latestVersion/packageFilename
// （否则下次 REPL 启动会把旧源的更新结果挂到新源名下展示）
test('7f：hub 切换 + 请求失败 → 只写新源 lastCheckedAt/hubRoot，不带旧源更新信息', async () => {
  const { store, current, writes } = makeStore({
    lastCheckedAt: NOW - 48 * 3_600_000, // 已过期
    hubRoot: 'http://old-hub/yw-devhub/',
    latestVersion: '9.9.9',
    packageFilename: 'old-hub-package.zip',
  })
  await checkYwCoderUpdate(
    makeDeps({
      store,
      httpGet: async () => {
        throw new Error('connect timeout')
      },
    }),
  )
  assert.deepEqual(current(), { lastCheckedAt: NOW, hubRoot: 'http://h/yw-devhub/' })
  assert.equal(writes.length, 1)
})

// ---------------------------------------------------------------------------
// §7.8 传输参数与失败静默
// ---------------------------------------------------------------------------

test('8a：请求 tools.json 使用 1.5s 超时与 64KB 上限，地址由 hubRoot 派生', async () => {
  const seen: { url?: string; opts?: { timeout: number; maxContentLength: number } } = {}
  const { store } = makeStore()
  await checkYwCoderUpdate(
    makeDeps({
      store,
      httpGet: async (url, opts) => {
        seen.url = url
        seen.opts = opts
        return Buffer.from(JSON.stringify(MANIFEST))
      },
    }),
  )
  assert.equal(seen.url, 'http://h/yw-devhub/tools.json')
  assert.equal(seen.opts?.timeout, CHECK_TIMEOUT_MS)
  assert.equal(seen.opts?.maxContentLength, MANIFEST_MAX_BYTES)
})

test('8b：302（不跟随重定向）/ 超限 / 非法 JSON → 静默，不写 latest，失败也节流', async () => {
  const failures = [
    new Error('Max redirects exceeded'),
    new Error('maxContentLength size of 65536 exceeded'),
  ]
  for (const failure of failures) {
    const { store, current } = makeStore()
    await checkYwCoderUpdate(
      makeDeps({
        store,
        httpGet: async () => {
          throw failure
        },
      }),
    )
    assert.deepEqual(current(), {
      lastCheckedAt: NOW,
      hubRoot: 'http://h/yw-devhub/',
    })
  }

  // 非法 JSON
  const { store, current } = makeStore()
  await checkYwCoderUpdate(
    makeDeps({ store, httpGet: async () => Buffer.from('<html>404</html>') }),
  )
  assert.deepEqual(current(), {
    lastCheckedAt: NOW,
    hubRoot: 'http://h/yw-devhub/',
  })
})

// 8b 只验证了「注入的 httpGet 抛错被静默」，未触达默认传输实现——删掉
// maxRedirects:0 或改掉 responseType 它照样通过。本测试直接 mock axios，
// 钉死 defaultHttpGet 的传输参数（审查反馈：必须验证默认实现而非注入替身）。
test('8c：默认传输实现（axios）固定 arraybuffer / maxRedirects:0 / 限时限量', async () => {
  const seen: { url?: string; config?: Record<string, unknown> } = {}
  mock.module('axios', () => ({
    default: {
      get: async (url: string, config: Record<string, unknown>) => {
        seen.url = url
        seen.config = config
        return { data: new TextEncoder().encode(JSON.stringify(MANIFEST)).buffer }
      },
    },
  }))
  try {
    // 查询串强制新鲜导入，让被测模块拿到上面 mock 的 axios（fastMode.test.ts 同款手法）
    const fresh = await import(`./ywUpdateCheck.ts?ts=${Date.now()}-${Math.random()}`)
    const { store, current } = makeStore()
    const deps = makeDeps({ store })
    delete deps.httpGet // 关键：不注入 httpGet，走默认 defaultHttpGet → axios
    await fresh.checkYwCoderUpdate(deps)

    assert.equal(seen.url, 'http://h/yw-devhub/tools.json')
    assert.equal(seen.config?.responseType, 'arraybuffer')
    assert.equal(seen.config?.maxRedirects, 0)
    assert.equal(seen.config?.timeout, CHECK_TIMEOUT_MS)
    assert.equal(seen.config?.maxContentLength, MANIFEST_MAX_BYTES)
    // 端到端走通：默认传输的返回被正确消费（缓存写入 latest 版本）
    assert.equal(current()?.latestVersion, '1.4.0')
  } finally {
    mock.restore()
  }
})

// ---------------------------------------------------------------------------
// §7.9 回调（pending 模式）
// ---------------------------------------------------------------------------
test('9：回调注册前已产出结果 → 注册即补发；重复注册不重复补发', async () => {
  resetYwUpdateCheckForTest()
  // 不注册回调直接检查 → 结果进入 pending
  const { store } = makeStore()
  await checkYwCoderUpdate(makeDeps({ store }))

  const received: YwUpdateInfo[] = []
  const off = onYwCoderUpdateAvailable(info => received.push(info))
  assert.equal(received.length, 1) // 注册瞬间补发
  assert.equal(received[0].latestVersion, '1.4.0')
  off()

  // pending 已被消费，再次注册不再补发
  const again: YwUpdateInfo[] = []
  const off2 = onYwCoderUpdateAvailable(info => again.push(info))
  assert.equal(again.length, 0)
  off2()
  resetYwUpdateCheckForTest()
})

// ---------------------------------------------------------------------------
// §7.10 现网 tools.json 快照（回归 fixture）
// ---------------------------------------------------------------------------

// yw-devhub/tools.json @2026-08-14 快照（外仓文件，内联保持测试自包含）
const REAL_WORLD_MANIFEST = [
  {
    id: 'ywcoder-cli',
    name: 'YwCoder CLI',
    description: 'YwCoder 命令行工具，支持智能对话、Skills 调用、内网模型网关等特性',
    version: '1.1.0',
    updatedAt: '2026-05-14',
    tags: ['CLI', '命令行'],
    contact: 'xxx',
    releaseNotes: 'tools/YwCoder-Cli/README.md',
    packages: [
      {
        platform: 'Windows',
        filename: 'tools/YwCoder-Cli/ywcoder-1.1.0-dev.94cbf90-win-x64.zip',
      },
      {
        platform: 'Linux',
        filename: 'tools/YwCoder-Cli/ywcoder-1.1.0-dev.94cbf90-linux-x64.zip',
      },
    ],
  },
  {
    id: 'everything-claude-code-zh-internal',
    version: '1.7.0',
    packages: [
      {
        platform: '通用',
        filename:
          'tools/everything-claude-code-zh-internal/everything-claude-code-zh-internal.zip',
      },
    ],
  },
]

test('10：现网 tools.json 快照：正确提取条目；1.1.0 低于当前版本 → 静默（A2 稳态）', async () => {
  const entry = extractYwCoderEntry(REAL_WORLD_MANIFEST)
  assert.equal(entry?.version, '1.1.0')

  resetYwUpdateCheckForTest()
  const received: YwUpdateInfo[] = []
  const off = onYwCoderUpdateAvailable(info => received.push(info))
  try {
    const { store, current } = makeStore()
    await checkYwCoderUpdate(
      makeDeps({
        store,
        currentVersion: '1.3.0',
        httpGet: async () => Buffer.from(JSON.stringify(REAL_WORLD_MANIFEST)),
      }),
    )
    // 现网稳态：清单落后于客户端 → 不提醒、清 latest
    assert.equal(received.length, 0)
    assert.deepEqual(current(), {
      lastCheckedAt: NOW,
      hubRoot: 'http://h/yw-devhub/',
    })
  } finally {
    off()
    resetYwUpdateCheckForTest()
  }
})

test('10b：现网清单拔高版本后：win32 提醒、darwin 静默（A3 / A9 链路预演）', async () => {
  const bumped = [
    { ...REAL_WORLD_MANIFEST[0], version: '9.9.9' },
    ...REAL_WORLD_MANIFEST.slice(1),
  ]

  resetYwUpdateCheckForTest()
  const received: YwUpdateInfo[] = []
  const off = onYwCoderUpdateAvailable(info => received.push(info))
  try {
    const winStore = makeStore()
    await checkYwCoderUpdate(
      makeDeps({
        store: winStore.store,
        httpGet: async () => Buffer.from(JSON.stringify(bumped)),
      }),
    )
    assert.deepEqual(received, [
      {
        latestVersion: '9.9.9',
        packageFilename: 'ywcoder-1.1.0-dev.94cbf90-win-x64.zip',
      },
    ])

    received.length = 0
    const macStore = makeStore()
    await checkYwCoderUpdate(
      makeDeps({
        store: macStore.store,
        platform: 'darwin',
        httpGet: async () => Buffer.from(JSON.stringify(bumped)),
      }),
    )
    assert.equal(received.length, 0) // 现网无 macOS 包 → 不提醒
  } finally {
    off()
    resetYwUpdateCheckForTest()
  }
})
