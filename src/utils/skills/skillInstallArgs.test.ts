import assert from 'node:assert/strict'
import test from 'node:test'

import {
  parseSkillInstallArgs,
  validateSkillId,
} from './skillInstallArgs.ts'

/** 便捷断言：解析成功且 args 匹配期望 */
function expectOk(raw: string, expected: unknown) {
  const result = parseSkillInstallArgs(raw)
  assert.equal(result.ok, true, `期望解析成功：${raw}`)
  assert.deepEqual(result.ok ? result.args : null, expected)
}

/** 便捷断言：解析失败且错误文案包含指定片段 */
function expectError(raw: string, messagePart: string) {
  const result = parseSkillInstallArgs(raw)
  assert.equal(result.ok, false, `期望解析失败：${raw}`)
  assert.match(result.ok ? '' : result.error, new RegExp(messagePart))
}

test('空参数与纯空白 → list', () => {
  expectOk('', { kind: 'list' })
  expectOk('   ', { kind: 'list' })
})

test('正常安装：id / id+--project / id+--force / id+--project+--force', () => {
  expectOk('foo', { kind: 'install', id: 'foo', project: false, force: false })
  expectOk('foo --project', {
    kind: 'install',
    id: 'foo',
    project: true,
    force: false,
  })
  // §13.1-5：--project --force 合法组合
  expectOk('foo --project --force', {
    kind: 'install',
    id: 'foo',
    project: true,
    force: true,
  })
  expectOk('--force --project foo', {
    kind: 'install',
    id: 'foo',
    project: true,
    force: true,
  })
})

test('正常卸载：--remove id / --remove id --project', () => {
  expectOk('--remove foo', { kind: 'remove', id: 'foo', project: false })
  expectOk('--remove foo --project', {
    kind: 'remove',
    id: 'foo',
    project: true,
  })
})

test('§13.1-1：重复 flag / 未知 flag / 多余位置参数', () => {
  expectError('foo --project --project', '重复 flag：--project')
  expectError('foo --force --force', '重复 flag：--force')
  expectError('--remove a --remove b', '重复 flag：--remove')
  expectError('foo --prjoect', '未知 flag：--prjoect')
  expectError('foo -p', '未知 flag：-p')
  expectError('foo bar', '多余的位置参数：bar')
  expectError('foo bar baz', '多余的位置参数：bar baz')
})

test('§13.1-2：--remove 缺参数', () => {
  expectError('--remove', '--remove 缺少参数')
  // 下一个 token 是 flag 也视为缺参数
  expectError('--remove --project', '--remove 缺少参数')
})

test('§13.1-3：安装 id 与 --remove 同时出现', () => {
  expectError('foo --remove bar', '不能同时出现安装 id 与 --remove')
})

test('§13.1-4：--force 与 --remove 同时出现', () => {
  expectError('--remove foo --force', '--force 不能与 --remove 同时使用')
})

test('§13.1-6：id 以 - 开头、含路径字符、`..`', () => {
  // 以 - 开头会被当作未知 flag，同样是明确拒绝
  expectError('-foo', '未知 flag：-foo')
  expectError('--remove -foo', '--remove 缺少参数')
  expectError('a/b', 'id 只能包含')
  expectError('a\\b', 'id 只能包含')
  expectError('a:b', 'id 只能包含')
  expectError('..', 'id 只能包含')
  expectError('../evil', 'id 只能包含')
  expectError('.hidden', 'id 只能包含')
})

test('id 长度上限 64', () => {
  assert.equal(validateSkillId('a'.repeat(64)), null)
  assert.match(validateSkillId('a'.repeat(65)) ?? '', /长度须为/)
})

test('合法 id 边界：数字开头、含点/下划线/连字符、大写字母', () => {
  assert.equal(validateSkillId('1st-skill'), null)
  assert.equal(validateSkillId('my.skill_v2-beta'), null)
  assert.equal(validateSkillId('UPPER'), null)
})
