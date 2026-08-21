# 04 - 设计文档：运行时版本检查与更新提醒（方案 A）

**Status**: Draft
**Date**: 2026-08-14
**Owner**: changjiaoxigua
**前置文档**: `01-requirements.md`（§6 暂缓项"运行时检查更新"）、`note/feature_intranet_skill_install/design-option1-lite.md`（hub 机制，D20）

---

## 1. 背景与定位

`01-requirements.md` 把"客户端运行时检查更新"列为 Out of Scope，唯一理由是**内网无可达的版本清单地址**。
`/skill-install`（v1.3.0）落地后这个前提已消失：内网存在 `yw-devhub` 静态文件服务，客户端已有
`ywdevhubUrl` 配置与配套的读取、URL 派生、传输校验链路。

本文设计该暂缓项的落地：**启动时异步检查 hub 上的版本清单，发现新版本时在 REPL 中提醒用户**。
只闭环"发现 + 提醒"这一半，安装仍走内网人工搬运（共享盘 → `npm install -g xxx.tgz`）。

与上游 first-party 更新链路（`autoUpdater.ts` / `nativeInstaller/` / `cli/update.ts`）**完全独立**，
不动一行。上游链路对 ywcoder 不可用且已被主动禁用（`update.ts:37-44`）。

---

## 2. 已确认决策

| # | 决策 | 理由 |
|---|---|---|
| D1 | 只检查 + 提醒，不下载、不安装 | 内网全局 npm 权限不一定具备；运行中自替换风险高；安装链路维持人工搬运 |
| D2 | 复用 `ywdevhubUrl`，不新增 settings 字段 | hub 根地址已按资源类型用清单路径约定区分（skill-install 设计 D20）。信任边界在 hub 级，与 skill 安装同源 |
| D3 | 直接消费现有 `tools.json`（顶层数组），按 `id === "ywcoder-cli"` 取条目，服务端零改动 | 与 skill-install 的 D17 同一哲学；hub 数据维护方只需维护一份清单 |
| D4 | 版本比较用 `MACRO.DISPLAY_VERSION`，不用 `MACRO.VERSION` | 后者是 `"99.0.0"` 占位符（01 文档 C1），任何比较都会失真 |
| D5 | 比较规则 = semver `gt(清单版本, 当前版本)`；任一侧非法 semver → 静默跳过 | dev 构建（`1.3.0-dev.abc`）按 semver 预发布规则天然落后于同名 release，比较结果自然正确，无需特判 |
| D6 | 24h 节流 + 结果缓存写 globalConfig | 每次启动都发请求不必要；缓存让"有更新"的提醒在两次检查之间的会话里也能立即展示 |
| D7 | 提醒走 notifications 系统，每会话启动至多提示一次 | 复用 `usePluginAutoupdateNotification` 的成熟模式，不新增 UI 组件 |
| D8 | 开关 = 自定义判定：`DISABLE_AUTOUPDATER` env / essential-traffic env / `config.autoUpdates === false`。**严禁复用 `isAutoUpdaterDisabled()`** | 该函数在 ywcoder build 中恒为 true——config.ts:1800 无条件兜底 `{ type: 'ywcoder' }`，是为禁用上游 GCS 轮询打的补丁。复用它等于功能永不执行；config.ts:1799 注释"改回 return null 即可恢复自动更新"是陷阱，会同时复活上游 GCS 轮询 |
| D9 | 任何失败静默：只写 debug log，不向用户输出 | 内网/离线鲁棒性约束（01 文档 C3）；未配置 hub 时同样静默跳过 |
| D10 | 仅交互式 REPL 运行；headless（`-p`）、remote mode 跳过；bridge（远程控制/镜像）**允许提醒** | 提醒需要展示面：headless/remote 没有；**bridge 有本地 REPL 展示面，不跳过**（2026-08-21 复审修订，原文要求 bridge 跳过）。检查由 REPL 挂载的 `useYwCoderUpdateNotification()` effect 触发（挂载即检查，不依赖首次提交），headless 路径永不挂载该 hook；`checkYwCoderUpdate()` 内部的交互/remote 判定保留为防线 |
| D11 | 平台匹配：本机平台无对应安装包 → 静默跳过提醒 | 提醒一个拿不到包的更新是纯噪音。现网 `packages` 只有 Windows/Linux，Mac 用户今天就不该收到提醒 |

---

## 3. 清单格式

### 3.1 直接消费现有 `tools.json`（服务端零改动）

现网清单（`yw-devhub/tools.json`）是**顶层数组**，取 `id === "ywcoder-cli"` 的条目：

```json
{
  "id": "ywcoder-cli",
  "name": "YwCoder CLI",
  "version": "1.1.0",
  "updatedAt": "2026-05-14",
  "releaseNotes": "tools/YwCoder-Cli/README.md",
  "packages": [
    { "platform": "Windows", "filename": "tools/YwCoder-Cli/ywcoder-1.1.0-...-win-x64.zip" },
    { "platform": "Linux",   "filename": "tools/YwCoder-Cli/ywcoder-1.1.0-...-linux-x64.zip" }
  ]
}
```

客户端消费的字段：

| 字段 | 必需 | 用途与校验 |
|---|---|---|
| `id` | 是 | 匹配字面值 `"ywcoder-cli"`；数组中找不到该条目 → 静默跳过；**重复条目取第一条**（与 skills 清单同规则） |
| `version` | 是 | 合法 semver（可含预发布后缀），长度 ≤ 64。非法 → 静默跳过 |
| `packages` | 是 | 数组。按 §3.3 平台匹配取 `filename` 用于提醒文案；无匹配 → 静默跳过（D11） |
| `releaseNotes` | 否 | **不消费**（浏览器可直接打开该路径，但 v1 提醒不展示，需要时一行加回） |
| `name` `description` `updatedAt` `tags` `contact` | 否 | 不消费 |

其余条目（如 `everything-claude-code-zh-internal`）不消费，不校验，其字段非法不影响本功能。

**故意不做**：下载/校验安装包（方案 B 的字段已就位——`packages[].filename` 派生下载地址即可，届时无需改清单结构）；
`minVersion` 强制升级（内网无此诉求，上游同款机制已绕开）。

### 3.2 地址派生与传输

复用 `skillInstaller.ts` 的现成原语，零新增：

```
清单地址 = new URL('tools.json', hubRoot)      // hubRoot 经 normalizeHubRoot 归一化
```

- 配置读取：`resolveHubConfig()`（policySettings > userSettings，**不读 project/local**，skillInstaller.ts:65）
- 校验：`assertUrlAllowed()`（仅 http/https、禁 userinfo）
- 请求：axios（继承代理/证书链路），`timeout: 1500`、`maxRedirects: 0`、`responseType: 'text'`、`maxContentLength: 64 * 1024`（tools.json 会随资源条目增多而增长，余量放宽；仍远小于 skills.json 的 2MB）
- 日志只输出 `urlForLog()` 的 origin + pathname

### 3.3 平台匹配

`packages[].platform` 是人工维护的展示字符串，客户端按固定映射匹配：

| `process.platform` | 匹配值 |
|---|---|
| `win32` | `"Windows"` |
| `linux` | `"Linux"` |
| `darwin` | `"macOS"` |

匹配规则（按顺序）：

1. `packages` 中存在 `platform` **等于**映射值（大小写不敏感）的条目 → 取其 `filename`
2. 否则存在 `platform` 为 `"通用"` 的条目 → 取其 `filename`
3. 否则 → 本机平台无可用包，**静默跳过提醒**（D11）

已知边界：映射表按架构细分（如 `macOS-arm64` / `macOS-x64`）暂不支持——现网清单本无 macOS 包，
等上架时若需区分架构，在 `platform` 字符串上约定新值并扩充映射表即可，属客户端小改。

---

## 4. 运行时流程

```
REPL 启动（仅交互模式）
  │
  └─ REPL 挂载 useYwCoderUpdateNotification()      ← 挂载即检查，不等首次提交（2026-08-21 复审修订）
        ├─ 挂载即读 globalConfig 缓存：latestVersion > 当前版本 → 立即 addNotification
        ├─ 订阅检查回调：本次会话检查出新版本 → addNotification
        └─ 订阅就位后触发 void checkYwCoderUpdate()   ← 异步，不阻塞启动
              │
              ├─ 跳过判定（任一命中即返回，全部静默）：
              │    自定义禁用判定（D8）| 非交互 | remote mode | 未配置 ywdevhubUrl
              │    | 距上次检查 < 24h（读 globalConfig.ywcoderUpdateCheck.lastCheckedAt；
              │    | hubRoot 不一致 = 换源，整条缓存作废，立即检查）
              │
              ├─ GET tools.json（1.5s 超时，≤64KB，失败 → 静默记录 lastCheckedAt 后退避）
              ├─ 取 id === "ywcoder-cli" 条目（找不到 → 静默）
              ├─ 校验 version（严格 SemVer）+ 平台匹配 packages（§3.3；非法或无匹配平台 → 静默）
              └─ gt(清单版本, MACRO.DISPLAY_VERSION) ?
                    是 → saveGlobalConfig 缓存 { lastCheckedAt, latestVersion, packageFilename }
                          + 触发回调（通知 REPL）
                    否 → saveGlobalConfig 仅更新 lastCheckedAt，清掉 latestVersion 缓存
```

### 4.1 缓存结构（globalConfig 新增一个可选字段）

```ts
ywcoderUpdateCheck?: {
  lastCheckedAt: number      // 上次请求时间戳（成功失败都写，失败也节流）
  hubRoot?: string           // 产生本缓存的 hub 根地址；与当前配置不一致 → 整条缓存作废
  latestVersion?: string     // 上次确认的新版本（无更新时缺省）
  packageFilename?: string   // 本机平台对应的安装包文件名（提醒文案用）
}
```

- 提醒展示以缓存为准：两次检查之间的会话启动无需网络即可提示。
- 失败同样写 `lastCheckedAt`：hub 挂掉不会导致每次启动都打一次超时请求。
- 缓存里 `latestVersion` 与当前版本相等或更旧时（用户已升级），不再提醒。
- `hubRoot` 防串源：用户改了 `ywdevhubUrl` 后，旧 hub 的缓存提醒立即失效，不再展示。

### 4.2 提醒形态

复用 `useNotifications()`（参照 usePluginAutoupdateNotification.tsx:60-65）：

```
新版本可用：v1.3.1（当前 v1.3.0） · 获取 ywcoder-1.3.1-win-x64.zip
```

- 单行：新旧版本 + 本机平台对应的安装包文件名（`packages[].filename` 的 basename）
- `key: 'ywcoder-update-available'`，`priority: 'medium'`（枚举为 `'low'|'medium'|'high'|'immediate'`，无 `'normal'`；比 plugin 提醒的 `'low'` 高一级），`timeoutMs: 15000`
- 每会话至多一次；无 "不再提示" 按钮——版本升级后自然消失，忽略成本是一次性 15 秒

---

## 5. 模块划分与改动清单

### 5.1 新增

| 文件 | 职责 | 约束 | 估算行数 |
|---|---|---|---|
| `src/utils/ywUpdateCheck.ts` | 清单拉取/解析/校验、平台匹配、版本比较、节流判定、缓存读写、**自定义禁用判定（D8）**、回调注册（`onYwCoderUpdateAvailable`，含 pending 处理，参照 pluginAutoupdate.ts:51-65） | 零 React 依赖；**版本比较等纯函数的 currentVersion 一律参数注入，`MACRO.DISPLAY_VERSION` 只在入口函数读取**——测试环境 MACRO 需手工赋 `globalThis.MACRO`（现有惯例，见 client.test.ts:31），注入可测性更好 | 150–200 |
| `src/utils/ywUpdateCheck.test.ts` | 单测（§7） | mock axios | 150–200 |
| `src/hooks/notifs/useYwCoderUpdateNotification.tsx` | 挂载读缓存 + 订阅回调 → addNotification；**挂载 effect 内触发 `checkYwCoderUpdate()`（检查时机 = REPL 挂载）** | 参照 usePluginAutoupdateNotification | 40–60 |

### 5.2 修改（共约 6 行）

| 文件 | 改动 |
|---|---|
| `src/screens/REPL.tsx` | `usePluginAutoupdateNotification()`（:756）旁加一行 `useYwCoderUpdateNotification()`（含 import 共 2 行） |
| `src/utils/config.ts` | GlobalConfig 增加 `ywcoderUpdateCheck?` 字段（约 4 行） |

> 2026-08-21 复审修订：检查调用从 `backgroundHousekeeping.ts` 移到通知 hook 的挂载 effect——
> `startBackgroundHousekeeping()` 在 REPL 中被 `submitCount === 1` 门控（首次提交后才执行），
> 与本节「启动时异步检查」不符；hook 只被交互式 REPL 挂载，天然满足 D10 的触发时机。

### 5.3 复用不改

`skillInstaller.ts` 的 `resolveHubConfig` / `normalizeHubRoot` / `assertUrlAllowed` / `urlForLog`、
axios 代理链路、`src/utils/semver.js` 的 `gt`、notifications 系统。

**明确不复用**：`isAutoUpdaterDisabled()`（D8，ywcoder build 中恒 true）。

### 5.4 规模汇总

实现约 **180–250 行**，测试约 **150–200 行**，合计 330–450 行。

---

## 6. 失败模式

| 场景 | 行为 |
|---|---|
| 未配置 `ywdevhubUrl` | 静默跳过（大多数存量用户的稳态） |
| hub 不可达 / 超时 / 非 200 | 静默，写 `lastCheckedAt` 退避 24h |
| `tools.json` 不存在或其中无 `ywcoder-cli` 条目 | 静默——**新旧客户端与新旧 hub 任意组合均不出错** |
| version 非法 / JSON 损坏 | 静默跳过，不写 latestVersion |
| 本机平台无匹配安装包（现网 macOS 即此情况） | 静默跳过，不缓存 latestVersion——平台包上架后自然开始提醒 |
| 用户已禁用（D8 三种途径之一） | 完全不发起请求 |
| 内网 HTTP 被中间人篡改清单 | 影响上限 = 展示一行伪造的提醒文字；**无下载、无执行路径**，风险可接受 |

---

## 7. 测试计划

纯函数与节流逻辑（`ywUpdateCheck.test.ts`）：

1. 条目提取：顶层数组中找到 `ywcoder-cli` / 找不到静默 / **重复条目取第一条** / 其他条目字段非法不影响
2. `version` 校验：合法 / 缺失 / 非法 / 超长
3. 平台匹配：`win32`→`Windows`、`darwin`→`macOS`（现网无此包 → 跳过）、`linux`→`Linux`、精确匹配优先于 `"通用"`、大小写不敏感
4. 版本比较：`1.3.1 > 1.3.0` 提醒；`1.3.0 == 1.3.0` 不提醒；`1.3.0-dev.abc < 1.3.0` 提醒（dev 落后于同名 release）；清单版本更旧不提醒；任一侧非法静默
5. 节流：距上次检查 < 24h 不发请求；≥ 24h 发请求；失败后 24h 内不重试
6. 禁用判定（D8）：`DISABLE_AUTOUPDATER` / essential-traffic env / `autoUpdates: false` 各自生效；**回归断言：不调用 `isAutoUpdaterDisabled()` 结论**（ywcoder build 恒 true，误用即功能失效）；未配置 hub 静默返回
7. 缓存：有更新写 hubRoot + latestVersion + packageFilename；无更新清除 latestVersion；失败只写 lastCheckedAt；**缓存 hubRoot 与当前配置不一致 → 整条作废**
8. 传输：重定向响应报错不跟随；超 64KB 拒绝
9. 回调：检查出新版本触发回调；回调注册前已有结果 → 注册即补发（pending 模式）
10. 直接喂入现网 `tools.json` 快照 → 正确提取 `ywcoder-cli` 条目（回归 fixture）

CI：`bun run build`、`bun test --max-concurrency=1`、`bun run smoke`、`bun run security:pr-scan -- --base origin/main`。

---

## 8. 验收标准（内网实机）

- [ ] A1 未配置 `ywdevhubUrl`：启动无任何提示、无网络请求（debug log 可见跳过原因）
- [ ] A2 hub 的 `tools.json` 中 `version` 低于当前客户端（**现网即此状态：1.1.0**）：静默，启动速度无感知
- [ ] A3 清单 version 升至高于当前版本且含本机平台包：启动后提醒出现，文案含新旧版本号与安装包文件名
- [ ] A4 提醒出现后重启会话：不再发请求（24h 内），但提醒仍基于缓存出现
- [ ] A5 升级到最新版后：提醒消失
- [ ] A6 断网启动：启动速度无感知，无错误输出
- [ ] A7 `autoUpdates: false`：完全无请求
- [ ] A8 `-p` headless：无请求
- [ ] A9 macOS 机器 + 现网清单（无 macOS 包）：**不提醒**；往 `packages` 加一条 `macOS` 条目后 → 提醒出现
- [ ] A10 Windows / Linux 机器分别验证平台映射取到正确的 `filename`

---

## 9. 发布侧配套（一次性 + 持续）

- 发版流程增加一步：搬运 tgz 到内网时**同步更新 `tools.json` 中 `ywcoder-cli` 条目的 `version` 与 `packages[].filename`**。
  ⚠️ 现网该条目停在 `1.1.0`（2026-05-14），已落后仓库两个版本——若发版时忘记更新，提醒功能形同虚设。
  建议把这一步写进发版 checklist（与 release-please 的 Release PR 流程并列）。
- 现网 `packages` 无 macOS 条目：Mac 用户暂收不到提醒（行为正确）。若要覆盖 Mac 用户，上架 mac 包时按 §3.3 约定 `platform: "macOS"`。
- 内网使用文档补一句：提醒机制依赖 `ywdevhubUrl`，未配置则无提醒属预期。

---

## 10. 明确不做

- **自动下载 / 自动安装**（方案 B/C）：本期无消费字段，待方案 A 稳定后单独评估
- **`ywcoder update` 命令**：依赖自动安装，同上
- **`minVersion` 强制升级**：内网无诉求
- **新版 banner 组件 / 持久角标**：notifications 系统够用
- **改动上游更新链路**（`autoUpdater.ts` / `nativeInstaller/` / `update.ts`）
- **环境变量配置 hub 地址**：沿用 skill-install D10，只读 settings 文件

---

## 11. 待评审决策点

| # | 待定 | 倾向 |
|---|---|---|
| ~~Q1~~ | ~~清单文件名~~ | **已关闭**：直接消费现网 `tools.json`（D3），服务端零改动 |
| Q2 | 提醒 timeoutMs 15s 是否太短 | 参照 plugin 提醒 10s 先到 15s；实机验收 A3 时可调 |
| Q3 | 是否在 `/doctor` 输出中附带"已知最新版本" | 倾向不加，等用户反馈提醒太隐蔽再说 |
| Q4 | macOS 包上架时 `platform` 取值是否需细分架构（`macOS-arm64`） | 上架时再定，映射表扩充即可（§3.3 已知边界） |

---

## 12. 推进计划

设计已定稿（D1–D11、Q1 关闭，Q2–Q4 不阻塞开工），按依赖顺序分 5 个 Phase。
每阶段列出验证检查点，未通过不进入下一阶段。

### Phase 0 开工准备

1. 从 main 切 feature 分支 `feature/ywcoder-update-check`（仓库规矩：feature 分支先行，main 最后合并）
2. 确认内网 hub 的 `tools.json` 可访问，`ywcoder-cli` 条目字段与 §3.1 一致（id/version/packages 齐全）
3. 与 hub 维护方对齐两件事（验收的前置条件，见 Phase 4 风险表）：
   - 验收期间允许临时把条目 `version` 拔高（如 `99.0.0`）以触发提醒链路
   - 验收后恢复为真实版本，并把"发版同步更新 tools.json"写进其流程

验证：分支就位；`curl` 清单返回 200 且能取到 `ywcoder-cli` 条目。

### Phase 1 核心逻辑（纯逻辑，不依赖 UI）

实现 `src/utils/ywUpdateCheck.ts` + 单测，按"先纯函数、后副作用"顺序：

| 步 | 内容 | 验证（对应 §7） |
|---|---|---|
| 1 | 清单解析：条目提取（重复取第一条）、version 校验、平台匹配（§3.3） | §7.1–7.3、7.10 |
| 2 | 版本比较（currentVersion 参数注入，复用 `src/utils/semver.js` 的 `gt`） | §7.4 |
| 3 | 节流与缓存读写（含 hubRoot 串源作废） | §7.5、7.7 |
| 4 | 自定义禁用判定（D8）+ 各跳过条件 | §7.6（含"不调用 isAutoUpdaterDisabled 结论"回归断言） |
| 5 | 拉取（axios、1.5s、≤64KB、maxRedirects:0）+ 回调注册（pending 模式） | §7.8、7.9 |

验证：`bun test --max-concurrency=1` 全绿。

### Phase 2 UI 与挂载

1. `src/hooks/notifs/useYwCoderUpdateNotification.tsx`：挂载读缓存 + 订阅回调 → `addNotification`（`priority: 'medium'`）
2. 两处挂载共约 6 行：`REPL.tsx`（hook，检查随挂载 effect 触发）、`config.ts`（§5.2）

验证：`bun run build` 通过；本地构造"缓存里有更高版本"的 globalConfig，启动 REPL 能看到提醒。

### Phase 3 CI 与打包

```bash
bun run build
bun run smoke
bun test --max-concurrency=1
bun run security:pr-scan -- --base origin/main
```

验证：全部通过后由 CI 打出 dev 内网测试包。

### Phase 4 内网实机验收

用 CI 包装一台干净内网机器，按 §8 逐项勾选 A1–A10。三个重点盯：

- **A3 提醒链路**：依赖 hub 临时拔高 version（Phase 0 第 3 步的前置协调）
- **A2 与 A3 的顺序**：跑过 A3 的机器残留 `latestVersion` 缓存会干扰 A2，验收前先清 globalConfig 的 `ywcoderUpdateCheck` 字段
- **A9 平台匹配**：macOS 机器在现网清单下应**不提醒**；加 `macOS` 条目后提醒出现

验证：§8 全部勾完。

### Phase 5 发布配套、合并与观察

1. 发布侧配套落地（§9）：tools.json 恢复真实版本；发版 checklist 增加"同步更新 tools.json 的 version 与 packages"步骤
2. 内网验收通过后合并 main（main 是最后一步，不提前）
3. 内网使用文档补一句：提醒依赖 `ywdevhubUrl`，未配置则无提醒属预期
4. 发布后观察：提醒文案是否足够指引获取新包（决定 Q2/Q3 是否跟进）

验证：合并后 main CI 绿；文档发出。

### 外部依赖与风险

| 项 | 说明 | 应对 |
|---|---|---|
| tools.json 的 version 维护靠人工 | 现网停在 1.1.0，发版忘更新则功能形同虚设 | Phase 5 的 checklist 步骤是真正的生效开关；Phase 0 先与维护方对齐 |
| 验收需要拔高 version 触发提醒 | 直接改现网数据有短暂影响面 | 选低峰时段操作；或用测试 hub（改 `ywdevhubUrl` 指向）做 A3 |
| macOS 无包 | Mac 用户收不到提醒（行为正确但覆盖不全） | 不阻塞本功能；是否上架 mac 包是分发策略问题，单列跟进 |
