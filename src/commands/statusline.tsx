import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/index.mjs';
import type { Command } from '../commands.js';
import { AGENT_TOOL_NAME } from '../tools/AgentTool/constants.js';
import { getConfigHomeDisplayPath } from '../utils/envUtils.js';
const _configHome = getConfigHomeDisplayPath();
const statusline = {
  type: 'prompt',
  description: '配置 YwCoder 的状态栏 UI',
  contentLength: 0,
  // Dynamic content
  aliases: [],
  name: 'statusline',
  progressMessage: '正在配置状态栏',
  allowedTools: [AGENT_TOOL_NAME, 'Read(~/**)', `Edit(${_configHome}/settings.json)`],
  source: 'builtin',
  disableNonInteractive: true,
  async getPromptForCommand(args): Promise<ContentBlockParam[]> {
    const prompt = args.trim() || 'Configure my statusLine from my shell PS1 configuration';
    return [{
      type: 'text',
      text: `Create an ${AGENT_TOOL_NAME} with subagent_type "statusline-setup" and the prompt "${prompt}"`
    }];
  }
} satisfies Command;
export default statusline;
