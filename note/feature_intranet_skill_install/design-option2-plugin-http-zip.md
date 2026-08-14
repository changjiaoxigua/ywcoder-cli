# 内网 Skill 分发：方案二（复用 plugin 机制 + 新增 http-zip 来源）

> 与 `design.md`（方案一：自建 `/skill-install`）平行的备选方案，供对比决策。
> 结论先行：在"内网只有静态 HTTP zip、没有 git/npm"的前提下，**缺的只是最后一段下载逻辑**，
> 清单、版本、更新、信任、策略、卸载、UI 在仓库里已经全部具备。

---

## 1. 核心思路

现有 plugin 体系已经支持：

| 环节 | 现状 | 依据 |
|------|------|------|
| 清单来源 | marketplace 支持 `source: 'url'`，**直接指向 HTTP 上的 marketplace.json**，明文 http 放行 | `schemas.ts:906-916`、`marketplaceManager.ts:1216` |
| 免 plugin.json | marketplace entry 支持 `strict: false`，清单本身即 manifest | `schemas.ts:1277-1283` |
| 版本/更新检测 | 版本优先取 manifest.version，其次取 marketplace entry 的 version，**不依赖 git** | `pluginVersioning.ts:36-58` |
| 更新执行 | `performPluginUpdate` 对远程源统一走 `cachePlugin(entry.source)`，与来源类型无关 | `pluginOperations.ts:920-942` |
| skill 加载 | `entry.skills` 可指向 plugin 目录内任意路径；目标目录既可"本身是一个 skill"，也可"内含若干 skill 子目录" | `pluginLoader.ts:2602-2651`、`loadPluginCommands.ts:686-760` |
| 自动更新不拖慢启动 | 非官方 marketplace 的 autoUpdate 默认 false | `schemas.ts:39-57` |

唯一的缺口在 **plugin 本体的来源类型**：只有 local / npm / github / git / git-subdir，
没有"HTTP zip"（`pluginLoader.ts:930-960`）。

本方案 = **补上这一种来源**，其余全部复用。

---

## 2. 与方案一的对照

| 维度 | 方案一（自建 `/skill-install`） | 方案二（http-zip plugin source） |
|------|------|------|
| 新增代码量 | 约 400-600 行（installer + 记录管理 + 交互 UI + 参数解析 + 测试） | 约 60-90 行 + 测试 |
| 改动面 | 全是新增文件，几乎不碰既有代码 | 改 2 个既有文件（schemas.ts / pluginLoader.ts），另加 1 处可选改动 |
| 清单服务 | 需要新定义一套 skills.json 扩展字段 | 复用 marketplace.json 格式，由现有 skills.json 生成 |
| 版本与更新 | 自己实现（含 `--update` / `--update-all` / 安装记录） | 白送 |
| 卸载/禁用 | 需自己实现 | 白送（`/plugin uninstall`、`disable`） |
| 浏览 UI | 需自己写交互列表 | 白送（`/plugin` 的浏览、搜索、分类、tags） |
| 信任确认 | 需自己实现（否则等于静默安装可执行代码） | 白送（PluginTrustWarning） |
| 企业策略 | 需自己对接 `strictPluginOnlyCustomization` | 白送（`strictKnownMarketplaces` / `blockedMarketplaces` / `pluginTrustMessage`） |
| 落盘位置 | `~/.ywcoder/skills/`、`$project/.ywcoder/skills/` | `~/.ywcoder/plugins/cache/<marketplace>/<plugin>/<version>/` |
| 命令名 | `/architecture-diagram` | 默认 `/<plugin>:architecture-diagram`，去前缀改动见 §5.4 |
| 项目级作用域 | 靠文件位置 | 靠 `enabledPlugins` 写在哪个 settings.json |

---

## 3. 端到端流程

```
内网服务端                          客户端
──────────                          ──────
skills.json ──生成──> marketplace.json
                          │
zip 包（结构不变）         │
  <id>/SKILL.md            │
                          ▼
              /plugin marketplace add http://10.x.x.x/marketplace.json
                          │
                          ▼  （已有能力，无需开发）
              拉取 marketplace.json → 校验 → 缓存 → 列表展示
                          │
                          ▼
              /plugin install yw@yw-intranet  （或在 /plugin UI 里选）
                          │
                          ▼  【本方案唯一新增的一段】
              cachePlugin(source: {source:'http-zip', url, sha256})
                → axios 下载 zip 到临时文件
                → sha256 校验
                → extractZipToDirectory()（已含路径穿越/zip bomb 防护、保留 +x）
                          │
                          ▼  （已有能力）
              信任确认 → 落 versioned cache → 写安装记录 → 刷新缓存 → skill 立即可用
```

更新：服务端改 marketplace.json 里的 `version` → 客户端 `/plugin update` 即重新下载。

---

## 4. 内网服务端要做的事

### 4.1 多产出一份 marketplace.json

可由现有 `skills.json` 脚本生成，字段映射：

| skills.json | marketplace.json | 说明 |
|---|---|---|
| `id` | `plugins[].name` | 需为 kebab-case、不含空格 |
| `name` | （可并入 description） | plugin name 必须是标识符 |
| `description` | `plugins[].description` | 直接映射 |
| `tags` | `plugins[].tags` | 直接映射 |
| `version` | `plugins[].version` | **更新检测靠它**，务必每次发布递增 |
| `filename` → 拼 URL | `plugins[].source.url` | 完整可访问地址 |
| `sha256` | `plugins[].source.sha256` | 可选但强烈建议 |
| — | `plugins[].strict: false` | 免 zip 内 plugin.json |
| — | `plugins[].skills: ["."]` | 让 plugin 根目录下的 `<id>/SKILL.md` 被扫到 |

示例：

```json
{
  "name": "yw-intranet",
  "owner": { "name": "平台组" },
  "plugins": [
    {
      "name": "yw",
      "version": "1.1",
      "description": "内网通用 skill 集合",
      "strict": false,
      "skills": ["."],
      "source": {
        "source": "http-zip",
        "url": "http://10.x.x.x/skills/yw-skills.zip", <!-- pr-scan:ignore executable-download-link —— 文档示例地址 -->
        "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
      }
    }
  ]
}
```

### 4.2 zip 包结构：不用重打

现有结构原样可用：

```
yw-skills.zip
├── architecture-diagram/
│   └── SKILL.md
└── chart-craft/
    └── SKILL.md
```

`skills: ["."]` 会让 `loadSkillsFromDirectory` 扫描 plugin 根目录，把每个含 `SKILL.md` 的子目录加载为一个 skill。

### 4.3 打包粒度建议：一个大包，不是一 skill 一包

- 一个大包 → 命令名 `/yw:architecture-diagram`，`/yw:` 一键列出全部
- 一 skill 一包 → plugin 名与 skill 名相同，会得到 `/architecture-diagram:architecture-diagram`

如果确实要按 skill 独立版本管理，再拆多个 plugin，但 plugin 名要另起（如 `yw-arch`）。

---

## 5. 客户端改动清单

### 5.1 `src/utils/plugins/schemas.ts` —— 新增来源类型

位置：`PluginSourceSchema`（`schemas.ts:1062`）的 `z.union([...])` 里追加一个成员。

```ts
    z
      .object({
        source: z.literal('http-zip'),
        url: z
          .string()
          .url()
          .refine(
            u => u.startsWith('http://') || u.startsWith('https://'),
            { message: '只允许 http/https，禁止 file:// 等本地协议' },
          )
          .describe('zip 包的完整下载地址'),
        sha256: z
          .string()
          .regex(/^[a-f0-9]{64}$/, '必须是 64 位小写十六进制 sha256')
          .optional()
          .describe('zip 包完整性校验值，配置后校验失败即拒绝安装'),
      })
      .describe('通过 HTTP 直接下载 zip 包的插件来源（内网静态文件服务场景）'),
```

注意：`PluginSourceSchema` 是 `z.union` 不是 `discriminatedUnion`，追加成员不影响既有解析。

### 5.2 `src/utils/plugins/pluginLoader.ts` —— 下载实现

新增函数（建议放在 `installFromNpm`（`:492`）附近，保持来源实现聚在一起）：

```ts
/**
 * 从 HTTP(S) 下载 zip 包并解压到目标路径。
 * 用于内网静态文件服务分发插件的场景（无 git / 无私有 npm registry）。
 *
 * 复用现有基础设施：
 * - axios：全局拦截器已处理 HTTP(S)_PROXY / NO_PROXY / mTLS（见 utils/proxy.ts:352）
 * - extractZipToDirectory：内部走 unzipFile，已含路径穿越、zip bomb、体积/文件数上限，
 *   并通过 parseZipModes 保留可执行位
 */
export async function installFromHttpZip(
  url: string,
  targetPath: string,
  expectedSha256?: string,
): Promise<void> {
  logForDebugging(`Downloading plugin zip from ${url}`)

  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 60_000,
    // 下载阶段的兜底上限；解压阶段的上限由 unzipFile 负责
    maxContentLength: 128 * 1024 * 1024,
  })
  const zipBuf = Buffer.from(response.data)

  // sha256 校验：只防传输损坏/中途篡改，不构成对内容的信任背书
  if (expectedSha256) {
    const actual = createHash('sha256').update(zipBuf).digest('hex')
    if (actual !== expectedSha256.toLowerCase()) {
      throw new Error(
        `插件包校验失败：期望 sha256 ${expectedSha256}，实际 ${actual}`,
      )
    }
  }

  // extractZipToDirectory 接收的是 zip 文件路径，先落一个临时文件。
  // 临时文件与 targetPath 同在 plugins 目录下，同分区，无跨设备问题。
  const tmpZipPath = `${targetPath}.download.zip`
  await getFsImplementation().mkdir(dirname(tmpZipPath))
  try {
    await writeFile(tmpZipPath, zipBuf)
    await extractZipToDirectory(tmpZipPath, targetPath)
  } finally {
    await rm(tmpZipPath, { force: true })
  }

  logForDebugging(`Extracted plugin zip to ${targetPath}`)
}
```

需要补的 import：`axios`、`createHash`（`node:crypto`）；`extractZipToDirectory` 已在 `:118` 导入。

接入两处 switch：

1. `cachePlugin`（`:911`）的 source switch（`:930-960`）：

```ts
        case 'http-zip':
          await installFromHttpZip(source.url, tempPath, source.sha256)
          break
```

2. `generateTemporaryCacheNameForPlugin`（`:873`）：

```ts
      case 'http-zip':
        prefix = 'httpzip'
        break
```

### 5.3 不需要改的地方（已核对）

- `marketplaceHelpers.ts` 的那几处 switch 全部作用于 **MarketplaceSource**（清单来源），不是 PluginSource，无需改动。
- `pluginVersioning.ts` 只对 `git-subdir` 特判，其余走 manifest/entry 版本，天然支持。
- `reconciler.ts`、`zipCache.ts` 的 source 判断都带 fallback 分支，不会因新增类型报错。
- `pluginOperations.ts` 的安装/更新/卸载全流程与来源类型无关。

### 5.4 去掉 skill 名前缀（可选，取决于 §10 的决策）

plugin skill 的名字在两处硬编码拼了 `<plugin>:` 前缀：

- `loadPluginCommands.ts:726`（skillsPath 本身就是一个 skill 目录的分支）
- `loadPluginCommands.ts:806`（扫描子目录的分支）

去掉前缀后命令名与手动安装完全一致（`/architecture-diagram`）。

**代价必须认清**：前缀的作用就是防冲突。去掉后，两个 plugin 带同名 skill、或 plugin skill 与
`~/.ywcoder/skills/` 下同名 skill，会互相静默遮蔽（谁生效取决于 `commands.ts:458-477`
的拼接顺序，bundled 在最前）。内网 marketplace 集中管控时这个风险可控，但要靠**服务端把关重名**。

保守做法：保留前缀，把 plugin 名压到最短（`yw`）。搜索成本影响有限——
命令名会按 `[:_-]` 分词进 Fuse 的 `partKey`（`commandSuggestions.ts:12,38-51`），
敲 `/arch` 依然能搜到；只是内联 ghost 补全（`getBestCommandMatch`，严格前缀匹配）会失效。

### 5.5 展示层补丁（可选，1 行）

`BrowseMarketplace.tsx:679` 的"远程插件不展示组件明细"判断里补上 `'http-zip'`，
否则内网插件会走本地扫描分支显示空组件列表。纯展示问题，不影响功能。

---

## 6. 安全设计

| 面 | 处理 | 由谁负责 |
|---|---|---|
| 协议限制 | schema 层只允许 http/https | 新增（§5.1） |
| 传输完整性 | sha256 校验，失败即拒绝 | 新增（§5.2） |
| zip 路径穿越 | `isPathSafe` 拒绝 `../` 与绝对路径 | 既有（`dxt/zip.ts`） |
| zip bomb | 压缩比 50:1、单文件 512MB、总量 1GB、文件数 10w 上限 | 既有（`dxt/zip.ts`） |
| 安装即代码 | SKILL.md 支持 `` !`…` `` 内联 shell 与 frontmatter hooks，安装前必须有信任确认 | 既有（PluginTrustWarning） |
| 清单来源可信 | `strictKnownMarketplaces` / `blockedMarketplaces` / `hostPattern` | 既有 |
| 企业提示语 | `pluginTrustMessage`（policy-only） | 既有 |

对比方案一：上表后四行在方案一里全部需要自己实现，这是方案二最实在的收益。

---

## 7. 落盘路径与作用域语义

```
~/.ywcoder/plugins/cache/<marketplace>/<plugin>/<version>/
└── architecture-diagram/
    └── SKILL.md
```

（`pluginLoader.ts:126-128`、`:155-161`）

- **项目目录不写任何文件**。"项目级"通过 `enabledPlugins` 写在项目的 settings.json 里表达。
- 每次更新落新的 `<version>/` 目录，旧版本标记 orphaned、7 天后清理（`cacheUtils.ts:23-24`）。
- 手动放进 `~/.ywcoder/skills/` 的 skill 照常工作，两条路并存不冲突。

**取舍**：好处是不污染项目目录（无需管 gitignore）、跨项目复用下载、多版本共存、可回滚；
坏处是用户想手改 SKILL.md 时路径深且是共享缓存，改动会被下次更新覆盖。

---

## 8. 测试计划

新增单测（建议放 `src/utils/plugins/pluginLoader.test.ts`，与既有来源测试同文件）：

1. `installFromHttpZip` 正常路径：内存构造 zip → mock axios → 断言解压后的目录结构
2. sha256 不匹配 → 抛错且不留下残留文件
3. sha256 未配置 → 跳过校验，正常安装
4. zip 内含 `../` 条目 → 被 `unzipFile` 拒绝（回归验证，非新逻辑）
5. 下载超时 / 非 200 → 错误信息可读，临时文件被清理
6. schema：`file:///etc/passwd` 被拒；非法 sha256 长度被拒
7. `generateTemporaryCacheNameForPlugin` 对 http-zip 返回 `temp_httpzip_*`

集成验证（手工，spike 阶段）：

8. `strict: false` + `skills: ["."]` 能否正确加载 zip 根下的 `<id>/SKILL.md`
9. 明文 `http://` 的 marketplace 能否 add 成功
10. 改 marketplace.json 的 version → `/plugin update` 能否识别并重新下载
11. 若采纳 §5.4，验证去前缀后与本地 skills 目录同名时的实际生效顺序

---

## 9. 风险与已知取舍

| 风险 | 影响 | 缓解 |
|---|---|---|
| 违反"不改造 plugin/marketplace"的既有约束 | 需决策放开 | 实质是"加一个来源分支"，不改机制；仓库无 upstream remote，无上游同步冲突成本 |
| 命令名带前缀 | 搜索手感变化 | 短 plugin 名（`yw`）；或按 §5.4 去前缀（换来重名遮蔽风险） |
| 落盘路径变化 | 与现有"解压到 skills 目录"的习惯/文档不一致 | 需确认是否有外部工具依赖 skills 目录路径（见 §11） |
| 粒度是 plugin 不是单 skill | 无法从大包里挑装 | 按 §4.3 权衡打包粒度 |
| 更新时总是先下载再比版本 | 内网小包影响可忽略 | 可选优化：`entry.version === installation.version` 时短路（`pluginOperations.ts:920` 之前） |
| plugin 校验/加载链路比 skills 目录长 | 出问题排查成本高 | `/plugin` 有错误面板（PluginErrors.tsx），且 `logForDebugging` 覆盖完整 |

---

## 10. 实施步骤

1. **Spike（半天）**：手工造 marketplace.json + 一个 zip，先验证 §8 的第 8、9、10 三条。
   这三条是本方案的地基，任一不成立就要回到方案一。
2. **实现（1 天）**：§5.1 + §5.2 + §5.3 核对，配单测。
3. **决策点**：是否采纳 §5.4 去前缀。
4. **服务端（0.5 天）**：skills.json → marketplace.json 生成脚本。
5. **验证**：`bun run build`、`bun test --max-concurrency=1`、`bun run smoke`、
   `bun run security:pr-scan -- --base origin/main`。
6. **内网联调**：feature 分支 + CI 打包 + 内网实机安装/更新/卸载全流程。

---

## 11. 待决事项

1. **是否放开"不改造 plugin/marketplace"的约束？** —— 不放开则本方案作废，回方案一。
2. **是否有外部工具/文档依赖 `~/.ywcoder/skills/` 这个路径？** —— 有则本方案的落盘位置是硬伤。
3. **前缀：保留短前缀（`/yw:xxx`）还是按 §5.4 去掉？** —— 取决于内网 skill 是集中管控还是各团队自由上传。
4. **打包粒度：一个大包还是按 skill 拆包？**
