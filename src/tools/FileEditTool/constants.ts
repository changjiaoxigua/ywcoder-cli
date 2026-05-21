// In its own file to avoid circular dependencies
export const FILE_EDIT_TOOL_NAME = 'Edit'

// Permission pattern for granting session-level access to the project's .claude/ folder
export const CLAUDE_FOLDER_PERMISSION_PATTERN = '/.claude/**'

// 注意：全局配置文件夹的 glob 模式不再以常量形式暴露——
// 因为它会跟随 getYwCoderConfigHomeDir() 动态变化。请改用
// src/utils/permissions/globalConfigPattern.ts 中的：
//   - getGlobalConfigPermissionPattern()  // 用于"写"新规则
//   - getGlobalConfigCompatPrefixes()     // 用于"读"匹配存量规则

export const FILE_UNEXPECTEDLY_MODIFIED_ERROR =
  'File has been unexpectedly modified. Read it again before attempting to write it.'
