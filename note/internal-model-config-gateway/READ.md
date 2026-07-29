# Feature: 内网模型能力参数网关自报告

## 1. 当前状态

Status: Completed in v1  
Date: 2026-05-06

本功能已完成 v1 实现：CLI 启动时从网关 `/v1/models` 自动拉取 `context_length`，写入 `additionalModelOptionsCache`，后续请求按该值计算上下文窗口与自动压缩阈值。

## 2. 最终采纳方案

最终采用“网关自报告”方案，而不是“用户手动维护 models-config.json”方案。

原因：

- 网关是模型部署方，最清楚模型真实上下文窗口；
- 用户不需要手动维护模型能力参数；
- 新模型上线或参数变更后，网关侧更新即可；
- CLI 下次启动自动同步。

## 3. 文档索引

| 文档                                                                 | 状态       | 用途                                                 |
| -------------------------------------------------------------------- | ---------- | ---------------------------------------------------- |
| `01-internal-mode-config-redesign-2026-04-27.md`                     | Accepted   | 最终设计方案                                         |
| `03-internal-model-config-gateway-reporting-test-plan-2026-04-30.md` | Active     | 团队理解需求和验收测试依据                           |
| `02-internal-model-config-impl-plan-2026-04-30.md`                   | Completed  | 执行 agent 的任务分解与落地记录                      |
| `04-internal-model-implementation-summary-0506`                      | Final      | 实施结果、遗留问题、后续计划                         |
| `00-internal-model-config-gateway-redesign-superseded-2026-04-27`    | Superseded | 被替代的早期方案，保留历史判断，以及请求链路分析追溯 |

## 4. v1 已实现范围

- 解析 `/v1/models` 返回的 `context_length`
- 将 `context_length` 转换为 CLI 内部的 `contextWindow`
- 写入 `additionalModelOptionsCache`
- `getContextWindowForModel()` 优先读取缓存
- 去除 `CLAUDE_CODE_MAX_CONTEXT_TOKENS` 的 `USER_TYPE='ant'` 门禁
- `/doctor` 增加 Model Capabilities 诊断段落

## 5. v1 不做范围

- 不实现 `models-config.json` 手动配置层
- 不改 `/model` 命令刷新链路
- 不改 `getModelMaxOutputTokens()`
- 不监听 `context_length_exceeded` 触发实时刷新

## 6. 已知限制

- 首次启动时，bootstrap 尚未完成前的首个请求可能仍使用 200K fallback；
- 同会话内切换 profile 不主动刷新 `contextWindow`；
- bootstrap 失败时主要依赖 `/doctor` 观察状态。

## 7. 后续 v2 候选

- profile 切换后自动触发 `fetchBootstrapData()`
- `/doctor` 中增加更实时的缓存刷新状态
- 必要时评估 `max_output_tokens` 自报告字段
