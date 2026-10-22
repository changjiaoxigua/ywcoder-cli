import * as React from 'react'
import { Box, Text } from '../../ink.js'

/** 更新提示独占一行，窄终端下截断，避免与其他通知争用宽度后逐字换行。 */
export function YwUpdateNotice({ latestVersion }: { latestVersion: string }): React.ReactNode {
  return <Box width="100%" paddingX={2} flexShrink={0}>
    <Text color="yellow" wrap="truncate">可更新至 {latestVersion} · ywcoder update</Text>
  </Box>
}
