import * as React from 'react'
import { expect, test } from 'bun:test'
import stringWidth from 'string-width'
import { renderToString } from '../../utils/staticRender.js'
import { YwUpdateNotice } from './YwUpdateNotice.js'

test.each([40, 80, 120])('更新提示在 %s 列终端保持一行', async columns => {
  const output = await renderToString(<YwUpdateNotice latestVersion="1.4.0" />, columns)
  const lines = output.trim().split('\n')

  expect(lines).toHaveLength(1)
  expect(lines[0]).toContain('可更新至 1.4.0 · ywcoder update')
  expect(stringWidth(lines[0]!)).toBeLessThanOrEqual(columns)
})

test.each([20, 40, 80])('长版本号在 %s 列终端截断而不逐字换行', async columns => {
  const latestVersion = `1.4.0-dev.${'a'.repeat(50)}`
  const output = await renderToString(<YwUpdateNotice latestVersion={latestVersion} />, columns)
  const lines = output.trim().split('\n')

  expect(lines).toHaveLength(1)
  expect(lines[0]).toStartWith('可更新至 ')
  expect(lines[0]).toContain('…')
  expect(stringWidth(lines[0]!)).toBeLessThanOrEqual(columns)
})
