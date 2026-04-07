/**
 * OpenClaude startup screen — clean YW logo.
 * Uses 256-color codes for broad terminal compatibility (including macOS Terminal.app).
 */

import { isLocalProviderUrl } from '../services/api/providerConfig.js'
import { getYwCoderEnv } from '../utils/envUtils.js'
import { getLocalOpenAICompatibleProviderLabel } from '../utils/providerDiscovery.js'

declare const MACRO: { VERSION: string; DISPLAY_VERSION?: string }

const ESC = '\x1b['
const RESET  = `${ESC}0m`
const DIM    = `${ESC}2m`
const BOLD   = `${ESC}1m`

// 256-color foreground: \x1b[38;5;Nm
const c = (n: number) => `${ESC}38;5;${n}m`

// Palette (256-color, works on macOS Terminal.app + all modern terminals)
const COL_LOGO    = c(167)  // Indian Red  — warm rose
const COL_ACCENT  = c(173)  // LightSalmon — tagline / bullet / version
const COL_LABEL   = c(244)  // medium gray — Provider / Model / Endpoint keys
const COL_VALUE   = c(252)  // light gray  — values
const COL_BORDER  = c(238)  // dark gray   — box lines
const COL_DIM     = c(240)  // dimmer gray — cloud/local, dimmed text
const COL_LOCAL   = c(108)  // sage green  — local provider

// Single-line box-drawing chars (safe on all terminals)
const H = '\u2500'  // ─
const TL = '\u250c' // ┌
const TR = '\u2510' // ┐
const BL = '\u2514' // └
const BR = '\u2518' // ┘
const LM = '\u251c' // ├
const RM = '\u2524' // ┤
const V  = '\u2502' // │

// ─── YW Block Logo ───────────────────────────────────────────────────────────
// '#' chars are replaced with U+2588 (█) which renders as a solid block.
// Only foreground color is set — no background — so no color bleed.

const LOGO_LINES = [
  ' ##   ##  ##       ##',
  '  ## ##   ##       ##',
  '   ###    ## ## ## ##',
  '   ##      ###  ###  ',
  '   ##      ###  ###  ',
].map(line => line.replace(/#/g, '\u2588'))

// ─── Provider detection ───────────────────────────────────────────────────────

function detectProvider(): { name: string; model: string; baseUrl: string; isLocal: boolean } {
  const useGemini = getYwCoderEnv('USE_GEMINI') === '1' || getYwCoderEnv('USE_GEMINI') === 'true'
  const useGithub = getYwCoderEnv('USE_GITHUB') === '1' || getYwCoderEnv('USE_GITHUB') === 'true'
  const useOpenAI = getYwCoderEnv('USE_OPENAI') === '1' || getYwCoderEnv('USE_OPENAI') === 'true'

  if (useGemini) {
    return {
      name: 'Google Gemini',
      model: process.env.GEMINI_MODEL || 'gemini-2.0-flash',
      baseUrl: process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai',
      isLocal: false,
    }
  }

  if (useGithub) {
    return {
      name: 'GitHub Models',
      model: process.env.OPENAI_MODEL || 'github:copilot',
      baseUrl: process.env.OPENAI_BASE_URL || 'https://models.github.ai/inference',
      isLocal: false,
    }
  }

  if (useOpenAI) {
    const rawModel = process.env.OPENAI_MODEL || 'gpt-4o'
    const baseUrl = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'
    const isLocal = isLocalProviderUrl(baseUrl)
    let name = 'OpenAI'
    if (/deepseek/i.test(baseUrl) || /deepseek/i.test(rawModel))   name = 'DeepSeek'
    else if (/openrouter/i.test(baseUrl))                          name = 'OpenRouter'
    else if (/together/i.test(baseUrl))                            name = 'Together AI'
    else if (/groq/i.test(baseUrl))                                name = 'Groq'
    else if (/mistral/i.test(baseUrl) || /mistral/i.test(rawModel)) name = 'Mistral'
    else if (/azure/i.test(baseUrl))                               name = 'Azure OpenAI'
    else if (/llama/i.test(rawModel))                              name = 'Meta Llama'
    else if (isLocal)                                              name = getLocalOpenAICompatibleProviderLabel(baseUrl)

    // Resolve model aliases
    let displayModel = rawModel
    const aliases: Record<string, { model: string; reasoningEffort?: string }> = {
      codexplan:              { model: 'gpt-5.4', reasoningEffort: 'high' },
      'gpt-5.4':             { model: 'gpt-5.4', reasoningEffort: 'high' },
      'gpt-5.3-codex':       { model: 'gpt-5.3-codex', reasoningEffort: 'high' },
      'gpt-5.3-codex-spark': { model: 'gpt-5.3-codex-spark' },
      codexspark:            { model: 'gpt-5.3-codex-spark' },
      'gpt-5.2-codex':       { model: 'gpt-5.2-codex', reasoningEffort: 'high' },
      'gpt-5.1-codex-max':   { model: 'gpt-5.1-codex-max', reasoningEffort: 'high' },
      'gpt-5.1-codex-mini':  { model: 'gpt-5.1-codex-mini' },
      'gpt-5.4-mini':        { model: 'gpt-5.4-mini', reasoningEffort: 'medium' },
      'gpt-5.2':             { model: 'gpt-5.2', reasoningEffort: 'medium' },
    }
    const resolved = aliases[rawModel.toLowerCase()]
    if (resolved) {
      displayModel = resolved.reasoningEffort
        ? `${resolved.model} (${resolved.reasoningEffort})`
        : resolved.model
    }

    return { name, model: displayModel, baseUrl, isLocal }
  }

  return {
    name: 'Anthropic',
    model: process.env.ANTHROPIC_MODEL || process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
    baseUrl: 'https://api.anthropic.com',
    isLocal: false,
  }
}

// ─── Box helpers ─────────────────────────────────────────────────────────────

function hLine(w: number): string {
  return `${COL_BORDER}${H.repeat(w)}${RESET}`
}

function boxRow(inner: string, innerRawLen: number, boxW: number): string {
  const pad = Math.max(0, boxW - 2 - innerRawLen)
  return `${COL_BORDER}${V}${RESET}${inner}${' '.repeat(pad)}${COL_BORDER}${V}${RESET}`
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export function printStartupScreen(): void {
  if (process.env.CI || !process.stdout.isTTY) return

  const p = detectProvider()
  const W = 50  // total box width including side borders
  const out: string[] = []

  out.push('')

  // YW logo — single color, no per-character gradient (avoids color issues)
  for (const line of LOGO_LINES) {
    out.push(`  ${COL_LOGO}${line}${RESET}`)
  }

  out.push('')

  // Tagline
  out.push(
    `  ${COL_ACCENT}\u2726${RESET} ${COL_VALUE}数据中心·运维支持部出品 ｜ 智能编码，无限可能${RESET} ${COL_ACCENT}\u2726${RESET}`
  )
  out.push('')

  // ┌── info box ──┐
  out.push(`  ${COL_BORDER}${TL}${H.repeat(W - 2)}${TR}${RESET}`)

  const row = (key: string, val: string, valColor = COL_VALUE): void => {
    const k = key.padEnd(10)
    const inner = ` ${COL_LABEL}${k}${RESET}${valColor}${val}${RESET}`
    const rawLen = ` ${k}${val}`.length
    out.push(`  ${boxRow(inner, rawLen, W)}`)
  }

  row('Provider', p.name, p.isLocal ? COL_LOCAL : COL_ACCENT)
  row('Model',    p.model)
  const ep = p.baseUrl.length > 32 ? p.baseUrl.slice(0, 29) + '...' : p.baseUrl
  row('Endpoint', ep)

  // ├── divider ──┤
  out.push(`  ${COL_BORDER}${LM}${H.repeat(W - 2)}${RM}${RESET}`)

  // status row
  const sColor = p.isLocal ? COL_LOCAL : COL_ACCENT
  const sLabel = p.isLocal ? 'local' : 'cloud'
  const statusInner =
    ` ${sColor}\u25cf${RESET} ${COL_DIM}${sLabel}${RESET}` +
    `    ${COL_DIM}Ready \u2014 type ${RESET}${COL_ACCENT}/help${RESET}${COL_DIM} to begin${RESET}`
  const statusRaw = ` \u25cf ${sLabel}    Ready \u2014 type /help to begin`.length
  out.push(`  ${boxRow(statusInner, statusRaw, W)}`)

  // └────────────┘
  out.push(`  ${COL_BORDER}${BL}${H.repeat(W - 2)}${BR}${RESET}`)

  // version footer
  const ver = MACRO.DISPLAY_VERSION ?? MACRO.VERSION
  out.push(`  ${DIM}${COL_DIM}ywcoder${RESET} ${COL_ACCENT}v${ver}${RESET}`)
  out.push('')

  process.stdout.write(out.join('\n') + '\n')
}
