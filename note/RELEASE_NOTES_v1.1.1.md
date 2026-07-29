# YwCoder v1.1.1 发布说明

> **发布日期**：2026-05-14
> **升级路径**：v1.0.x → v1.1.1（含 v1.1.0 + v1.1.1 全部改动）
> **分发渠道**：Windows / Linux 离线 npm 包（.tgz）

---

## 一、升级亮点

### 1.1 内网模型网关支持（v1.1.0 主特性）

**痛点**：内网部署的 OpenAI 兼容网关接入 qwen2.5、deepseek 等模型，每个模型的真实上下文窗口各不相同（64K / 128K / 131072），但旧版 CLI 统一按 200K 硬编码，导致 auto-compact 永远触发不到，模型直接硬截断。

**改进**：

- ✅ **模型能力自动协商**：CLI 启动时自动从网关 `/v1/models` 拉取每个模型的 `context_length`，auto-compact 阈值用真实窗口计算
- ✅ **`YWCODER_INTRANET=1` 开关**：非 RFC1918 网段（如 76.x.x.x 段）的企业内网网关，通过此环境变量显式声明为内网，启用所有内网特性
- ✅ **`/model` 内网模式过滤**：选择器只展示网关发现的内网模型，自动屏蔽 `gpt-4o`、`claude-3-opus` 等公网硬编码预设，避免歧义
- ✅ **`/doctor` 新增 Model Capabilities 段落**：展示 scope、缓存模型列表、每个模型的 `context_length`
- ✅ **`/doctor` 缓存陈旧警告**：用户切换 BASE_URL 后 bootstrap 失败时会明确提示"缓存来自旧网关"
- ✅ **Provider 标签优化**：内网模式下显示为 `YwCoder-OpenAI协议网关`（替代通用 `Local OpenAI-compatible`）

### 1.2 配置迁移工具修复（v1.1.1 主修复）

**关键修复**——之前的 `ywcoder --migrate-config` 存在两个隐蔽 bug：

| 之前的行为                                                                                                                                                                                                          | 现在的行为                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 实际只迁移 `~/.claude.json` → `~/.ywcoder/.config.json`，但 `~/.claude/` 目录下的 `settings.json`、`agents/`、`skills/`、`projects/`、登录态 `.credentials.json` 等**全部没搬过去**，用户却看到"✓ 迁移完成"以为成功 | 完整迁移目录内容，并打印删除旧目录的命令清单（Linux / PowerShell / Windows cmd 三套）                                                |
| 早期用过 `~/.ywcoder` 目录、后来又回到 `~/.claude` 的用户，升级时旧 `~/.ywcoder` 会反向覆盖最新 `~/.claude` 配置（老配置赢）                                                                                        | 自动把历史 `~/.ywcoder` 重命名为 `~/.ywcoder.bak.<时间戳>` 备份，再用最新 `~/.claude` 干净迁移；备份目录保留，用户确认无误后可手动删 |

新增稳定性保护：

- 备份失败 / 复制失败时**不会让进程崩出**，转为标准退出码 + 中文错误提示
- 复制失败时打印一行可复制粘贴的回滚命令

### 1.3 品牌切换完成

- ✅ 配置目录正式启用 `~/.ywcoder`，老的 `~/.claude` 视作历史目录（通过 `--migrate-config` 一次性迁移）
- ✅ 替换全部遗漏的旧品牌字符串

### 1.4 工程改进

- ✅ 版本号管理与自动更新机制落地
- ✅ Linux 离线安装包工作流上线（之前仅有 Windows）

---

## 二、升级安装步骤（已装过 v1.0.x 的用户）

### 2.1 获取最新安装包

从 GitHub Actions 下载对应平台 artifact：

- **Windows**：`build-npm-windows-offline` workflow → `ywcoder-offline-windows` artifact → 解压得 `dcywzc-ywcoder-1.1.1.tgz`
- **Linux**：`build-npm-linux-offline` workflow → `ywcoder-offline-linux` artifact → 解压得 `dcywzc-ywcoder-1.1.1.tgz`

### 2.2 覆盖安装

在包含 `.tgz` 的目录执行：

```bash
# Windows / Linux / macOS 通用
npm install -g dcywzc-ywcoder-1.1.1.tgz
```

旧版会被自动替换。

### 2.3 验证版本

```bash
ywcoder --version
# 应显示 1.1.1 (YwCoder, build #..., 2026-05-14)
```

### 2.4 ⚠ 必做：迁移配置（重要）

升级后**务必在 shell 里直接执行**（不要在 ywcoder REPL 里执行，否则会被当成聊天消息发给 LLM）：

```bash
# Windows PowerShell / Linux  均可
ywcoder --migrate-config
```

会出现以下提示之一：

**场景 A（绝大多数老用户）**：从 `~/.claude/` 完整搬到 `~/.ywcoder/`

```
✓ 迁移全局配置文件 ~/.claude.json → ~/.ywcoder/.config.json
✓ 已将配置从 /home/<user>/.claude 迁移到 ~/.ywcoder
  你现在可以安全删除旧目录，根据使用的 shell 选择对应命令：
    Linux:        rm -rf /home/<user>/.claude
    PowerShell:   cmd /c rd /s /q "C:\Users\<user>\.claude"
    Windows cmd:  rmdir /s /q "C:\Users\<user>\.claude"
```

**场景 B（早期用过 ~/.ywcoder 的用户）**：自动备份后再迁移

```
ℹ 检测到历史 ~/.ywcoder，已备份至 /home/<user>/.ywcoder.bak.2026-05-14T10-30-00
  （如确认无用可手动删除）
✓ 迁移全局配置文件 ~/.claude.json → ~/.ywcoder/.config.json
✓ 已将配置从 /home/<user>/.claude 迁移到 ~/.ywcoder
  历史目录已备份至：/home/<user>/.ywcoder.bak.2026-05-14T10-30-00
  ...
```

**场景 C（已经在用 ~/.ywcoder 且没有老 ~/.claude）**：无需迁移

```
✓ 已在使用 ~/.ywcoder 配置目录
```

### 2.5 ⚠ 必做：运行最新版环境变量配置脚本

v1.1.x 新增 `YWCODER_INTRANET=1` 等环境变量，需要重新运行公司发布的环境变量配置脚本，否则内网模型自动协商、`/model` 内网过滤、Provider 标签等特性无法启用。

具体脚本路径请咨询部署同事或参考公司内部 wiki。

### 2.6 启动验证

```bash
ywcoder
```

进入 REPL 后运行 `/doctor`，查看 **Model Capabilities** 段落：

- 应显示 `scope: openai:http://<网关地址>`
- 应列出网关上的模型 + 每个模型的 `context_length`
- 如果显示「缓存来自旧网关，本次启动拉取失败」→ 检查 `OPENAI_BASE_URL` / 网关连通性 / `YWCODER_INTRANET` 环境变量

---

## 三、全新安装步骤（新机器/新用户）

### 3.1 准备环境

确保已安装 **Node.js >= 18.0.0**：

```bash
node --version
# 应显示 v18.x.x 或更高
```

未安装的请通过内网软件库 / U 盘 / 公司提供的 Node 安装包安装。

### 3.2 安装 YwCoder

```bash
npm install -g dcywzc-ywcoder-1.1.1.tgz
ywcoder --version  # 验证
```

### 3.3 运行环境变量配置脚本

向部署同事索取脚本，按平台执行（Windows: `.ps1`；Linux: `.sh`），脚本会写入必要的环境变量：

- `YWCODER_USE_OPENAI=1`
- `OPENAI_BASE_URL=http://<内网网关地址>/v1`
- `OPENAI_API_KEY=<你的 API Key>`
- `OPENAI_MODEL=<默认模型，如 qwen2.5-72b>`
- `YWCODER_INTRANET=1`（**关键**：声明为企业内网，启用所有内网特性）

### 3.4 启动

```bash
ywcoder
```

首次启动会自动从网关拉取模型列表 + 每个模型的 `context_length`，整个过程 fire-and-forget，通常 300ms 内完成。

---

## 四、升级常见问题

### Q1：升级后没运行 `--migrate-config` 会怎样？

CLI 会回退使用旧的 `~/.claude/` 目录（带黄色提示），功能可用但：

- 配置目录还在老位置，长期维护不便
- 部分新特性（如 `/doctor` 的 Model Capabilities 缓存路径）依赖新目录

建议升级当天就跑一次 `--migrate-config`。

### Q2：`--migrate-config` 后老的 `~/.claude` 怎么处理？

工具**不会自动删除**，避免误删。命令结束时会打印三套删除命令（Linux / PowerShell / Windows cmd），用户根据自己平台复制粘贴执行即可。

**建议**：先用新版 `~/.ywcoder` 工作 1-2 天确认无误，再删除老 `~/.claude`。

### Q3：早期用过 `~/.ywcoder` 的用户，备份目录 `~/.ywcoder.bak.<时间戳>` 怎么处理？

同 Q2，工具**不会自动删除**。确认新配置工作正常后可以手动删除：

```bash
# Linux / macOS
rm -rf ~/.ywcoder.bak.2026-05-14T10-30-00

# Windows PowerShell（用 cmd /c 调用 rd，规避 PowerShell -Recurse 在嵌套子目录上的已知 bug）
cmd /c rd /s /q "$HOME\.ywcoder.bak.2026-05-14T10-30-00"
```

### Q4：`/doctor` 看到「缓存来自旧网关」警告怎么办？

说明 CLI 启动时没能从当前 `OPENAI_BASE_URL` 成功拉取模型列表，正在用上次成功的快照兜底。排查顺序：

1. 检查 `OPENAI_BASE_URL` 是否拼写正确、能 ping 通
2. 检查 `OPENAI_API_KEY` 是否有效
3. 检查 `YWCODER_INTRANET=1` 是否设置（非 RFC1918 内网网关必须）
4. 重启 ywcoder 让 bootstrap 重跑

### Q5：在 ywcoder REPL 里输入了 `ywcoder --migrate-config`，看到一堆 Agent 错误？

**这是错误用法**——CLI 标志只能在 shell 里执行，REPL 里输入会被当成聊天消息发给 LLM，LLM 试图执行迁移时会触发 Agent 工具的 worktree 错误。

正确做法：先用 `/exit` 退出 REPL，回到 PowerShell / bash，再执行 `ywcoder --migrate-config`。

### Q6：升级失败怎么回退？

```bash
# 卸载新版
npm uninstall -g @dcywzc/ywcoder

# 重装 v1.0.x 旧 tgz（保留好的话）
npm install -g dcywzc-ywcoder-1.0.x.tgz
```

配置目录方面：

- 如果还没跑 `--migrate-config`，`~/.claude` 原封不动，回退即用
- 如果已跑了 `--migrate-config`，`~/.claude` 也保留着（工具不删），回退后 v1.0.x 会继续用 `~/.claude`

---

## 五、变更摘要

### v1.1.0 → v1.1.1 修复

- `fix: 修复 --migrate-config 在双目录场景下漏拷贝与老配置反向覆盖` (4888d78)

### v1.0.x → v1.1.0 主要变更

- `feat: 内网模型网关 context_length 自报告，自动用真实窗口计算 auto-compact 阈值` (36a8c25)
- `feat: 新增 ywcoder --migrate-config 配置迁移工具` (b3cd56b)
- `feat: 完成品牌替换与配置迁移` (d3e918c)
- `feat: 版本号管理与自动更新机制落地` (f87df67)
- `feat: 新增 Linux 离线安装包工作流` (27bece9)
- `fix: 增加 YWCODER_INTRANET 开关，识别非 RFC1918 内网网关` (6fb92be)
- `fix: Provider 标签在 YWCODER_INTRANET=1 时显示为 YwCoder-OpenAI协议网关` (f41aaea)
- `fix: /doctor 显示磁盘缓存与当前 BASE_URL 的 scope 不一致警告` (25d836f)
- `fix: 替换遗漏的 Open Claude 硬编码字符串为 YwCoder/ywcoder` (436d25d)

详细技术实现见 `note/internal-model-config-gateway/04-internal-model-implementation-summary-0506.md`。

---

## 六、反馈与支持

升级或使用过程中遇到问题，请通过公司内部 IM / 工单系统反馈，附上：

1. 操作系统 + 版本
2. `ywcoder --version` 输出
3. 出问题命令的完整输出截图
4. `/doctor` 的输出截图（如能进入 REPL）
