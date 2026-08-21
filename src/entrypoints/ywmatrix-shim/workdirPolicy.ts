/**
 * P2 —— 会话级工作目录（v3 §6.1.2 + 契约确认 5）。
 *
 * 信任模型（C5，已定稿）：内网统一网关，`metadata.workdir` 只来自用户在
 * Client 的目录选择，不引入 allowed-root 配置。shim 的职责是：
 * 1. 校验绝对路径、存在性、目录类型，并用 realpath 规范化（macOS /tmp 符号链接坑）；
 * 2. 首个任务绑定会话 workdir，之后不可变——不一致返回 -32602；
 * 3. ywcoder 会话文件按工作目录分桶，存在性判断必须按「本 session 的 workdir」
 *    推导分桶，而不是 shim 进程 cwd（sessionIdExistsIn）。
 */
import { existsSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { getProjectDir } from '../../utils/sessionStorage.js'

export type WorkdirValidation =
  | { ok: true; workdir: string }
  | { ok: false; reason: string }

/**
 * 校验并规范化 workdir。通过时返回 realpath 后的路径（之后一律用规范化值
 * 做分桶与 spawn cwd，避免同一目录的符号链接变体被判成两个会话）。
 */
export function validateWorkdir(raw: string): WorkdirValidation {
  if (!raw || !isAbsolute(raw)) {
    return { ok: false, reason: `workdir 必须是绝对路径：${raw}` }
  }
  let real: string
  try {
    real = realpathSync(raw)
  } catch {
    return { ok: false, reason: `workdir 不存在或不可访问：${raw}` }
  }
  try {
    if (!statSync(real).isDirectory()) {
      return { ok: false, reason: `workdir 不是目录：${raw}` }
    }
  } catch {
    return { ok: false, reason: `workdir 不可访问：${raw}` }
  }
  return { ok: true, workdir: real }
}

/**
 * 在指定 workdir 的分桶下判断 session_id 是否已有会话文件。
 * 与 ywcoder 完全一致的分桶推导（getProjectDir 内部 realpath+sanitize 语义，
 * 入参已 realpath 规范化），只是 cwd 从「进程当前目录」换成「本 session 的
 * workdir」——ywcoder 源码零改动。
 */
export function sessionIdExistsIn(sessionId: string, workdir: string): boolean {
  const projectDir = getProjectDir(workdir)
  return existsSync(join(projectDir, `${sessionId}.jsonl`))
}
