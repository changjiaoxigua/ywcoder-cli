import { describe, expect, test } from 'bun:test'
import * as path from 'path'
import { FileReadTool } from './FileReadTool.js'
import { getEmptyToolPermissionContext } from '../../Tool.js'
import type { ToolUseContext } from '../../Tool.js'

// 构造最小的 ToolUseContext：validateInput 的 pages 校验分支只依赖
// getAppState().toolPermissionContext（用于 deny 规则匹配），其余字段用不到。
const ctx = {
  getAppState: () => ({
    toolPermissionContext: getEmptyToolPermissionContext(),
  }),
} as unknown as ToolUseContext

describe('FileReadTool.validateInput pages 校验', () => {
  test('非 PDF 文件传入非法 pages（如 "*"）不应报错，参数被忽略', async () => {
    // 弱模型分析项目时常对普通源码文件塞入 pages: "*"，此处不应被拦截。
    const result = await FileReadTool.validateInput(
      { file_path: path.resolve('src/foo.ts'), pages: '*' },
      ctx,
    )
    expect(result.result).toBe(true)
  })

  test('非 PDF 文件传入看似合法的 pages 同样直接放行', async () => {
    const result = await FileReadTool.validateInput(
      { file_path: path.resolve('src/foo.ts'), pages: '1-5' },
      ctx,
    )
    expect(result.result).toBe(true)
  })

  test('PDF 文件传入非法 pages（"*"）仍应报错', async () => {
    const result = await FileReadTool.validateInput(
      { file_path: path.resolve('doc.pdf'), pages: '*' },
      ctx,
    )
    expect(result.result).toBe(false)
    if (result.result === false) {
      expect(result.errorCode).toBe(7)
    }
  })

  test('PDF 文件传入合法 pages（"1-5"）应通过', async () => {
    const result = await FileReadTool.validateInput(
      { file_path: path.resolve('doc.pdf'), pages: '1-5' },
      ctx,
    )
    expect(result.result).toBe(true)
  })

  test('PDF 文件 pages 范围超过单次上限应报错', async () => {
    const result = await FileReadTool.validateInput(
      { file_path: path.resolve('doc.pdf'), pages: '1-999' },
      ctx,
    )
    expect(result.result).toBe(false)
    if (result.result === false) {
      expect(result.errorCode).toBe(8)
    }
  })
})
