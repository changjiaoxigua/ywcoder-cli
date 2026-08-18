/**
 * /skill-install 的 UI 层（设计文档 §11）。
 *
 * 只负责：参数解析分发、四态列表渲染、两类二次确认、结果展示。
 * 全部业务判定都在 utils/skills/skillInstaller.ts，本文件不做业务判断。
 */
import { join } from 'node:path'
import { appendFileSync } from 'node:fs'
import * as React from 'react'
import { useEffect, useState } from 'react'

// 临时排障探针：定位安装/卸载 skill 后 UI 冻结的断点，修完即删
function traceStep(msg: string): void {
  try {
    appendFileSync('/tmp/reload-trace.log', `${Date.now()} ${msg}\n`)
  } catch {
    // 忽略
  }
}
import {
  type OptionWithDescription,
  Select,
} from '../../components/CustomSelect/select.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import { Text } from '../../ink.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import {
  decideOverwrite,
  fetchManifest,
  installSkill,
  type ManifestEntry,
  type OverwriteDecision,
  removeSkill,
  resolveHubConfig,
  resolveSkillsRoot,
  scanSkillDir,
  type SkillDirState,
  type SkillScope,
} from '../../utils/skills/skillInstaller.js'
import { parseSkillInstallArgs } from '../../utils/skills/skillInstallArgs.js'

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** §11.1 四态标签（hub 来源变化归入"已安装"系，附来源变化说明） */
function rowLabel(entry: ManifestEntry, decision: OverwriteDecision): string {
  const base = `${entry.id}  v${entry.version}`
  if (entry.viewOnlyReason !== null) return `${base}  (仅查看)`
  switch (decision.action) {
    case 'install':
      return base
    case 'already-latest':
      return `${base}  (已安装)`
    case 'update':
      return `${base}  (已安装 v${decision.previousVersion} → 可更新)`
    case 'confirm-hub-changed':
      return `${base}  (已安装，来源已变化)`
    case 'confirm-unknown-source':
      return `${base}  (本地已存在，来源未知)`
  }
}

type Row = {
  entry: ManifestEntry
  decision: OverwriteDecision
}

type MenuPhase =
  | { kind: 'list'; rows: Row[] }
  | { kind: 'confirm'; rows: Row[]; row: Row }
  | { kind: 'installing'; id: string }

type MenuProps = {
  onDone: LocalJSXCommandOnDone
  hubRoot: string
  /** 列表视角的 scope：决定扫描哪个 skills 根、装到哪一级目录 */
  scope: SkillScope
  skillsRoot: string
  warnings: string[]
  initialRows: Row[]
}

function SkillInstallMenu(props: MenuProps): React.ReactNode {
  const { onDone, hubRoot, scope, skillsRoot, warnings, initialRows } = props
  const [phase, setPhase] = useState<MenuPhase>({
    kind: 'list',
    rows: initialRows,
  })

  async function runInstall(row: Row): Promise<void> {
    const id = row.entry.id
    setPhase({ kind: 'installing', id })
    try {
      // 需要确认的决策已在 UI 里确认过，confirm 恒为同意
      const result = await installSkill(
        { id, scope, skillsRoot },
        { confirm: () => Promise.resolve(true) },
      )
      if (result.kind === 'already-latest') {
        onDone(`已是最新版本：${id} v${result.version}（${result.path}）`)
        return
      }
      const action = result.kind === 'updated' ? '更新完成' : '安装完成'
      const versionText =
        result.kind === 'updated' && result.previousVersion
          ? `v${result.previousVersion} → v${result.version}`
          : `v${result.version}`
      onDone(
        `${action}：${id} ${versionText}\n` +
          `路径：${result.path}\n` +
          `来源：${result.hubUrl}` +
          (result.verified ? '' : '\n注意：清单未提供 sha256，未做完整性校验'),
      )
    } catch (e) {
      onDone(`安装失败：${errorText(e)}`, { display: 'system' })
    }
  }

  function handleSelect(id: string): void {
    if (phase.kind !== 'list') return
    const row = phase.rows.find(r => r.entry.id === id)
    if (!row) return
    if (
      row.decision.action === 'confirm-unknown-source' ||
      row.decision.action === 'confirm-hub-changed'
    ) {
      setPhase({ kind: 'confirm', rows: phase.rows, row })
      return
    }
    void runInstall(row)
  }

  const handleCancel = () => onDone(undefined, { display: 'skip' })

  if (phase.kind === 'installing') {
    return <Text>正在安装 {phase.id} …（下载与校验中）</Text>
  }

  if (phase.kind === 'confirm') {
    const { row } = phase
    const message =
      row.decision.action === 'confirm-hub-changed'
        ? `该 skill 的安装来源已变化：\n  旧：${row.decision.oldHub}\n  新：${row.decision.newHub}\n继续将按新来源覆盖安装。`
        : `目标目录已存在且来源未知（非 /skill-install 安装）。\n继续将永久删除其中的全部本地修改：${join(skillsRoot, row.entry.id)}`
    const options: OptionWithDescription<string>[] = [
      { label: '确认覆盖安装', value: 'yes' },
      { label: '取消', value: 'no' },
    ]
    return (
      <Dialog title={`确认覆盖 ${row.entry.id}`} onCancel={handleCancel}>
        <Text>{message}</Text>
        <Select
          options={options}
          onChange={(value: string) => {
            if (value === 'yes') {
              void runInstall(row)
            } else {
              setPhase({ kind: 'list', rows: phase.rows })
            }
          }}
          visibleOptionCount={2}
        />
      </Dialog>
    )
  }

  // 列表态（phase.kind === 'list'）
  const options: OptionWithDescription<string>[] = phase.rows.map(row => ({
    label: rowLabel(row.entry, row.decision),
    value: row.entry.id,
    description: row.entry.description,
    disabled: row.entry.viewOnlyReason !== null,
  }))
  const hasUnverified = phase.rows.some(r => r.entry.sha256 === undefined)
  return (
    <Dialog
      title={`内网 Skill 安装（${scope === 'project' ? '项目级' : '用户级'}）— ${hubRoot}`}
      onCancel={handleCancel}
      subtitle={
        warnings.length > 0 ? `清单警告：${warnings.join('；')}` : undefined
      }
    >
      <Select
        options={options}
        onChange={handleSelect}
        onCancel={handleCancel}
        visibleOptionCount={Math.min(options.length, 10)}
      />
      <Text dimColor>
        skill 可执行 shell 命令，请只安装可信来源
        {hasUnverified ? '；部分条目未提供 sha256，将跳过完整性校验' : ''}
        {scope === 'project' ? '；项目级 skill 的全部内容将随仓库提交' : ''}
      </Text>
    </Dialog>
  )
}

/** 带参数直装 / 卸载：不渲染列表，只展示进行中提示，结束后 onDone */
function DirectRun(props: {
  onDone: LocalJSXCommandOnDone
  task: () => Promise<string>
  pendingText: string
}): React.ReactNode {
  const { onDone, task, pendingText } = props
  useEffect(() => {
    let cancelled = false
    traceStep('DirectRun mount')
    task().then(
      message => {
        traceStep(`DirectRun task settled ok cancelled=${cancelled}`)
        if (!cancelled) onDone(message)
        else traceStep('DirectRun onDone SWALLOWED')
      },
      (e: unknown) => {
        traceStep(`DirectRun task settled err cancelled=${cancelled}`)
        if (!cancelled) onDone(errorText(e), { display: 'system' })
        else traceStep('DirectRun onDone SWALLOWED')
      },
    )
    return () => {
      cancelled = true
      traceStep('DirectRun cleanup')
    }
    // task 由 call() 一次性构造，不随渲染变化
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return <Text>{pendingText}</Text>
}

/** 列表加载器：先拉清单 + 扫描本地状态，再挂菜单 */
function ListLoader(props: {
  onDone: LocalJSXCommandOnDone
  project: boolean
}): React.ReactNode {
  const { onDone, project } = props
  const [loaded, setLoaded] = useState<MenuProps | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const hub = resolveHubConfig()
      if (hub === null) {
        const { getSettingsFilePathForSource } = await import(
          '../../utils/settings/settings.js'
        )
        throw new Error(
          `未配置 ywdevhubUrl。请在 ${getSettingsFilePathForSource('userSettings')} 中添加：\n` +
            `{ "ywdevhubUrl": "http://10.x.x.x/yw-devhub/" }`,
        )
      }
      const scope: SkillScope = project ? 'project' : 'user'
      const skillsRoot = await resolveSkillsRoot(scope)
      const manifest = await fetchManifest(hub.hubRoot)
      const rows: Row[] = []
      for (const entry of manifest.entries) {
        // 仅查看的条目无需扫描本地目录
        const state: SkillDirState =
          entry.viewOnlyReason !== null
            ? { kind: 'absent' }
            : await scanSkillDir(join(skillsRoot, entry.id), entry.id)
        rows.push({
          entry,
          decision: decideOverwrite(state, entry, hub.hubRoot),
        })
      }
      return { hub, scope, skillsRoot, manifest, rows }
    })().then(
      ({ hub, scope, skillsRoot, manifest, rows }) => {
        if (cancelled) return
        setLoaded({
          onDone,
          hubRoot: hub.hubRoot,
          scope,
          skillsRoot,
          warnings: manifest.warnings,
          initialRows: rows,
        })
      },
      (e: unknown) => {
        if (!cancelled) onDone(errorText(e), { display: 'system' })
      },
    )
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (loaded === null) {
    return <Text>正在拉取内网 skill 清单 …</Text>
  }
  return <SkillInstallMenu {...loaded} />
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  _context: unknown,
  args?: string,
): Promise<React.ReactNode> {
  const parsed = parseSkillInstallArgs(args ?? '')
  if (!parsed.ok) {
    onDone(parsed.error, { display: 'system' })
    return null
  }

  if (parsed.args.kind === 'list') {
    return <ListLoader onDone={onDone} project={parsed.args.project} />
  }

  if (parsed.args.kind === 'remove') {
    const { id, project } = parsed.args
    return (
      <DirectRun
        onDone={onDone}
        pendingText={`正在卸载 ${id} …`}
        task={async () => {
          const scope: SkillScope = project ? 'project' : 'user'
          const skillsRoot = await resolveSkillsRoot(scope)
          const result = await removeSkill({ id, skillsRoot })
          return `已卸载：${id}\n路径：${result.path}`
        }}
      />
    )
  }

  // install：直装不做 UI 二次确认；需确认的覆盖会被 installSkill
  // 以"非交互模式需加 --force"拒绝（§6 第 8 步），列表路径才有确认弹窗
  const { id, project, force } = parsed.args
  return (
    <DirectRun
      onDone={onDone}
      pendingText={`正在安装 ${id} …（下载与校验中）`}
      task={async () => {
        const scope: SkillScope = project ? 'project' : 'user'
        const skillsRoot = await resolveSkillsRoot(scope)
        const result = await installSkill({ id, scope, skillsRoot, force })
        if (result.kind === 'already-latest') {
          return `已是最新版本：${id} v${result.version}（${result.path}）`
        }
        const action = result.kind === 'updated' ? '更新完成' : '安装完成'
        const versionText =
          result.kind === 'updated' && result.previousVersion
            ? `v${result.previousVersion} → v${result.version}`
            : `v${result.version}`
        return (
          `${action}：${id} ${versionText}\n` +
          `路径：${result.path}\n` +
          `来源：${result.hubUrl}` +
          (result.verified ? '' : '\n注意：清单未提供 sha256，未做完整性校验')
        )
      }}
    />
  )
}
