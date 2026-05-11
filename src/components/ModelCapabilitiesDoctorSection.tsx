// 2026-04-30 内网网关 context_length 自报告特性——/doctor 诊断段落
import React from 'react'
import { Box, Text } from '../ink.js'
import { isLocalProviderUrl } from '../services/api/providerConfig.js'
import { getGlobalConfig } from '../utils/config.js'

/**
 * 在 /doctor 中展示网关自报告的模型能力缓存状态。
 * 仅在 OpenAI 兼容 provider（scope 以 openai: 开头）时渲染，其他 provider 返回 null。
 * 2026-04-30 内网网关 context_length 自报告特性新增
 * 2026-05-10 方案A：内网环境下增加"已过滤硬编码预设模型"提示
 */
export function ModelCapabilitiesDoctorSection(): React.ReactElement | null {
  const config = getGlobalConfig()
  const scope = config.additionalModelOptionsCacheScope

  // 非 OpenAI 兼容 provider 不展示此段落
  if (!scope?.startsWith('openai:')) {
    return null
  }

  const cache = config.additionalModelOptionsCache ?? []
  const withWindow = cache.filter(m => m.contextWindow && m.contextWindow > 0)

  // 2026-05-10 方案A：内网环境下判断是否过滤了硬编码预设模型
  const isLocal = isLocalProviderUrl(scope.replace('openai:', ''))

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>Model Capabilities</Text>
      <Text>└ 来源: {scope}</Text>
      {isLocal && cache.length > 0 && (
        // 2026-05-10 方案A：内网环境提示已过滤硬编码预设模型
        <Text dimColor>
          └ 内网模式：已过滤硬编码预设模型，仅展示网关发现模型
        </Text>
      )}
      {isLocal && cache.length === 0 && (
        // 2026-05-10 方案A：内网环境无可用模型时给出警告
        <Text color="warning">
          └ 内网模式：未从网关发现可用模型，/model 列表为空
        </Text>
      )}
      <Text>
        └ 缓存状态:{' '}
        {cache.length === 0 ? (
          // 2026-04-30 v1 接受首次打开后不自动刷新的限制，通过文案引导手动刷新
          <Text color="warning">
            未加载（bootstrap 仍在进行 / 网关不可达 / 启动时未配置 OpenAI 兼容 provider）；
            若启动时间已超过 10 秒，请退出后重新执行 /doctor 查看刷新后的状态
          </Text>
        ) : (
          <Text color="green">
            已加载 {cache.length} 个模型，其中 {withWindow.length} 个含 context_length
          </Text>
        )}
      </Text>
      {cache.map(model => (
        <Text key={model.value} dimColor>
          {'  '}└ {model.value}:{' '}
          {model.contextWindow
            ? `context_length=${model.contextWindow}`
            : '未提供 context_length → fallback 到硬编码表或 200K 默认值'}
        </Text>
      ))}
    </Box>
  )
}
