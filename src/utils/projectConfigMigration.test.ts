import { describe, expect, test } from 'bun:test'
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
import { resolveProjectConfigDir } from './projectConfigDir.js'
import {
  migrateProjectConfig,
  runProjectConfigMigration,
} from './projectConfigMigration.js'

function withTempRoot(fn: (root: string) => void | Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'ywcoder-projmig-'))
  return Promise.resolve(fn(root)).finally(() => {
    rmSync(root, { recursive: true, force: true })
  })
}

// `bun test` 下 feature() 恒 OFF，故迁移真实行为用核心 runProjectConfigMigration 覆盖；
// 公开入口 migrateProjectConfig 仅能验证 flag OFF 早退。
describe('projectConfigMigration · 核心 runProjectConfigMigration（覆盖迁移行为）', () => {
  test('全新项目（无 .claude/）→ skipped-no-source，不建任何目录', async () => {
    await withTempRoot(async root => {
      const r = await runProjectConfigMigration(root)
      expect(r.status).toBe('skipped-no-source')
      expect(existsSync(join(root, '.ywcoder'))).toBe(false)
    })
  })

  test('.ywcoder/ 已存在 → already-migrated（幂等，不覆盖）', async () => {
    await withTempRoot(async root => {
      mkdirSync(join(root, '.ywcoder'))
      mkdirSync(join(root, '.claude'))
      writeFileSync(join(root, '.claude', 'settings.json'), '{"a":1}')
      const r = await runProjectConfigMigration(root)
      expect(r.status).toBe('already-migrated')
      // 未把 .claude 内容覆盖进已存在的 .ywcoder
      expect(existsSync(join(root, '.ywcoder', 'settings.json'))).toBe(false)
    })
  })

  test('仅 .claude/ → migrated：复制到 .ywcoder/，原 .claude/ 保留', async () => {
    await withTempRoot(async root => {
      mkdirSync(join(root, '.claude', 'rules'), { recursive: true })
      writeFileSync(join(root, '.claude', 'settings.json'), '{"x":1}')
      writeFileSync(join(root, '.claude', 'rules', 'a.md'), '# a')

      const r = await runProjectConfigMigration(root)
      expect(r.status).toBe('migrated')
      // 新目录有完整副本
      expect(readFileSync(join(root, '.ywcoder', 'settings.json'), 'utf8')).toBe(
        '{"x":1}',
      )
      expect(readFileSync(join(root, '.ywcoder', 'rules', 'a.md'), 'utf8')).toBe(
        '# a',
      )
      // 原 .claude/ 原样留作备份（copy-keep）
      expect(existsSync(join(root, '.claude', 'settings.json'))).toBe(true)
    })
  })

  test('迁移跳过 worktrees/ 天窗（不复制进 .ywcoder/）', async () => {
    await withTempRoot(async root => {
      mkdirSync(join(root, '.claude', 'worktrees', 'feat-x'), {
        recursive: true,
      })
      writeFileSync(
        join(root, '.claude', 'worktrees', 'feat-x', '.git'),
        'gitdir: ...',
      )
      writeFileSync(join(root, '.claude', 'settings.json'), '{}')

      const r = await runProjectConfigMigration(root)
      expect(r.status).toBe('migrated')
      expect(existsSync(join(root, '.ywcoder', 'settings.json'))).toBe(true)
      // worktrees 未被搬进新目录
      expect(existsSync(join(root, '.ywcoder', 'worktrees'))).toBe(false)
      // 天窗仍留在旧目录
      expect(existsSync(join(root, '.claude', 'worktrees', 'feat-x'))).toBe(true)
    })
  })

  test('同步 .gitignore：为 .claude/ 规则追加 .ywcoder/ 并行规则（幂等、跳护栏/天窗）', async () => {
    await withTempRoot(async root => {
      mkdirSync(join(root, '.claude'))
      writeFileSync(join(root, '.claude', 'settings.json'), '{}')
      writeFileSync(
        join(root, '.gitignore'),
        [
          'node_modules/',
          '.claude/settings.local.json',
          '.claude/worktrees/',
          '.claude-plugin/secrets',
          '.ywcoder/settings.local.json', // 已存在的并行规则（不应重复）
        ].join('\n'),
      )

      await runProjectConfigMigration(root)
      const gi = readFileSync(join(root, '.gitignore'), 'utf8')
      // .claude/settings.local.json 的 .ywcoder 并行规则被追加（且只一份）
      expect(
        gi.split('\n').filter(l => l.trim() === '.ywcoder/settings.local.json')
          .length,
      ).toBe(1)
      // 天窗 / 护栏不造并行规则
      expect(gi).not.toContain('.ywcoder/worktrees/')
      expect(gi).not.toContain('.ywcoder-plugin/secrets')
      // 旧规则保留（copy-keep）
      expect(gi).toContain('.claude/settings.local.json')
    })
  })

  test('优雅降级：目标父不可写时不抛出（返回 failed/skip，不打断启动）', async () => {
    // .ywcoder 已作为「文件」占位 → cp 到同名目录会失败；验证不抛出。
    await withTempRoot(async root => {
      mkdirSync(join(root, '.claude'))
      writeFileSync(join(root, '.claude', 'settings.json'), '{}')
      writeFileSync(join(root, '.ywcoder'), 'not a dir')
      // .ywcoder 作为文件存在 → existsSync 为真 → 走幂等 already-migrated 分支（不抛）
      const r = await runProjectConfigMigration(root)
      expect(['already-migrated', 'failed']).toContain(r.status)
    })
  })
})

// 集成式：迁移后，活跃目录解析器（模拟 flag ON，migrate=true）应指向 .ywcoder/ 且能读到迁来的 settings。
// 这是 OFF 的 bun test 下能达到的「迁移→生效目录一致」端到端断言（启动接入点正是迁移后让 settings
// 从该活跃目录读取）。完整的"接进 cli.tsx 启动流程"因 feature() 恒 OFF 无法在单测里走真值，
// 已在 cli.tsx 用 if(feature('MIGRATE_PROJECT_CONFIG')) 门控并经 dist DCE 验证。
describe('projectConfigMigration · 集成：迁移后活跃目录解析到 .ywcoder/ 的迁移内容', () => {
  test('migrate → resolveProjectConfigDir(root, true) 指向 .ywcoder/ 且 settings 可读', async () => {
    await withTempRoot(async root => {
      mkdirSync(join(root, '.claude'))
      writeFileSync(
        join(root, '.claude', 'settings.json'),
        '{"permissions":{"allow":["Read"]}}',
      )

      const r = await runProjectConfigMigration(root)
      expect(r.status).toBe('migrated')

      // 模拟 flag ON 的运行时择优：迁移后 .ywcoder/ 存在 → 解析到新目录
      const active = resolveProjectConfigDir(root, true)
      expect(active).toBe(join(root, '.ywcoder'))
      // 启动接入后 settings 即从该活跃目录读取，内容应是迁来的副本
      expect(readFileSync(join(active, 'settings.json'), 'utf8')).toBe(
        '{"permissions":{"allow":["Read"]}}',
      )
    })
  })
})

describe('projectConfigMigration · 公开入口（受 flag 门控）', () => {
  test('flag OFF：migrateProjectConfig 早退 skipped-flag-off，不动文件系统', async () => {
    await withTempRoot(async root => {
      mkdirSync(join(root, '.claude'))
      writeFileSync(join(root, '.claude', 'settings.json'), '{}')
      const r = await migrateProjectConfig(root)
      expect(r.status).toBe('skipped-flag-off')
      // OFF 下不创建 .ywcoder/
      expect(existsSync(join(root, '.ywcoder'))).toBe(false)
    })
  })
})
