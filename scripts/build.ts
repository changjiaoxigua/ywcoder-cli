/**
 * OpenClaude build script — bundles the TypeScript source into a single
 * distributable JS file using Bun's bundler.
 *
 * Handles:
 * - bun:bundle feature() flags for the open build
 * - MACRO.* globals → inlined version/build-time constants
 * - src/ path aliases
 */

import { readFileSync, existsSync } from 'fs'
import { execSync } from 'child_process'
import { noTelemetryPlugin } from './no-telemetry-plugin'

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'))
const version = pkg.version

// 构建期元数据：git sha、build id、build channel、版本号后缀
// CI 环境下由 workflow 注入环境变量；本地开发时使用默认值
const gitSha = (() => {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim()
  } catch {
    return 'unknown'
  }
})()
const buildId = process.env.GITHUB_RUN_NUMBER ?? 'local'
const buildChannel = process.env.BUILD_CHANNEL ?? 'local'
const versionSuffix = process.env.VERSION_SUFFIX ?? ''
const displayVersion = version + versionSuffix

// Feature flags for the open build.
// Most Anthropic-internal features stay off; open-build features can be
// selectively enabled here when their full source exists in the mirror.
const featureFlags: Record<string, boolean> = {
  VOICE_MODE: false,
  PROACTIVE: false,
  KAIROS: false,
  BRIDGE_MODE: false,
  DAEMON: false,
  AGENT_TRIGGERS: false,
  MONITOR_TOOL: false,
  ABLATION_BASELINE: false,
  DUMP_SYSTEM_PROMPT: false,
  CACHED_MICROCOMPACT: false,
  COORDINATOR_MODE: false,
  CONTEXT_COLLAPSE: false,
  COMMIT_ATTRIBUTION: false,
  TEAMMEM: false,
  UDS_INBOX: false,
  BG_SESSIONS: false,
  AWAY_SUMMARY: false,
  TRANSCRIPT_CLASSIFIER: false,
  WEB_BROWSER_TOOL: false,
  MESSAGE_ACTIONS: false,
  BUDDY: true,
  CHICAGO_MCP: false,
  COWORKER_TYPE_TELEMETRY: false,
  // A+B 组安全增量功能（修复 explore/plan agent + 纯 UI/交互增量）
  BUILTIN_EXPLORE_PLAN_AGENTS: true,
  // AUTO_THEME 暂关：其启用分支 import('../../utils/systemThemeWatcher.js')，该模块未在本
  // mirror 中（feature 机制修复后实测构建失败 Could not resolve）。补齐源文件后方可置 true。
  AUTO_THEME: false,
  NATIVE_CLIPBOARD_IMAGE: true,
  QUICK_SEARCH: true,
  HISTORY_PICKER: true,
  MCP_RICH_OUTPUT: true,
  COMPACTION_REMINDERS: true,
  POWERSHELL_AUTO_MODE: true,
  HOOK_PROMPTS: true,
  // D7 项目级配置目录迁移（.claude/ → .ywcoder/）总开关。**默认 ON**：启动期把存量
  // .claude/ 整目录 copy-keep 迁到 .ywcoder/（原 .claude/ 保留作备份），之后读写走 .ywcoder/。
  // 简化发布（默认构建即含迁移，避免漏带 flag 打出 OFF 包）并方便测试 .ywcoder 生效。
  // 退路：如需与官方 Claude Code **纯共用 .claude/**（不生成 .ywcoder/、不动 .gitignore），
  // 显式 `MIGRATE_PROJECT_CONFIG=false`（或 0）构建即回到旧行为，迁移分支经 DCE 删除。
  // 注意：这是**构建时** env（在此读、烤进 bundle 的 features），运行时代码不读任何 env。
  MIGRATE_PROJECT_CONFIG: !['false', '0'].includes(
    process.env.MIGRATE_PROJECT_CONFIG ?? '',
  ),
}

// Bun 1.3.11 起 `feature()` / `bun:bundle` 是 Bun **原生**编译期 intrinsic（报错串就在 bun
// 二进制里、类型见 bun-types/bundle.d.ts）。它的真值只来自 `Bun.build({ features })`（或 CLI
// `--feature`），**不读**下方 onLoad shim 注入的 featureFlags 函数——故历史上 shim 实际从未生效，
// 所有 feature() 一律烤成 false。这里把 featureFlags 中为 true 的键收集成数组传给 Bun.build，
// 让 feature() 真正按上面的配置折叠（已用最小复现验证 features:['X'] → feature('X')===true）。
const enabledFeatures = Object.entries(featureFlags)
  .filter(([, enabled]) => enabled)
  .map(([name]) => name)

// 两个构建目标（cli 主程序 / ywmatrix-shim）共用同一套 feature() shim、桩模块、
// MACRO.* 常量——ywmatrix-shim 内部 import 了 sessionStorage.ts/*Schemas.ts，
// 这些文件里透传的 feature() macro 必须走同一个 Bun.build({features}) 才不会
// 被折叠成 false（见 note/feature_ywmatrix/docs/shim-build-plan.md §2）。
async function buildTarget(opts: {
  entrypoints: string[]
  naming: string
  label: string
  banner?: string
  extraDefine?: Record<string, string>
}) {
  const result = await Bun.build({
  entrypoints: opts.entrypoints,
  outdir: './dist',
  target: 'node',
  format: 'esm',
  splitting: false,
  features: enabledFeatures,
  sourcemap: process.env.CI ? 'none' : 'external',
  minify: !!process.env.CI,
  naming: opts.naming,
  banner: opts.banner,
  define: {
    // MACRO.* 构建时常量
    // MACRO.VERSION 保持 99.0.0 用于绕过 first-party min-version 检查，严禁修改
    // MACRO.DISPLAY_VERSION 为用户可见的真实版本号（含 channel 后缀）
    'MACRO.VERSION': JSON.stringify('99.0.0'),
    'MACRO.DISPLAY_VERSION': JSON.stringify(displayVersion),
    'MACRO.GIT_SHA': JSON.stringify(gitSha),
    'MACRO.BUILD_ID': JSON.stringify(buildId),
    'MACRO.BUILD_CHANNEL': JSON.stringify(buildChannel),
    'MACRO.BUILD_TIME': JSON.stringify(new Date().toISOString()),
    'MACRO.ISSUES_EXPLAINER':
      JSON.stringify('report the issue to your YwCoder administrator'),
    'MACRO.PACKAGE_URL': JSON.stringify('@dcywzc/ywcoder'),
    'MACRO.NATIVE_PACKAGE_URL': 'undefined',
    ...opts.extraDefine,
  },
  plugins: [
    noTelemetryPlugin,
    {
      name: 'bun-bundle-shim',
      setup(build) {
        const internalFeatureStubModules = new Map([
          [
            '../daemon/workerRegistry.js',
            'export async function runDaemonWorker() { throw new Error("Daemon worker is unavailable in the open build."); }',
          ],
          [
            '../daemon/main.js',
            'export async function daemonMain() { throw new Error("Daemon mode is unavailable in the open build."); }',
          ],
          [
            '../cli/bg.js',
            `
export async function psHandler() { throw new Error("Background sessions are unavailable in the open build."); }
export async function logsHandler() { throw new Error("Background sessions are unavailable in the open build."); }
export async function attachHandler() { throw new Error("Background sessions are unavailable in the open build."); }
export async function killHandler() { throw new Error("Background sessions are unavailable in the open build."); }
export async function handleBgFlag() { throw new Error("Background sessions are unavailable in the open build."); }
`,
          ],
          [
            '../cli/handlers/templateJobs.js',
            'export async function templatesMain() { throw new Error("Template jobs are unavailable in the open build."); }',
          ],
          [
            '../environment-runner/main.js',
            'export async function environmentRunnerMain() { throw new Error("Environment runner is unavailable in the open build."); }',
          ],
          [
            '../self-hosted-runner/main.js',
            'export async function selfHostedRunnerMain() { throw new Error("Self-hosted runner is unavailable in the open build."); }',
          ],
        ] as const)

        // Resolve `import { feature } from 'bun:bundle'` to a shim
        build.onResolve({ filter: /^bun:bundle$/ }, () => ({
          path: 'bun:bundle',
          namespace: 'bun-bundle-shim',
        }))
        build.onLoad(
          { filter: /.*/, namespace: 'bun-bundle-shim' },
          () => ({
            contents: `const featureFlags = ${JSON.stringify(featureFlags)};\nexport function feature(name) { return featureFlags[name] ?? false; }`,
            loader: 'js',
          }),
        )

        build.onResolve(
          { filter: /^\.\.\/(daemon\/workerRegistry|daemon\/main|cli\/bg|cli\/handlers\/templateJobs|environment-runner\/main|self-hosted-runner\/main)\.js$/ },
          args => {
            if (!internalFeatureStubModules.has(args.path)) return null
            return {
              path: args.path,
              namespace: 'internal-feature-stub',
            }
          },
        )
        build.onLoad(
          { filter: /.*/, namespace: 'internal-feature-stub' },
          args => ({
            contents:
              internalFeatureStubModules.get(args.path) ??
              'export {}',
            loader: 'js',
          }),
        )

        // Resolve react/compiler-runtime to the standalone package
        build.onResolve({ filter: /^react\/compiler-runtime$/ }, () => ({
          path: 'react/compiler-runtime',
          namespace: 'react-compiler-shim',
        }))
        build.onLoad(
          { filter: /.*/, namespace: 'react-compiler-shim' },
          () => ({
            contents: `export function c(size) { return new Array(size).fill(Symbol.for('react.memo_cache_sentinel')); }`,
            loader: 'js',
          }),
        )

        // NOTE: @opentelemetry/* kept as external deps (too many named exports to stub)

        // ─── 云服务商 SDK 桩模块 ───────────────────────────────────────────────
        //
        // 修改日期：2025-04-11
        //
        // 背景：这些 SDK 用于通过 AWS Bedrock、Google Vertex AI 或 Azure 调用
        // Claude 模型。内网环境统一使用自建 LLM 网关，这些代码路径不会被执行。
        // 将其替换为桩模块后，可从 node_modules 中移除约 35 MB，保持离线 tgz 体积精简。
        //
        // 所有导入均为动态 `await import(...)`，只有用户主动配置对应 provider
        // 时才会触发。触发后会抛出明确的"不支持"错误，而不是难以定位的
        // module-not-found 崩溃。
        //
        // 如何恢复云服务商 SDK 支持：
        //   1. 删除下方所有 onResolve/onLoad 块。
        //   2. 取消注释 external 数组中的对应包（见文件底部）。
        //   3. 在 scripts/prepare-offline-pack.mjs 的 RUNTIME_DEPENDENCIES
        //      中重新添加这些包。
        //   4. 重新跑 CI，完整 SDK 将从 node_modules 打包进 cli.mjs。
        //
        // 涉及源文件：
        //   src/utils/model/bedrock.ts   — AWS Bedrock 客户端
        //   src/utils/aws.ts             — STS 身份验证 + 凭证缓存
        //   src/utils/proxy.ts           — AWS credential-provider-node
        //   src/utils/geminiAuth.ts      — Google Vertex AI 认证
        //   src/utils/auth.ts            — Google 认证兜底逻辑

        // AWS Bedrock 主客户端
        build.onResolve({ filter: /^@aws-sdk\/client-bedrock$/ }, args => ({
          path: args.path, namespace: 'cloud-sdk-stub',
        }))
        // AWS Bedrock 运行时客户端
        build.onResolve({ filter: /^@aws-sdk\/client-bedrock-runtime$/ }, args => ({
          path: args.path, namespace: 'cloud-sdk-stub',
        }))
        // AWS STS 身份验证
        build.onResolve({ filter: /^@aws-sdk\/client-sts$/ }, args => ({
          path: args.path, namespace: 'cloud-sdk-stub',
        }))
        // AWS 凭证提供者
        build.onResolve({ filter: /^@aws-sdk\/credential-providers$/ }, args => ({
          path: args.path, namespace: 'cloud-sdk-stub',
        }))
        // AWS Node.js 凭证提供者
        build.onResolve({ filter: /^@aws-sdk\/credential-provider-node$/ }, args => ({
          path: args.path, namespace: 'cloud-sdk-stub',
        }))
        // Google 认证库（用于 Vertex AI）
        build.onResolve({ filter: /^google-auth-library$/ }, args => ({
          path: args.path, namespace: 'cloud-sdk-stub',
        }))

        build.onLoad({ filter: /.*/, namespace: 'cloud-sdk-stub' }, (args) => {
          const stubs: Record<string, string> = {
            '@aws-sdk/client-bedrock': `
const err = () => { throw new Error('[YwCoder] 当前内网构建不支持 AWS Bedrock provider。如需启用，请删除 scripts/build.ts 中的云服务商 SDK 桩模块并重新构建。'); };
export class BedrockClient { constructor() { err(); } send() { err(); } }
export class ListInferenceProfilesCommand { constructor() { err(); } }
export class GetInferenceProfileCommand { constructor() { err(); } }
`,
            '@aws-sdk/client-bedrock-runtime': `
const err = () => { throw new Error('[YwCoder] 当前内网构建不支持 AWS Bedrock provider。如需启用，请删除 scripts/build.ts 中的云服务商 SDK 桩模块并重新构建。'); };
export class BedrockRuntimeClient { constructor() { err(); } send() { err(); } }
export class CountTokensCommand { constructor() { err(); } }
export class InvokeModelCommand { constructor() { err(); } }
export class InvokeModelWithResponseStreamCommand { constructor() { err(); } }
export const ResponseStream = {};
// 以下 Exception 类由 @anthropic-ai/bedrock-sdk/AWS_restJson1.mjs 引用，必须导出
export class InternalServerException extends Error { constructor(opts) { super(opts?.message); this.name = 'InternalServerException'; } }
export class ModelStreamErrorException extends Error { constructor(opts) { super(opts?.message); this.name = 'ModelStreamErrorException'; } }
export class ThrottlingException extends Error { constructor(opts) { super(opts?.message); this.name = 'ThrottlingException'; } }
export class ValidationException extends Error { constructor(opts) { super(opts?.message); this.name = 'ValidationException'; } }
`,
            '@aws-sdk/client-sts': `
const err = () => { throw new Error('[YwCoder] 当前内网构建不支持 AWS STS。如需启用，请删除 scripts/build.ts 中的云服务商 SDK 桩模块并重新构建。'); };
export class STSClient { constructor() { err(); } send() { err(); } }
export class GetCallerIdentityCommand { constructor() { err(); } }
`,
            '@aws-sdk/credential-providers': `
const err = () => { throw new Error('[YwCoder] 当前内网构建不支持 AWS 凭证提供者。如需启用，请删除 scripts/build.ts 中的云服务商 SDK 桩模块并重新构建。'); };
export const fromIni = () => err;
export const fromEnv = () => err;
export const fromProcess = () => err;
`,
            '@aws-sdk/credential-provider-node': `
const err = () => { throw new Error('[YwCoder] 当前内网构建不支持 AWS credential-provider-node。如需启用，请删除 scripts/build.ts 中的云服务商 SDK 桩模块并重新构建。'); };
export const defaultProvider = () => err;
`,
            'google-auth-library': `
const err = () => { throw new Error('[YwCoder] 当前内网构建不支持 Google Vertex AI 认证。如需启用，请删除 scripts/build.ts 中的云服务商 SDK 桩模块并重新构建。'); };
export class GoogleAuth { constructor() { err(); } getClient() { err(); } }
export class JWT { constructor() { err(); } }
export class OAuth2Client { constructor() { err(); } }
`,
          }
          return {
            contents: stubs[args.path] ?? `export default {}`,
            loader: 'js',
          }
        })

        // ─── 云服务商 SDK 桩模块结束 ──────────────────────────────────────────

        // Resolve native addon and missing snapshot imports to stubs
        for (const mod of [
          'audio-capture-napi',
          'audio-capture.node',
          'image-processor-napi',
          'modifiers-napi',
          'url-handler-napi',
          'color-diff-napi',
          '@anthropic-ai/mcpb',
          '@ant/claude-for-chrome-mcp',
          '@anthropic-ai/sandbox-runtime',
          'asciichart',
          'plist',
          'cacache',
          'fuse',
          'code-excerpt',
          'stack-utils',
        ]) {
          build.onResolve({ filter: new RegExp(`^${mod}$`) }, () => ({
            path: mod,
            namespace: 'native-stub',
          }))
        }
        build.onLoad(
          { filter: /.*/, namespace: 'native-stub' },
          () => ({
            // Comprehensive stub that handles any named export via Proxy
            contents: `
const noop = () => null;
const noopClass = class {};
const handler = {
  get(_, prop) {
    if (prop === '__esModule') return true;
    if (prop === 'default') return new Proxy({}, handler);
    if (prop === 'ExportResultCode') return { SUCCESS: 0, FAILED: 1 };
    if (prop === 'resourceFromAttributes') return () => ({});
    if (prop === 'SandboxRuntimeConfigSchema') return { parse: () => ({}) };
    return noop;
  }
};
const stub = new Proxy(noop, handler);
export default stub;
export const __stub = true;
// Named exports for all known imports
export const SandboxViolationStore = null;
export const SandboxManager = new Proxy({}, { get: () => noop });
export const SandboxRuntimeConfigSchema = { parse: () => ({}) };
export const BROWSER_TOOLS = [];
export const getMcpConfigForManifest = noop;
export const ColorDiff = null;
export const ColorFile = null;
export const getSyntaxTheme = noop;
export const plot = noop;
export const createClaudeForChromeMcpServer = noop;
// OpenTelemetry exports
export const ExportResultCode = { SUCCESS: 0, FAILED: 1 };
export const resourceFromAttributes = noop;
export const Resource = noopClass;
export const SimpleSpanProcessor = noopClass;
export const BatchSpanProcessor = noopClass;
export const NodeTracerProvider = noopClass;
export const BasicTracerProvider = noopClass;
export const OTLPTraceExporter = noopClass;
export const OTLPLogExporter = noopClass;
export const OTLPMetricExporter = noopClass;
export const PrometheusExporter = noopClass;
export const LoggerProvider = noopClass;
export const SimpleLogRecordProcessor = noopClass;
export const BatchLogRecordProcessor = noopClass;
export const MeterProvider = noopClass;
export const PeriodicExportingMetricReader = noopClass;
export const trace = { getTracer: () => ({ startSpan: () => ({ end: noop, setAttribute: noop, setStatus: noop, recordException: noop }) }) };
export const context = { active: noop, with: (_, fn) => fn() };
export const SpanStatusCode = { OK: 0, ERROR: 1, UNSET: 2 };
export const ATTR_SERVICE_NAME = 'service.name';
export const ATTR_SERVICE_VERSION = 'service.version';
export const SEMRESATTRS_SERVICE_NAME = 'service.name';
export const SEMRESATTRS_SERVICE_VERSION = 'service.version';
export const AggregationTemporality = { CUMULATIVE: 0, DELTA: 1 };
export const DataPointType = { HISTOGRAM: 0, SUM: 1, GAUGE: 2 };
export const InstrumentType = { COUNTER: 0, HISTOGRAM: 1, UP_DOWN_COUNTER: 2 };
export const PushMetricExporter = noopClass;
export const SeverityNumber = {};
`,
            loader: 'js',
          }),
        )

        // Resolve .md and .txt file imports to empty string stubs
        build.onResolve({ filter: /\.(md|txt)$/ }, (args) => ({
          path: args.path,
          namespace: 'text-stub',
        }))
        build.onLoad(
          { filter: /.*/, namespace: 'text-stub' },
          () => ({
            contents: `export default '';`,
            loader: 'js',
          }),
        )

        // Pre-scan: find all missing modules that need stubbing
        // (Bun's onResolve corrupts module graph even when returning null,
        //  so we use exact-match resolvers instead of catch-all patterns)
        const fs = require('fs')
        const pathMod = require('path')
        const srcDir = pathMod.resolve(__dirname, '..', 'src')
        const missingModules = new Set<string>()
        const missingModuleExports = new Map<string, Set<string>>()

        // Known missing external packages
        for (const pkg of [
          '@ant/computer-use-mcp',
          '@ant/computer-use-mcp/sentinelApps',
          '@ant/computer-use-mcp/types',
          '@ant/computer-use-swift',
          '@ant/computer-use-input',
        ]) {
          missingModules.add(pkg)
        }

        // Scan source to find imports that can't resolve
        function scanForMissingImports() {
          function walk(dir: string) {
            for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
              const full = pathMod.join(dir, ent.name)
              if (ent.isDirectory()) { walk(full); continue }
              if (!/\.(ts|tsx)$/.test(ent.name)) continue
              const code: string = fs.readFileSync(full, 'utf-8')
              // Collect all imports
              for (const m of code.matchAll(/import\s+(?:\{([^}]*)\}|(\w+))?\s*(?:,\s*\{([^}]*)\})?\s*from\s+['"](.*?)['"]/g)) {
                const specifier = m[4]
                const namedPart = m[1] || m[3] || ''
                const names = namedPart.split(',')
                  .map((s: string) => s.trim().replace(/^type\s+/, ''))
                  .filter((s: string) => s && !s.startsWith('type '))

                // Check src/tasks/ non-relative imports
                if (specifier.startsWith('src/tasks/')) {
                  const resolved = pathMod.resolve(__dirname, '..', specifier)
                  const candidates = [
                    resolved,
                    `${resolved}.ts`, `${resolved}.tsx`,
                    resolved.replace(/\.js$/, '.ts'), resolved.replace(/\.js$/, '.tsx'),
                    pathMod.join(resolved, 'index.ts'), pathMod.join(resolved, 'index.tsx'),
                  ]
                  if (!candidates.some((c: string) => fs.existsSync(c))) {
                    missingModules.add(specifier)
                  }
                }
                // Check relative .js imports
                else if (specifier.endsWith('.js') && (specifier.startsWith('./') || specifier.startsWith('../'))) {
                  const dir2 = pathMod.dirname(full)
                  const resolved = pathMod.resolve(dir2, specifier)
                  const tsVariant = resolved.replace(/\.js$/, '.ts')
                  const tsxVariant = resolved.replace(/\.js$/, '.tsx')
                  if (!fs.existsSync(resolved) && !fs.existsSync(tsVariant) && !fs.existsSync(tsxVariant)) {
                    missingModules.add(specifier)
                  }
                }

                // Track named exports for missing modules
                if (names.length > 0) {
                  if (!missingModuleExports.has(specifier)) missingModuleExports.set(specifier, new Set())
                  for (const n of names) missingModuleExports.get(specifier)!.add(n)
                }
              }
            }
          }
          walk(srcDir)
        }
        scanForMissingImports()

        // Register exact-match resolvers for each missing module
        for (const mod of missingModules) {
          const escaped = mod.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          build.onResolve({ filter: new RegExp(`^${escaped}$`) }, () => ({
            path: mod,
            namespace: 'missing-module-stub',
          }))
        }

        build.onLoad(
          { filter: /.*/, namespace: 'missing-module-stub' },
          (args) => {
            const names = missingModuleExports.get(args.path) ?? new Set()
            const exports = [...names].map(n => `export const ${n} = noop;`).join('\n')
            return {
              contents: `
const noop = () => null;
export default noop;
${exports}
`,
              loader: 'js',
            }
          },
        )
      },
    },
  ],
  external: [
    // OpenTelemetry — too many named exports to stub, kept external
    '@opentelemetry/api',
    '@opentelemetry/api-logs',
    '@opentelemetry/core',
    '@opentelemetry/exporter-trace-otlp-grpc',
    '@opentelemetry/exporter-trace-otlp-http',
    '@opentelemetry/exporter-trace-otlp-proto',
    '@opentelemetry/exporter-logs-otlp-http',
    '@opentelemetry/exporter-logs-otlp-proto',
    '@opentelemetry/exporter-logs-otlp-grpc',
    '@opentelemetry/exporter-metrics-otlp-proto',
    '@opentelemetry/exporter-metrics-otlp-grpc',
    '@opentelemetry/exporter-metrics-otlp-http',
    '@opentelemetry/exporter-prometheus',
    '@opentelemetry/resources',
    '@opentelemetry/sdk-trace-base',
    '@opentelemetry/sdk-trace-node',
    '@opentelemetry/sdk-logs',
    '@opentelemetry/sdk-metrics',
    '@opentelemetry/semantic-conventions',
    // Native image processing
    'sharp',
    // 云服务商 SDK — 已通过桩模块替换（见上方"云服务商 SDK 桩模块"注释块）
    // 如需恢复：删除上方桩模块代码，取消注释以下各行，然后重新构建。
    // '@aws-sdk/client-bedrock',
    // '@aws-sdk/client-bedrock-runtime',
    // '@aws-sdk/client-sts',
    // '@aws-sdk/credential-providers',
    // '@azure/identity',        // src/ 中未直接引用，保持注释即可
    // 'google-auth-library',
  ],
  })

  if (!result.success) {
    console.error(`Build failed (${opts.label}):`)
    for (const log of result.logs) {
      console.error(log)
    }
    process.exit(1)
  }
}

await buildTarget({
  entrypoints: ['./src/entrypoints/cli.tsx'],
  naming: 'cli.mjs',
  label: 'cli',
})
console.log(`✓ Built ywcoder v${displayVersion} (sha:${gitSha}, build #${buildId}, channel:${buildChannel}) → dist/cli.mjs`)

await buildTarget({
  entrypoints: ['./src/entrypoints/ywmatrix-shim/index.ts'],
  naming: 'ywmatrix-shim.mjs',
  label: 'ywmatrix-shim',
  // bin 直接指向该文件（package.json "ywcoder-ywmatrix"），需要 shebang 才能被
  // AgentClient 当可执行文件直接 spawn（见 shim-build-plan.md §2）。
  banner: '#!/usr/bin/env node\n',
  extraDefine: { SHIM_VERSION: JSON.stringify(displayVersion) },
})
console.log(`✓ Built ywmatrix-shim v${displayVersion} → dist/ywmatrix-shim.mjs`)
