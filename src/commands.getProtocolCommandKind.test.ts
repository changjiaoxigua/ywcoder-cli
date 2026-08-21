/**
 * 审查 R2-6 —— getProtocolCommandKind 分类测试：
 * initialize / reload-plugins 上报管控台的 kind 必须由这一处统一判定，
 * 覆盖目录技能、插件技能、MCP 技能、内置技能与各类普通命令的来源形态。
 */
import { describe, expect, test } from 'bun:test'
import { getProtocolCommandKind } from './commands.js'
import type { Command } from './types/command.js'

/** 构造最小 Command：分类只看 type 与 loadedFrom，其余字段不参与判定。 */
function cmd(type: string, loadedFrom?: string): Command {
  return { type, loadedFrom } as unknown as Command
}

describe('getProtocolCommandKind', () => {
  test('目录技能（~/.ywcoder/skills，loadedFrom=skills）→ skill', () => {
    expect(getProtocolCommandKind(cmd('prompt', 'skills'))).toBe('skill')
  })

  test('插件技能（插件内 skills/ 目录，loadedFrom=plugin）→ skill', () => {
    expect(getProtocolCommandKind(cmd('prompt', 'plugin'))).toBe('skill')
  })

  test('MCP 技能（prompt 型且 loadedFrom=mcp）→ skill', () => {
    expect(getProtocolCommandKind(cmd('prompt', 'mcp'))).toBe('skill')
  })

  test('内置技能（bundled）→ skill', () => {
    expect(getProtocolCommandKind(cmd('prompt', 'bundled'))).toBe('skill')
  })

  test('插件普通命令（prompt 型但无 loadedFrom）→ command', () => {
    expect(getProtocolCommandKind(cmd('prompt', undefined))).toBe('command')
  })

  test('legacy /commands/ 目录命令（commands_DEPRECATED）→ command', () => {
    expect(getProtocolCommandKind(cmd('prompt', 'commands_DEPRECATED'))).toBe('command')
  })

  test('local 命令一律 → command（即使携带 loadedFrom）', () => {
    expect(getProtocolCommandKind(cmd('local', 'skills'))).toBe('command')
    expect(getProtocolCommandKind(cmd('local', undefined))).toBe('command')
  })

  test('其它非 prompt 类型（local-jsx 等）→ command', () => {
    expect(getProtocolCommandKind(cmd('local-jsx', 'plugin'))).toBe('command')
  })
})
