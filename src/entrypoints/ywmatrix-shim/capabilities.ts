/**
 * P3 —— 两级 capabilities 快照（v3 §6.4/§6.5 + C1/C7 + 契约确认 2/3/6/7）。
 *
 * 作用域：
 * - 全局快照（不带 session_id）：chat 能力 + 模型/权限切换命令。模型与权限是
 *   Agent 实例全局设置（契约确认 6），其 metadata.current 只在全局快照发布。
 * - 会话快照（带 session_id）：该 workdir 下可执行的命令与技能，在对应
 *   ywcoder 子进程 initialize 后上报（C7 分阶段加载）。
 *
 * 上报时机（C7）：register 先报稳定全局能力；首个子进程 initialize 返回
 * 模型列表后，再用全局 capabilities_updated 补上 /model。
 */
import type { CapabilityEntry } from './protocol.js'

/** 权限档位原生值（契约确认 3：不做 auto/full_auto 别名映射）。 */
const PERMISSION_OPTIONS_BASE = ['default', 'acceptEdits']

export interface GlobalCapsState {
  /** 当前全局权限模式。 */
  permissionMode: string
  /** 启动级是否显式允许 bypassPermissions（契约确认 3：未允许则不上报该选项）。 */
  allowBypassPermissions: boolean
  /** 模型下拉的 options（首个子进程 initialize 返回的 models）；未知则不声明 /model。 */
  modelOptions?: string[]
  /** 当前全局模型；initialize 的 models 无 current 标记，未切换过则不填。 */
  currentModel?: string
}

/** Agent 全局能力全量快照（register 与全局 capabilities_updated 共用）。 */
export function buildGlobalCapabilities(state: GlobalCapsState): CapabilityEntry[] {
  const caps: CapabilityEntry[] = [
    {
      type: 'chat',
      name: 'coding',
      description: '编码助手，可读写文件、执行命令、分析代码',
    },
    {
      type: 'command',
      name: 'permission',
      description: '切换权限模式',
      metadata: {
        current: state.permissionMode,
        args: [
          {
            name: 'mode',
            type: 'enum',
            options: state.allowBypassPermissions
              ? [...PERMISSION_OPTIONS_BASE, 'bypassPermissions']
              : PERMISSION_OPTIONS_BASE,
            required: true,
          },
        ],
      },
    },
  ]
  // C7：还没有真实模型 options 时暂不上报 /model，避免页面上能点但点了没效果。
  if (state.modelOptions && state.modelOptions.length > 0) {
    caps.push({
      type: 'command',
      name: 'model',
      description: '切换模型',
      metadata: {
        ...(state.currentModel ? { current: state.currentModel } : {}),
        args: [
          {
            name: 'model',
            type: 'enum',
            options: state.modelOptions,
            required: true,
          },
        ],
      },
    })
  }
  return caps
}

/**
 * 会话级能力全量快照（契约确认 7：命令/技能按 session/workdir 作用域）。
 * 入参为 ywcoder initialize 返回的命令列表——该列表在上游已按 headless
 * 可执行性过滤（main.tsx 的 commandsHeadless：prompt 且非 disableNonInteractive，
 * 或 local 且 supportsNonInteractive），shim 不再二次过滤，否则会把可
 * 非交互执行的技能/命令错误丢弃。技能按 v3 §6.5 约定以
 * `type:"command" + metadata.kind:"skill"` 上报（页面据此分组）。
 */
export function buildSessionCapabilities(
  commands: Array<{ name: string; description?: string; kind?: 'command' | 'skill' }>,
): CapabilityEntry[] {
  return commands.map(c => ({
    type: 'command',
    name: c.name,
    ...(c.description ? { description: c.description } : {}),
    ...(c.kind === 'skill' ? { metadata: { kind: 'skill' } } : {}),
  }))
}

/**
 * 快照指纹：用于推送前去重（C1 合并语义下，重复推送同层同内容快照无意义）。
 * 顺序敏感——构造方保证确定性顺序即可。
 */
export function capabilitiesFingerprint(caps: CapabilityEntry[]): string {
  return JSON.stringify(caps)
}

/**
 * 判断命令是否在会话可执行列表内（initialize 返回的 commands 即上游
 * headless 过滤后的全集，契约确认 8）。
 */
export function isSessionCommand(
  commands: Array<{ name: string }>,
  name: string,
): boolean {
  return commands.some(c => c.name === name)
}
