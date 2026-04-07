import { afterEach, expect, test } from 'bun:test'

import { getSystemPrompt, DEFAULT_AGENT_PROMPT } from './prompts.js'
import { CLI_SYSPROMPT_PREFIXES, getCLISyspromptPrefix } from './system.js'
import { GENERAL_PURPOSE_AGENT } from '../tools/AgentTool/built-in/generalPurposeAgent.js'
import { EXPLORE_AGENT } from '../tools/AgentTool/built-in/exploreAgent.js'
import { getYwCoderEnv } from '../utils/envUtils.js'

const originalSimpleEnv = getYwCoderEnv('SIMPLE')

afterEach(() => {
  process.env.YWCODER_SIMPLE = process.env.CLAUDE_CODE_SIMPLE = originalSimpleEnv
})

test('CLI identity prefixes describe YwCoder instead of Claude Code', () => {
  expect(getCLISyspromptPrefix()).toContain('YwCoder')
  expect(getCLISyspromptPrefix()).not.toContain("Anthropic's official CLI for Claude")

  for (const prefix of CLI_SYSPROMPT_PREFIXES) {
    expect(prefix).toContain('YwCoder')
    expect(prefix).not.toContain("Anthropic's official CLI for Claude")
  }
})

test('simple mode identity describes YwCoder instead of Claude Code', async () => {
  process.env.YWCODER_SIMPLE = process.env.CLAUDE_CODE_SIMPLE = '1'

  const prompt = await getSystemPrompt([], 'gpt-4o')

  expect(prompt[0]).toContain('YwCoder')
  expect(prompt[0]).not.toContain("Anthropic's official CLI for Claude")
})

test('built-in agent prompts describe YwCoder instead of Claude Code', () => {
  expect(DEFAULT_AGENT_PROMPT).toContain('YwCoder')
  expect(DEFAULT_AGENT_PROMPT).not.toContain("Anthropic's official CLI for Claude")

  const generalPrompt = GENERAL_PURPOSE_AGENT.getSystemPrompt({
    toolUseContext: { options: {} as never },
  })
  expect(generalPrompt).toContain('YwCoder')
  expect(generalPrompt).not.toContain("Anthropic's official CLI for Claude")

  const explorePrompt = EXPLORE_AGENT.getSystemPrompt({
    toolUseContext: { options: {} as never },
  })
  expect(explorePrompt).toContain('YwCoder')
  expect(explorePrompt).not.toContain("Anthropic's official CLI for Claude")
})
