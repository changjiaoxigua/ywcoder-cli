import { expect, test } from 'bun:test'
import { sanitizeSchemaForOpenAICompat } from './schemaSanitizer.ts'

// 回归测试：早期 stripSchemaKeywords 会把 OpenAI 不兼容关键字（pattern、format、
// default 等）无差别递归删除，导致 properties 下恰好同名的「字段名」也被删掉。
// 典型受害者是 Grep 工具的 pattern 字段，被删后模型不知道要传该参数而反复报错。
// 详见 note/ISSUE-schemaSanitizer-pattern-field-missing-2026-06-01.md

test('保留 properties 下名为 pattern 的字段，同时删除字段内部的 pattern 约束关键字', () => {
  const grepLikeSchema = {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        // 这是 JSON Schema 的 pattern 正则约束关键字，OpenAI 不兼容，应删除
        pattern: '^[a-z]+$',
      },
      path: {
        type: 'string',
      },
    },
    required: ['pattern'],
    additionalProperties: false,
  }

  const result = sanitizeSchemaForOpenAICompat(grepLikeSchema)
  const props = result.properties as Record<string, Record<string, unknown>>

  // 字段名 pattern 必须保留，否则模型不知道该参数存在
  expect('pattern' in props).toBe(true)
  // 字段内部的 pattern 约束关键字必须被删除
  expect('pattern' in props.pattern).toBe(false)
  expect(props.pattern.type).toBe('string')
  // required 中的 pattern 也应保留
  expect(result.required).toContain('pattern')
})

test('保留嵌套对象参数中名为 pattern 的字段，并删除其内部约束', () => {
  const nestedSchema = {
    type: 'object',
    properties: {
      config: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            pattern: '^y$',
          },
        },
      },
    },
  }

  const result = sanitizeSchemaForOpenAICompat(nestedSchema)
  const inner = (
    (result.properties as Record<string, Record<string, unknown>>).config
      .properties as Record<string, Record<string, unknown>>
  ).pattern

  expect(inner).toBeDefined()
  expect('pattern' in inner).toBe(false)
  expect(inner.type).toBe('string')
})

test('字段名恰好为 properties 时，字段内部的关键字仍被正常清理（不依赖外层第二遍兜底）', () => {
  const schema = {
    type: 'object',
    properties: {
      // 字段名就叫 properties
      properties: {
        type: 'string',
        pattern: '^x$',
      },
    },
    required: ['properties'],
  }

  const result = sanitizeSchemaForOpenAICompat(schema)
  const props = result.properties as Record<string, Record<string, unknown>>

  // 字段名 properties 必须保留
  expect('properties' in props).toBe(true)
  // 字段内部的 pattern 约束关键字必须被删除
  expect('pattern' in props.properties).toBe(false)
  expect(props.properties.type).toBe('string')
})

test('顶层及普通层级的 pattern 等不兼容关键字仍被正常删除', () => {
  const schema = {
    type: 'string',
    pattern: '^top$',
    format: 'email',
    minLength: 1,
  }

  const result = sanitizeSchemaForOpenAICompat(schema)

  expect('pattern' in result).toBe(false)
  expect('format' in result).toBe(false)
  expect('minLength' in result).toBe(false)
  expect(result.type).toBe('string')
})
