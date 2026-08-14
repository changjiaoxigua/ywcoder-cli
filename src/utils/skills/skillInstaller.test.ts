import assert from 'node:assert/strict'
import test from 'node:test'

import type { SettingsJson } from '../settings/types.ts'
import {
  assertUrlAllowed,
  deriveManifestUrl,
  deriveZipUrl,
  fetchManifest,
  MANIFEST_MAX_BYTES,
  MANIFEST_TIMEOUT_MS,
  normalizeHubRoot,
  parseManifest,
  resolveHubConfig,
  urlForLog,
} from './skillInstaller.ts'

// ---------------------------------------------------------------------------
// §13.6-36/37：配置读取
// ---------------------------------------------------------------------------

function readerWith(
  values: Partial<Record<'policySettings' | 'userSettings', string>>,
  seen?: string[],
) {
  return (source: 'policySettings' | 'userSettings'): SettingsJson | null => {
    seen?.push(source)
    const url = values[source]
    return url ? ({ ywdevhubUrl: url } as SettingsJson) : null
  }
}

test('36：只读 policySettings / userSettings，接口上不存在 project/local 入参', () => {
  // resolveHubConfig 的 SettingsReader 类型只接受这两个 source，
  // 编译期即排除 projectSettings / localSettings。运行时行为：两者都没配 → null
  const seen: string[] = []
  const result = resolveHubConfig(readerWith({}, seen))
  assert.equal(result, null)
  assert.deepEqual(seen, ['policySettings', 'userSettings'])
})

test('37：优先级 policy > user；user 单独配置可用', () => {
  const both = resolveHubConfig(
    readerWith({
      policySettings: 'http://policy.example/hub/',
      userSettings: 'http://user.example/hub/',
    }),
  )
  assert.equal(both?.hubRoot, 'http://policy.example/hub/')
  assert.equal(both?.source, 'policySettings')

  const userOnly = resolveHubConfig(
    readerWith({ userSettings: 'http://user.example/hub/' }),
  )
  assert.equal(userOnly?.hubRoot, 'http://user.example/hub/')
  assert.equal(userOnly?.source, 'userSettings')
})

// ---------------------------------------------------------------------------
// §13.6-39：地址派生与尾斜杠归一化
// ---------------------------------------------------------------------------

test('39：hubRoot 有 / 无尾斜杠两种输入，派生结果一致', () => {
  for (const raw of [
    'http://10.0.0.1/yw-devhub/',
    'http://10.0.0.1/yw-devhub',
  ]) {
    const hubRoot = normalizeHubRoot(raw)
    assert.equal(hubRoot, 'http://10.0.0.1/yw-devhub/')
    assert.equal(
      deriveManifestUrl(hubRoot),
      'http://10.0.0.1/yw-devhub/skills.json',
    )
    assert.equal(
      deriveZipUrl(hubRoot, { filename: 'architecture-diagram.zip' }),
      'http://10.0.0.1/yw-devhub/skills/architecture-diagram.zip',
    )
  }
  // 裸 host 也允许
  assert.equal(
    deriveManifestUrl(normalizeHubRoot('http://10.0.0.1')),
    'http://10.0.0.1/skills.json',
  )
})

test('40：条目提供 downloadUrl → 覆盖拼接结果', () => {
  const url = deriveZipUrl('http://10.0.0.1/yw-devhub/', {
    filename: 'a.zip',
    downloadUrl: 'http://other.example/files/a.zip',
  })
  assert.equal(url, 'http://other.example/files/a.zip')
})

// ---------------------------------------------------------------------------
// §13.6-44/45：协议与 userinfo 校验
// ---------------------------------------------------------------------------

test('44：file:// / data: 等非法协议 → 拒绝', () => {
  assert.throws(
    () => normalizeHubRoot('file:///etc/passwd'),
    /只允许 http\/https/,
  )
  assert.throws(() => normalizeHubRoot('data:text/plain,hi'), /只允许/)
  assert.throws(
    () =>
      deriveZipUrl('http://h/', {
        downloadUrl: 'file:///etc/passwd',
      }),
    /只允许/,
  )
})

test('45：URL 携带 userinfo → 拒绝', () => {
  assert.throws(
    () => normalizeHubRoot('https://user:pass@host/hub/'),
    /userinfo/,
  )
  assert.throws(
    () =>
      deriveZipUrl('http://h/', { downloadUrl: 'http://u:p@host/a.zip' }),
    /userinfo/,
  )
})

test('urlForLog 只保留 origin + pathname', () => {
  assert.equal(
    urlForLog('http://h:8080/a/b.json?token=secret#frag'),
    'http://h:8080/a/b.json',
  )
})

// ---------------------------------------------------------------------------
// §13.6-38/41/47：清单解析
// ---------------------------------------------------------------------------

test('38：现网 skills.json 形状（顶层数组，无 sha256/downloadUrl）正常解析', () => {
  const realWorld = [
    {
      id: 'architecture-diagram',
      name: 'Architecture Diagram Generator',
      description: '根据文字描述生成系统架构图，输出为独立的 HTML+SVG 文件',
      tags: ['架构设计', '可视化', '文档'],
      version: '1.1',
      updatedAt: '2026-05-15',
      filename: 'architecture-diagram.zip',
      contact: 'xxx',
      source: 'https://github.com/Cocoon-AI/architecture-diagram-generator',
    },
    {
      id: 'docx-skill',
      version: '1.0',
      filename: 'docx-skill.zip',
    },
  ]
  const { entries, warnings } = parseManifest(realWorld)
  assert.equal(entries.length, 2)
  assert.equal(entries[0].id, 'architecture-diagram')
  assert.equal(entries[0].viewOnlyReason, null)
  assert.equal(entries[0].sha256, undefined)
  assert.deepEqual(warnings, [])
})

test('41：清单重复 id → 保留第一条并警告', () => {
  const { entries, warnings } = parseManifest([
    { id: 'a', version: '1.0', filename: 'a1.zip' },
    { id: 'a', version: '2.0', filename: 'a2.zip' },
  ])
  assert.equal(entries.length, 1)
  assert.equal(entries[0].version, '1.0')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /重复 id：a/)
})

test('47：字段非法条目标记仅查看，不阻断其余条目', () => {
  const { entries } = parseManifest([
    { id: '../evil', version: '1.0', filename: 'x.zip' }, // id 非法
    { id: 'no-version', filename: 'x.zip' }, // 缺 version
    { id: 'no-file', version: '1.0' }, // 缺 filename 且缺 downloadUrl
    { id: 'bad-sha', version: '1.0', filename: 'x.zip', sha256: 'zzz' },
    { id: 'bad-url', version: '1.0', downloadUrl: 'file:///etc/passwd' },
    { id: 'good', version: '1.0', filename: 'good.zip' },
  ])
  assert.equal(entries.length, 6)
  const byId = Object.fromEntries(entries.map(e => [e.id, e.viewOnlyReason]))
  assert.match(byId['../evil'] ?? '', /id 非法/)
  assert.match(byId['no-version'] ?? '', /version/)
  assert.match(byId['no-file'] ?? '', /无法拼出下载地址/)
  assert.match(byId['bad-sha'] ?? '', /sha256/)
  assert.match(byId['bad-url'] ?? '', /只允许/)
  assert.equal(byId['good'], null)
})

test('清单顶层非数组 → 报错', () => {
  assert.throws(() => parseManifest({ foo: 1 }), /顶层必须是数组/)
})

test('条目数超过 500 → 截断并警告', () => {
  const big = Array.from({ length: 501 }, (_, i) => ({
    id: `skill-${i}`,
    version: '1.0',
    filename: 'x.zip',
  }))
  const { entries, warnings } = parseManifest(big)
  assert.equal(entries.length, 500)
  assert.match(warnings[0], /超过上限 500/)
})

// ---------------------------------------------------------------------------
// fetchManifest：超时/体积参数透传、302 报错、非法 JSON
// ---------------------------------------------------------------------------

test('fetchManifest 使用 5s 超时与 2MB 上限，地址为派生的 skills.json', async () => {
  // 用对象属性持有闭包赋值结果：let 捕获会被 TS 流分析定死为初始值 null
  const seen: {
    url?: string
    opts?: { timeout: number; maxContentLength: number }
  } = {}
  const { entries, manifestUrl } = await fetchManifest(
    'http://10.0.0.1/yw-devhub',
    async (url, opts) => {
      seen.url = url
      seen.opts = opts
      return Buffer.from(JSON.stringify([{ id: 'a', version: '1', filename: 'a.zip' }]))
    },
  )
  assert.equal(seen.url, 'http://10.0.0.1/yw-devhub/skills.json')
  assert.equal(manifestUrl, 'http://10.0.0.1/yw-devhub/skills.json')
  assert.equal(seen.opts?.timeout, MANIFEST_TIMEOUT_MS)
  assert.equal(seen.opts?.maxContentLength, MANIFEST_MAX_BYTES)
  assert.equal(entries.length, 1)
})

test('42：清单超过 2 MB → httpGet 抛错被包装为拉取失败，且不泄露 query', async () => {
  await assert.rejects(
    fetchManifest('http://h/hub/', async () => {
      throw new Error('maxContentLength size of 2097152 exceeded')
    }),
    /拉取清单失败（http:\/\/h\/hub\/skills\.json）：maxContentLength/,
  )
})

test('46：下载返回 302（不跟随重定向）→ 报错', async () => {
  await assert.rejects(
    fetchManifest('http://h/hub/', async () => {
      throw new Error('Max redirects exceeded')
    }),
    /拉取清单失败/,
  )
})

test('清单返回非法 JSON → 报错且不泄露 query', async () => {
  await assert.rejects(
    fetchManifest('http://h/hub/?token=x', async () =>
      Buffer.from('<html>404</html>'),
    ),
    /清单不是合法 JSON（http:\/\/h\/hub\/skills\.json）/,
  )
})

// ---------------------------------------------------------------------------
// §13.2 安装核心：结构判定 / sha256 / 路径穿越回归 / 可执行位
// ---------------------------------------------------------------------------

import { strToU8, zipSync } from 'fflate'

import {
  downloadZip,
  extractSkillFiles,
  sha256Hex,
  verifyZipSha256,
  ZIP_MAX_BYTES,
  ZIP_TIMEOUT_MS,
} from './skillInstaller.ts'

/** 便捷构造 zip：entries 为 路径 → 内容 或 [内容, attrs] */
function makeZip(
  entries: Record<string, string | [string, number]>,
): Buffer {
  const input: Record<string, [Uint8Array, { attrs?: number; os?: number }]> = {}
  for (const [path, value] of Object.entries(entries)) {
    if (typeof value === 'string') {
      input[path] = [strToU8(value), {}]
    } else {
      input[path] = [strToU8(value[0]), { attrs: value[1] << 16, os: 3 }]
    }
  }
  return Buffer.from(zipSync(input))
}

test('7：规则 1（根即 SKILL.md）→ 整包原样', async () => {
  const zip = makeZip({
    'SKILL.md': '# docx',
    'scripts/convert.sh': '#!/bin/sh',
    'scripts/lib/util.py': 'pass',
  })
  const { files } = await extractSkillFiles(zip)
  assert.deepEqual(Object.keys(files).sort(), [
    'SKILL.md',
    'scripts/convert.sh',
    'scripts/lib/util.py',
  ])
})

test('8：规则 2（单顶层目录）→ 剥层', async () => {
  const zip = makeZip({
    'architecture-diagram/SKILL.md': '# arch',
    'architecture-diagram/assets/logo.svg': '<svg/>',
  })
  const { files } = await extractSkillFiles(zip)
  assert.deepEqual(Object.keys(files).sort(), ['SKILL.md', 'assets/logo.svg'])
})

test('9：规则 3（根无 SKILL.md 且顶层多目录）→ 报错并列出顶层条目', async () => {
  const zip = makeZip({ 'a/SKILL.md': '1', 'b/SKILL.md': '2' })
  await assert.rejects(extractSkillFiles(zip), /无法识别.*a, b/s)
})

test('10：多 skill 包（根 SKILL.md + 子目录 SKILL.md）→ 规则 1 原样保留结构', async () => {
  const zip = makeZip({
    'SKILL.md': '# understand-anything',
    'understand-chat/SKILL.md': '# chat',
    'understand-diff/SKILL.md': '# diff',
  })
  const { files } = await extractSkillFiles(zip)
  // 命名空间生成是加载器的职责（loadSkillsDir.ts），此处只保证结构完整
  assert.deepEqual(Object.keys(files).sort(), [
    'SKILL.md',
    'understand-chat/SKILL.md',
    'understand-diff/SKILL.md',
  ])
})

test('11：sha256 不匹配 → 报错；匹配 → 通过', () => {
  const zip = makeZip({ 'SKILL.md': 'x' })
  assert.throws(
    () => verifyZipSha256(zip, '0'.repeat(64)),
    /sha256 校验失败/,
  )
  assert.equal(verifyZipSha256(zip, sha256Hex(zip)), true)
})

test('12：sha256 缺失 → 返回 false（未校验），不报错', () => {
  const zip = makeZip({ 'SKILL.md': 'x' })
  assert.equal(verifyZipSha256(zip, undefined), false)
})

test('13：zip 内含 ../ 条目 → 被 unzipFile 拒绝（回归）', async () => {
  const zip = makeZip({ 'SKILL.md': 'x', '../evil.sh': 'rm -rf' })
  await assert.rejects(extractSkillFiles(zip))
})

test('14：可执行位：zip 内 +x 文件解压后 modes 保留 +x', async () => {
  const zip = makeZip({
    'SKILL.md': 'x',
    'run.sh': ['#!/bin/sh', 0o100755],
    'note.txt': ['plain', 0o100644],
  })
  const { modes } = await extractSkillFiles(zip)
  assert.ok(modes['run.sh'] & 0o111, 'run.sh 应带可执行位')
  assert.equal((modes['note.txt'] ?? 0) & 0o111, 0)
})

// ---------------------------------------------------------------------------
// §13.6-43：zip 下载体积与超时参数
// ---------------------------------------------------------------------------

test('43：下载 zip 使用 60s 超时与 64MB 上限；超限错误被包装且不泄露 query', async () => {
  const seen: { opts?: { timeout: number; maxContentLength: number } } = {}
  const buf = await downloadZip('http://h/hub/skills/a.zip', async (url, opts) => {
    seen.opts = opts
    return Buffer.from('zip-bytes')
  })
  assert.equal(buf.toString(), 'zip-bytes')
  assert.equal(seen.opts?.timeout, ZIP_TIMEOUT_MS)
  assert.equal(seen.opts?.maxContentLength, ZIP_MAX_BYTES)

  await assert.rejects(
    downloadZip('http://h/hub/skills/a.zip?token=secret', async () => {
      throw new Error('maxContentLength size exceeded')
    }),
    /下载 zip 失败（http:\/\/h\/hub\/skills\/a\.zip）：maxContentLength/,
  )
})

test('downloadZip 对最终地址做协议与 userinfo 校验', async () => {
  await assert.rejects(downloadZip('file:///etc/passwd'), /只允许/)
  await assert.rejects(downloadZip('http://u:p@h/a.zip'), /userinfo/)
})

// ---------------------------------------------------------------------------
// §13.3 原子性与恢复 + sidecar 读写
// ---------------------------------------------------------------------------

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  atomicSwitch,
  buildSidecar,
  readSidecar,
  recoverStaging,
  stageSkill,
  stagingRootFor,
  SIDECAR_FILENAME,
} from './skillInstaller.ts'

/** 搭一个临时目录布局：root/skills/<id>（可选旧版本）与 root/skills-staging/ */
function makeSandbox(withOld?: { version: string }) {
  const root = mkdtempSync(join(tmpdir(), 'skill-install-test-'))
  const skillsRoot = join(root, 'skills')
  const stagingRoot = join(root, 'skills-staging')
  const target = join(skillsRoot, 'my-skill')
  if (withOld) {
    mkdirSync(join(target), { recursive: true })
    writeFileSync(join(target, 'SKILL.md'), `old ${withOld.version}`)
    writeFileSync(
      join(target, SIDECAR_FILENAME),
      JSON.stringify(
        buildSidecar({
          id: 'my-skill',
          version: withOld.version,
          hubUrl: 'http://h/yw-devhub/',
          downloadUrl: 'http://h/yw-devhub/skills/my-skill.zip',
        }),
      ),
    )
  }
  return {
    root,
    skillsRoot,
    stagingRoot,
    target,
    [Symbol.dispose]() {
      rmSync(root, { recursive: true, force: true })
    },
  }
}

function sampleSidecar(version = '1.1') {
  return buildSidecar({
    id: 'my-skill',
    version,
    hubUrl: 'http://h/yw-devhub/',
    downloadUrl: 'http://h/yw-devhub/skills/my-skill.zip',
    sha256: 'a'.repeat(64),
  })
}

async function stageNewVersion(sandbox: ReturnType<typeof makeSandbox>) {
  const zip = makeZip({ 'SKILL.md': 'new 1.1', 'run.sh': ['#!/bin/sh', 0o100755] })
  const extracted = await extractSkillFiles(zip)
  return stageSkill({
    stagingRoot: sandbox.stagingRoot,
    id: 'my-skill',
    extracted,
    sidecar: sampleSidecar(),
  })
}

test('staging 根是 skills 根的兄弟目录', () => {
  assert.equal(
    stagingRootFor('/home/u/.ywcoder/skills'),
    '/home/u/.ywcoder/skills-staging',
  )
})

test('stageSkill 写入文件、恢复 +x、写 sidecar', async () => {
  using sb = makeSandbox()
  const newDir = await stageNewVersion(sb)
  assert.equal(readFileSync(join(newDir, 'SKILL.md'), 'utf8'), 'new 1.1')
  const sidecar = await readSidecar(newDir, 'my-skill')
  assert.equal(sidecar.kind, 'valid')
})

test('15：staging 写入阶段失败 → 下次运行清理后旧版本完全不变', async () => {
  using sb = makeSandbox({ version: '1.0' })
  const before = readFileSync(join(sb.target, 'SKILL.md'), 'utf8')
  await stageNewVersion(sb) // 模拟死在写入阶段：.new 残留，未切换
  await recoverStaging({
    stagingRoot: sb.stagingRoot,
    id: 'my-skill',
    target: sb.target,
  })
  assert.equal(readFileSync(join(sb.target, 'SKILL.md'), 'utf8'), before)
  assert.ok(!existsSync(join(sb.stagingRoot, 'my-skill.new')))
  // sidecar 也未被触动
  const sidecar = await readSidecar(sb.target, 'my-skill')
  assert.equal(sidecar.kind, 'valid')
  assert.equal(sidecar.kind === 'valid' && sidecar.sidecar.version, '1.0')
})

test('16：rename(new → target) 失败 → backup 恢复为 target，内容与失败前一致', async () => {
  using sb = makeSandbox({ version: '1.0' })
  await stageNewVersion(sb)
  const realRename = await import('node:fs/promises').then(m => m.rename)
  let calls = 0
  await assert.rejects(
    atomicSwitch({
      stagingRoot: sb.stagingRoot,
      id: 'my-skill',
      target: sb.target,
      renameFn: async (from, to) => {
        calls++
        if (calls === 2) throw new Error('模拟 rename 失败') // new → target
        return realRename(from, to)
      },
    }),
    /模拟 rename 失败/,
  )
  // 回滚生效：target 是旧版本
  assert.equal(readFileSync(join(sb.target, 'SKILL.md'), 'utf8'), 'old 1.0')
})

test('原子切换成功：旧版本换出删除，staging 根清空后连根删', async () => {
  using sb = makeSandbox({ version: '1.0' })
  await stageNewVersion(sb)
  await atomicSwitch({
    stagingRoot: sb.stagingRoot,
    id: 'my-skill',
    target: sb.target,
  })
  assert.equal(readFileSync(join(sb.target, 'SKILL.md'), 'utf8'), 'new 1.1')
  const sidecar = await readSidecar(sb.target, 'my-skill')
  assert.equal(sidecar.kind === 'valid' && sidecar.sidecar.version, '1.1')
  assert.ok(!existsSync(sb.stagingRoot), 'staging 根应被一并删除')
})

test('切换前复核：缺 SKILL.md → 拒绝切换，目标不动', async () => {
  using sb = makeSandbox({ version: '1.0' })
  const zip = makeZip({ 'README.md': 'no skill' })
  const extracted = await extractSkillFiles(zip).catch(() => null)
  // 该 zip 走规则 3 会抛错，绕开 extractSkillFiles 直接构造残缺 staging
  assert.equal(extracted, null)
  const newDir = join(sb.stagingRoot, 'my-skill.new')
  mkdirSync(newDir, { recursive: true })
  writeFileSync(join(newDir, 'README.md'), 'no skill')
  writeFileSync(
    join(newDir, SIDECAR_FILENAME),
    JSON.stringify(sampleSidecar()),
  )
  await assert.rejects(
    atomicSwitch({
      stagingRoot: sb.stagingRoot,
      id: 'my-skill',
      target: sb.target,
    }),
    /没有 SKILL\.md/,
  )
  assert.equal(readFileSync(join(sb.target, 'SKILL.md'), 'utf8'), 'old 1.0')
})

test('17：遗留 <id>.new → recover 清理', async () => {
  using sb = makeSandbox()
  await stageNewVersion(sb)
  await recoverStaging({
    stagingRoot: sb.stagingRoot,
    id: 'my-skill',
    target: sb.target,
  })
  assert.ok(!existsSync(join(sb.stagingRoot, 'my-skill.new')))
})

test('18：遗留 <id>.old 且目标不存在 → 恢复为目标', async () => {
  using sb = makeSandbox({ version: '1.0' })
  // 模拟死在第 16-17 步之间：target 被换出为 old，new 已不在
  const oldDir = join(sb.stagingRoot, 'my-skill.old')
  mkdirSync(sb.stagingRoot, { recursive: true })
  await import('node:fs/promises').then(m => m.rename(sb.target, oldDir))
  await recoverStaging({
    stagingRoot: sb.stagingRoot,
    id: 'my-skill',
    target: sb.target,
  })
  assert.equal(readFileSync(join(sb.target, 'SKILL.md'), 'utf8'), 'old 1.0')
  assert.ok(!existsSync(oldDir))
})

test('19：遗留 <id>.old 且目标存在 → 清理 old，不影响目标', async () => {
  using sb = makeSandbox({ version: '1.1' })
  const oldDir = join(sb.stagingRoot, 'my-skill.old')
  mkdirSync(oldDir, { recursive: true })
  writeFileSync(join(oldDir, 'SKILL.md'), 'ancient')
  await recoverStaging({
    stagingRoot: sb.stagingRoot,
    id: 'my-skill',
    target: sb.target,
  })
  assert.ok(!existsSync(oldDir))
  assert.equal(readFileSync(join(sb.target, 'SKILL.md'), 'utf8'), 'old 1.1')
})

// sidecar 三态（§13.4-27/28/29 的读取侧）

test('27：sidecar JSON 损坏 → invalid（来源未知）', async () => {
  using sb = makeSandbox({ version: '1.0' })
  writeFileSync(join(sb.target, SIDECAR_FILENAME), '{broken')
  assert.equal((await readSidecar(sb.target, 'my-skill')).kind, 'invalid')
})

test('28：sidecar schemaVersion 99 → invalid', async () => {
  using sb = makeSandbox({ version: '1.0' })
  writeFileSync(
    join(sb.target, SIDECAR_FILENAME),
    JSON.stringify({ ...sampleSidecar(), schemaVersion: 99 }),
  )
  assert.equal((await readSidecar(sb.target, 'my-skill')).kind, 'invalid')
})

test('29：sidecar 的 id 与目录名不一致 → invalid；缺失 → missing', async () => {
  using sb = makeSandbox({ version: '1.0' })
  writeFileSync(
    join(sb.target, SIDECAR_FILENAME),
    JSON.stringify({ ...sampleSidecar(), id: 'other-skill' }),
  )
  assert.equal((await readSidecar(sb.target, 'my-skill')).kind, 'invalid')
  rmSync(join(sb.target, SIDECAR_FILENAME))
  assert.equal((await readSidecar(sb.target, 'my-skill')).kind, 'missing')
})

// ---------------------------------------------------------------------------
// §13.3-20/21、§13.4、§13.5：installSkill / removeSkill 编排
// ---------------------------------------------------------------------------

import { statSync } from 'node:fs'

import {
  decideOverwrite,
  installSkill,
  removeSkill,
  scanSkillDir,
  type InstallerDeps,
} from './skillInstaller.ts'

const HUB = 'http://h/yw-devhub/'

/** 假内网 hub：skills.json + zip 都由内存构造返回 */
function fakeHttpGet(opts: { version: string; withSha256?: boolean }) {
  const zip = makeZip({ 'SKILL.md': `content-${opts.version}` })
  const manifest = [
    {
      id: 'my-skill',
      version: opts.version,
      filename: 'my-skill.zip',
      ...(opts.withSha256 ? { sha256: sha256Hex(zip) } : {}),
    },
  ]
  return async (url: string) =>
    Buffer.from(
      url.endsWith('skills.json') ? JSON.stringify(manifest) : zip,
    )
}

function makeDeps(
  version: string,
  extra?: Partial<InstallerDeps> & { hubUrl?: string; force?: boolean },
): InstallerDeps & { refreshCount: () => number } {
  // force 是 installSkill 的参数而非依赖，单独剥出避免混进 deps
  const { hubUrl, force: _force, ...rest } = extra ?? {}
  let refreshCount = 0
  return {
    httpGet: fakeHttpGet({ version }),
    readSettings: readerWith({ userSettings: hubUrl ?? HUB }),
    checkPolicy: () => {},
    refreshCaches: () => {
      refreshCount++
    },
    ...rest,
    refreshCount: () => refreshCount,
  }
}

async function installOnce(
  sb: ReturnType<typeof makeSandbox>,
  version: string,
  extra?: Parameters<typeof makeDeps>[1],
) {
  const deps = makeDeps(version, extra)
  const result = await installSkill(
    { id: 'my-skill', scope: 'user', skillsRoot: sb.skillsRoot, force: extra?.force },
    deps,
  )
  return { result, deps }
}

test('全新安装：落盘 + sidecar + 缓存刷新一次', async () => {
  using sb = makeSandbox()
  const { result, deps } = await installOnce(sb, '1.0')
  assert.equal(result.kind, 'installed')
  assert.equal(readFileSync(join(sb.target, 'SKILL.md'), 'utf8'), 'content-1.0')
  const sidecar = await readSidecar(sb.target, 'my-skill')
  assert.equal(sidecar.kind, 'valid')
  assert.equal(deps.refreshCount(), 1)
  // staging 用完即删
  assert.ok(!existsSync(sb.stagingRoot))
})

test('22：同版本 + 同来源 → 不写磁盘（mtime 不变）且不刷新缓存', async () => {
  using sb = makeSandbox()
  await installOnce(sb, '1.0')
  const mtimeBefore = statSync(join(sb.target, 'SKILL.md')).mtimeMs
  const { result, deps } = await installOnce(sb, '1.0')
  assert.equal(result.kind, 'already-latest')
  assert.equal(statSync(join(sb.target, 'SKILL.md')).mtimeMs, mtimeBefore)
  assert.equal(deps.refreshCount(), 0)
})

test('23：版本不同 + 同来源 → 更新成功，sidecar 同步', async () => {
  using sb = makeSandbox()
  await installOnce(sb, '1.0')
  const { result } = await installOnce(sb, '1.1')
  assert.equal(result.kind, 'updated')
  assert.equal(
    result.kind === 'updated' ? result.previousVersion : null,
    '1.0',
  )
  assert.equal(readFileSync(join(sb.target, 'SKILL.md'), 'utf8'), 'content-1.1')
  const sidecar = await readSidecar(sb.target, 'my-skill')
  assert.equal(sidecar.kind === 'valid' && sidecar.sidecar.version, '1.1')
})

test('24：hubUrl 变化 → 非交互无 --force 拒绝；--force 通过', async () => {
  using sb = makeSandbox()
  await installOnce(sb, '1.0')
  await assert.rejects(
    installOnce(sb, '1.0', { hubUrl: 'http://other/yw-devhub/' }),
    /来源已变化.*--force/s,
  )
  const { result } = await installOnce(sb, '1.0', {
    hubUrl: 'http://other/yw-devhub/',
    force: true,
  })
  assert.equal(result.kind, 'updated')
  const sidecar = await readSidecar(sb.target, 'my-skill')
  assert.equal(
    sidecar.kind === 'valid' && sidecar.sidecar.hubUrl,
    'http://other/yw-devhub/',
  )
})

test('24b：hubUrl 变化 → 交互确认后通过，拒绝则中止', async () => {
  using sb = makeSandbox()
  await installOnce(sb, '1.0')
  let asked = ''
  const confirmYes = async (m: string) => {
    asked = m
    return true
  }
  const { result } = await installOnce(sb, '1.0', {
    hubUrl: 'http://other/yw-devhub/',
    confirm: confirmYes,
  })
  assert.equal(result.kind, 'updated')
  assert.match(asked, /旧：http:\/\/h\/yw-devhub\/\n  新：http:\/\/other/)

  const confirmNo = async () => false
  await assert.rejects(
    installOnce(sb, '1.0', { hubUrl: HUB, confirm: confirmNo }),
    /来源已变化/,
  )
})

test('25/26：无 sidecar → 无 --force 拒绝；--force 覆盖并补写 sidecar', async () => {
  using sb = makeSandbox()
  // 手工目录（无 sidecar）
  mkdirSync(sb.target, { recursive: true })
  writeFileSync(join(sb.target, 'SKILL.md'), 'hand-made')

  await assert.rejects(installOnce(sb, '1.0'), /来源未知.*--force/s)
  // 确认回调拒绝同样中止
  await assert.rejects(
    installOnce(sb, '1.0', { confirm: async () => false }),
    /来源未知/,
  )
  // 交互确认文案必须写明永久删除（§7.2）
  let asked = ''
  await installOnce(sb, '1.0', {
    confirm: async (m: string) => {
      asked = m
      return true
    },
  })
  assert.match(asked, /永久删除/)
  const sidecar = await readSidecar(sb.target, 'my-skill')
  assert.equal(sidecar.kind, 'valid')
})

test('30：user / project 同 id 同时存在 → 各自识别，互不影响', async () => {
  using userSb = makeSandbox()
  using projectSb = makeSandbox()
  await installOnce(userSb, '1.0')
  // project 侧装 2.0
  const deps = makeDeps('2.0')
  await installSkill(
    { id: 'my-skill', scope: 'project', skillsRoot: projectSb.skillsRoot },
    deps,
  )
  const userState = await scanSkillDir(userSb.target, 'my-skill')
  const projectState = await scanSkillDir(projectSb.target, 'my-skill')
  assert.equal(
    userState.kind === 'managed' && userState.sidecar.version,
    '1.0',
  )
  assert.equal(
    projectState.kind === 'managed' && projectState.sidecar.version,
    '2.0',
  )
})

test('20：两个进程并发安装同一 skill → 最终目录为某一次的完整内容', async () => {
  using sb = makeSandbox()
  const deps1 = makeDeps('1.0')
  const deps2 = makeDeps('1.0')
  const opts = {
    id: 'my-skill',
    scope: 'user' as const,
    skillsRoot: sb.skillsRoot,
  }
  const settled = await Promise.allSettled([
    installSkill(opts, deps1),
    installSkill(opts, deps2),
  ])
  // 至少一方完整完成
  assert.ok(settled.some(s => s.status === 'fulfilled'))
  // 最终目录是完整的一次安装：内容完整、sidecar 可解析、无混合残骸
  assert.equal(readFileSync(join(sb.target, 'SKILL.md'), 'utf8'), 'content-1.0')
  const sidecar = await readSidecar(sb.target, 'my-skill')
  assert.equal(sidecar.kind, 'valid')
  const entries = await import('node:fs/promises').then(m =>
    m.readdir(sb.target),
  )
  assert.deepEqual(entries.sort(), ['SKILL.md', SIDECAR_FILENAME].sort())
})

test('21：切换失败路径不刷新缓存；成功才刷新', async () => {
  using sb = makeSandbox({ version: '1.0' })
  const realRename = await import('node:fs/promises').then(m => m.rename)
  let calls = 0
  const deps = makeDeps('1.1', {
    renameFn: async (from, to) => {
      calls++
      if (calls === 2) throw new Error('模拟切换失败')
      return realRename(from, to)
    },
  })
  await assert.rejects(
    installSkill(
      { id: 'my-skill', scope: 'user', skillsRoot: sb.skillsRoot },
      deps,
    ),
    /模拟切换失败/,
  )
  assert.equal(deps.refreshCount(), 0)
  // 旧版本完好
  assert.equal(readFileSync(join(sb.target, 'SKILL.md'), 'utf8'), 'old 1.0')
})

test('未配置 ywdevhubUrl → 报错含完整路径与示例 JSON', async () => {
  using sb = makeSandbox()
  const deps = makeDeps('1.0', { readSettings: readerWith({}) })
  await assert.rejects(
    installSkill(
      { id: 'my-skill', scope: 'user', skillsRoot: sb.skillsRoot },
      deps,
    ),
    /未配置 ywdevhubUrl[\s\S]*"ywdevhubUrl": "http:\/\/10\.x\.x\.x\/yw-devhub\/"/,
  )
})

test('清单中不存在该 id / 条目仅查看 → 报错', async () => {
  using sb = makeSandbox()
  const deps = makeDeps('1.0')
  await assert.rejects(
    installSkill(
      { id: 'ghost', scope: 'user', skillsRoot: sb.skillsRoot },
      deps,
    ),
    /清单中不存在/,
  )
})

// --remove

test('正常卸载：删除目录并刷新缓存', async () => {
  using sb = makeSandbox()
  await installOnce(sb, '1.0')
  const deps = makeDeps('1.0')
  const result = await removeSkill(
    { id: 'my-skill', skillsRoot: sb.skillsRoot },
    deps,
  )
  assert.equal(result.removed, true)
  assert.ok(!existsSync(sb.target))
  assert.equal(deps.refreshCount(), 1)
})

test('31：无 sidecar → 拒绝删除，文案含实际路径', async () => {
  using sb = makeSandbox()
  mkdirSync(sb.target, { recursive: true })
  writeFileSync(join(sb.target, 'SKILL.md'), 'hand-made')
  await assert.rejects(
    removeSkill({ id: 'my-skill', skillsRoot: sb.skillsRoot }, makeDeps('1.0')),
    new RegExp(`不是由 /skill-install 安装的[\\s\\S]*${sb.target.replaceAll('/', '\\/')}`),
  )
  assert.ok(existsSync(sb.target), '目录应保留')
})

test('32/33：sidecar 损坏 / id 不匹配 → 拒绝删除', async () => {
  using sb = makeSandbox({ version: '1.0' })
  writeFileSync(join(sb.target, SIDECAR_FILENAME), '{broken')
  await assert.rejects(
    removeSkill({ id: 'my-skill', skillsRoot: sb.skillsRoot }, makeDeps('1.0')),
    /不是由 \/skill-install 安装的/,
  )

  writeFileSync(
    join(sb.target, SIDECAR_FILENAME),
    JSON.stringify({ ...sampleSidecar(), id: 'other' }),
  )
  await assert.rejects(
    removeSkill({ id: 'my-skill', skillsRoot: sb.skillsRoot }, makeDeps('1.0')),
    /不是由 \/skill-install 安装的/,
  )
})

test('34：user scope 不存在 → 报错，不回退到 project', async () => {
  using userSb = makeSandbox() // user 侧不装
  using projectSb = makeSandbox()
  await installOnce(projectSb, '1.0') // project 侧有
  await assert.rejects(
    removeSkill(
      { id: 'my-skill', skillsRoot: userSb.skillsRoot },
      makeDeps('1.0'),
    ),
    /不是由 \/skill-install 安装的/,
  )
  // project 侧不受影响
  assert.ok(existsSync(projectSb.target))
})

test('35：删除失败 → 不刷新缓存，不留下"已卸载"假状态', async () => {
  using sb = makeSandbox()
  await installOnce(sb, '1.0')
  const deps = makeDeps('1.0', {
    rmFn: async () => {
      throw new Error('模拟删除失败')
    },
  })
  await assert.rejects(
    removeSkill({ id: 'my-skill', skillsRoot: sb.skillsRoot }, deps),
    /模拟删除失败/,
  )
  assert.equal(deps.refreshCount(), 0)
  assert.ok(existsSync(sb.target), '目录应保留')
})

// ---------------------------------------------------------------------------
// §13.7 路径安全、§13.8 策略
// ---------------------------------------------------------------------------

import { symlinkSync } from 'node:fs'

import { assertPathInside } from './skillInstaller.ts'

test('48：目标路径链上存在指向 skills 根之外的符号链接 → 拒绝', async () => {
  using sb = makeSandbox()
  const outside = join(sb.root, 'outside')
  mkdirSync(outside, { recursive: true })
  mkdirSync(sb.skillsRoot, { recursive: true })
  // target 本身是指向根外的符号链接
  symlinkSync(outside, sb.target)
  await assert.rejects(
    assertPathInside(sb.skillsRoot, sb.target),
    /符号链接指向 skills 根之外/,
  )
  // 完整链路：installSkill 在第 4 步拒绝，不发生任何网络请求
  let httpCalled = false
  const deps = makeDeps('1.0')
  await assert.rejects(
    installSkill(
      { id: 'my-skill', scope: 'user', skillsRoot: sb.skillsRoot },
      {
        ...deps,
        httpGet: async () => {
          httpCalled = true
          return Buffer.from('')
        },
      },
    ),
    /符号链接指向 skills 根之外/,
  )
  assert.equal(httpCalled, false)
})

test('49：skills 根本身是符号链接 → realpath 后仍在预期位置则允许', async () => {
  using sb = makeSandbox()
  const realRoot = join(sb.root, 'real-skills')
  mkdirSync(join(realRoot, 'my-skill'), { recursive: true })
  const linkRoot = join(sb.root, 'skills-link')
  symlinkSync(realRoot, linkRoot)
  // 不应抛错
  await assertPathInside(linkRoot, join(linkRoot, 'my-skill'))
})

test('字符串包含兜底：目标不在 skills 根内 → 拒绝', async () => {
  using sb = makeSandbox()
  await assert.rejects(
    assertPathInside(sb.skillsRoot, join(sb.root, 'elsewhere', 'x')),
    /不在 skills 根内/,
  )
})

test('51/52：策略锁定 → user / project 安装均拒绝，--force 不能绕过', async () => {
  using sb = makeSandbox()
  const policyLocked = () => {
    throw new Error(
      '组织策略要求 skills 通过 plugin 或受管来源提供，/skill-install 已被禁用',
    )
  }
  for (const scope of ['user', 'project'] as const) {
    await assert.rejects(
      installSkill(
        { id: 'my-skill', scope, skillsRoot: sb.skillsRoot },
        makeDeps('1.0', { checkPolicy: policyLocked }),
      ),
      /已被禁用/,
    )
    // --force 不能绕过
    await assert.rejects(
      installSkill(
        { id: 'my-skill', scope, skillsRoot: sb.skillsRoot, force: true },
        makeDeps('1.0', { checkPolicy: policyLocked }),
      ),
      /已被禁用/,
    )
  }
  // 策略检查发生在网络请求之前
  let httpCalled = false
  await assert.rejects(
    installSkill(
      { id: 'my-skill', scope: 'user', skillsRoot: sb.skillsRoot },
      makeDeps('1.0', {
        checkPolicy: policyLocked,
        httpGet: async () => {
          httpCalled = true
          return Buffer.from('')
        },
      }),
    ),
    /已被禁用/,
  )
  assert.equal(httpCalled, false)
})

test('53：策略锁定时 --remove 仍可清理本工具安装的目录', async () => {
  using sb = makeSandbox()
  await installOnce(sb, '1.0')
  // removeSkill 不调 checkPolicy（清理不等于加载授权，§9.1）
  const result = await removeSkill(
    { id: 'my-skill', skillsRoot: sb.skillsRoot },
    makeDeps('1.0', {
      checkPolicy: () => {
        throw new Error('不应被调用')
      },
    }),
  )
  assert.equal(result.removed, true)
  assert.ok(!existsSync(sb.target))
})
