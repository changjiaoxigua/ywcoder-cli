import { expect, test } from 'bun:test';
import { inputSchema } from './AgentTool.js';

const baseInput = {
  description: 'test task',
  prompt: 'do something',
};

test('isolation: "none" 被 preprocess 吞为 undefined，不报错', () => {
  const result = inputSchema().parse({ ...baseInput, isolation: 'none' });
  expect(result.isolation).toBeUndefined();
});

test('isolation: "" 被 preprocess 吞为 undefined，不报错', () => {
  const result = inputSchema().parse({ ...baseInput, isolation: '' });
  expect(result.isolation).toBeUndefined();
});

test('isolation: "worktree" 正常通过', () => {
  const result = inputSchema().parse({ ...baseInput, isolation: 'worktree' });
  expect(result.isolation).toBe('worktree');
});

test('isolation: false（非字符串）被守卫吞为 undefined，不炸 includes', () => {
  const result = inputSchema().parse({ ...baseInput, isolation: false });
  expect(result.isolation).toBeUndefined();
});

test('isolation: "remote" 在 external 构建下被白名单吞为 undefined（不报 invalid_enum_value）', () => {
  // external 构建的 enum 仅含 'worktree'，白名单动态跟随 enum，故 'remote' 被吞
  const result = inputSchema().parse({ ...baseInput, isolation: 'remote' });
  expect(result.isolation).toBeUndefined();
});

test('不传 isolation 时为 undefined', () => {
  const result = inputSchema().parse(baseInput);
  expect(result.isolation).toBeUndefined();
});
