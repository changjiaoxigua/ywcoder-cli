import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../../services/analytics/index.js'
import { sanitizeToolNameForAnalytics } from '../../../services/analytics/metadata.js'
import type { ToolPermissionContext } from '../../../Tool.js'
import { FILE_EDIT_TOOL_NAME } from '../../../tools/FileEditTool/constants.js'
import { getOriginalCwd } from '../../../bootstrap/state.js'
import { env } from '../../../utils/env.js'
import { generateSuggestions } from '../../../utils/permissions/filesystem.js'
import { getGlobalConfigPermissionPattern } from '../../../utils/permissions/globalConfigPattern.js'
import { getProjectConfigFolderPermissionPattern } from '../../../utils/projectConfigDir.js'
import type { PermissionUpdate } from '../../../utils/permissions/PermissionUpdateSchema.js'
import {
  type CompletionType,
  logUnaryEvent,
} from '../../../utils/unaryLogging.js'
import type { ToolUseConfirm } from '../PermissionRequest.js'
import type {
  FileOperationType,
  PermissionOption,
} from './permissionOptions.js'

function logPermissionEvent(
  event: 'accept' | 'reject',
  completionType: CompletionType,
  languageName: string | Promise<string>,
  messageId: string,
  hasFeedback?: boolean,
): void {
  void logUnaryEvent({
    completion_type: completionType,
    event,
    metadata: {
      language_name: languageName,
      message_id: messageId,
      platform: env.platform,
      hasFeedback: hasFeedback ?? false,
    },
  })
}

export type PermissionHandlerParams = {
  messageId: string
  path: string | null
  toolUseConfirm: ToolUseConfirm
  toolPermissionContext: ToolPermissionContext
  onDone: () => void
  onReject: () => void
  completionType: CompletionType
  languageName: string | Promise<string>
  operationType: FileOperationType
}

export type PermissionHandlerOptions = {
  hasFeedback?: boolean
  feedback?: string
  enteredFeedbackMode?: boolean
  scope?: 'claude-folder' | 'global-claude-folder'
}

function handleAcceptOnce(
  params: PermissionHandlerParams,
  options?: PermissionHandlerOptions,
): void {
  const { messageId, toolUseConfirm, onDone, completionType, languageName } =
    params

  logPermissionEvent('accept', completionType, languageName, messageId)

  // Log accept submission with feedback context
  logEvent('tengu_accept_submitted', {
    toolName: sanitizeToolNameForAnalytics(
      toolUseConfirm.tool.name,
    ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    isMcp: toolUseConfirm.tool.isMcp ?? false,
    has_instructions: !!options?.feedback,
    instructions_length: options?.feedback?.length ?? 0,
    entered_feedback_mode: options?.enteredFeedbackMode ?? false,
  })

  onDone()
  toolUseConfirm.onAllow(toolUseConfirm.input, [], options?.feedback)
}

function handleAcceptSession(
  params: PermissionHandlerParams,
  options?: PermissionHandlerOptions,
): void {
  const {
    messageId,
    path,
    toolUseConfirm,
    toolPermissionContext,
    onDone,
    completionType,
    languageName,
    operationType,
  } = params

  logPermissionEvent('accept', completionType, languageName, messageId)

  // For claude-folder scope, grant session-level access to all .claude/ files
  if (
    options?.scope === 'claude-folder' ||
    options?.scope === 'global-claude-folder'
  ) {
    // 项目级：按当前生效配置目录（flag ON→.ywcoder、OFF→.claude）生成规则，
    // 保证规则命中用户实际编辑的活跃目录。
    const pattern =
      options.scope === 'global-claude-folder'
        ? getGlobalConfigPermissionPattern()
        : getProjectConfigFolderPermissionPattern(getOriginalCwd())
    const suggestions: PermissionUpdate[] = [
      {
        type: 'addRules',
        rules: [
          {
            toolName: FILE_EDIT_TOOL_NAME,
            ruleContent: pattern,
          },
        ],
        behavior: 'allow',
        destination: 'session',
      },
    ]
    onDone()
    toolUseConfirm.onAllow(toolUseConfirm.input, suggestions)
    return
  }

  // Generate permission updates if path is provided
  const suggestions = path
    ? generateSuggestions(path, operationType, toolPermissionContext)
    : []

  onDone()
  // Pass permission updates directly to onAllow
  toolUseConfirm.onAllow(toolUseConfirm.input, suggestions)
}

function handleReject(
  params: PermissionHandlerParams,
  options?: PermissionHandlerOptions,
): void {
  const {
    messageId,
    toolUseConfirm,
    onDone,
    onReject,
    completionType,
    languageName,
  } = params

  logPermissionEvent(
    'reject',
    completionType,
    languageName,
    messageId,
    options?.hasFeedback,
  )

  // Log reject submission with feedback context
  logEvent('tengu_reject_submitted', {
    toolName: sanitizeToolNameForAnalytics(
      toolUseConfirm.tool.name,
    ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    isMcp: toolUseConfirm.tool.isMcp ?? false,
    has_instructions: !!options?.feedback,
    instructions_length: options?.feedback?.length ?? 0,
    entered_feedback_mode: options?.enteredFeedbackMode ?? false,
  })

  onDone()
  onReject()
  toolUseConfirm.onReject(options?.feedback)
}

export const PERMISSION_HANDLERS: Record<
  PermissionOption['type'],
  (params: PermissionHandlerParams, options?: PermissionHandlerOptions) => void
> = {
  'accept-once': handleAcceptOnce,
  'accept-session': handleAcceptSession,
  reject: handleReject,
}
