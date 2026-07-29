# YwCoder 升级须知（面向内网用户 · 可直接转发）

> 日期：2026-06-12 · 适用版本：v1.2.0

升级后绝大部分配置**自动兼容，无需操作**。三件事说明一下：

## 1. 配置目录 — 先判断，别无脑跑迁移命令

看家目录有没有 `~/.ywcoder` 文件夹：
- **已有** → 你已经迁移过了，**不要再跑** `ywcoder --migrate-config`（重复跑会把当前配置回退）
- **没有** → 跑一次 `ywcoder --migrate-config` 即可

一键判断：
- **Windows**：`if (Test-Path "$HOME\.ywcoder") { "✓已迁移，无需操作" } else { "→请运行 ywcoder --migrate-config" }`
- **Linux**：`[ -d ~/.ywcoder ] && echo "✓已迁移，无需操作" || echo "→请运行 ywcoder --migrate-config"`

或者更简单：直接启动 `ywcoder`，**只有**弹出黄色"正在使用历史配置目录 ~/.claude"提示时才需要迁移。

## 2. 记忆文件（CLAUDE.md）— 什么都不用做

你项目里现有的 `CLAUDE.md` **照常生效**，不会被改名、不用迁移。

⚠️ 唯一注意：**别手动建一个空的 `YWCODER.md`**，否则会屏蔽掉你有内容的 `CLAUDE.md`。

## 3. 环境变量脚本 — 照旧用，无需修改

现有的 PowerShell / Linux 配置脚本**不用动**。特别提醒：
- **不要删 `CLAUDE_CODE_USE_OPENAI`**（暂时还需要它）（2026-06-17 更新：fallback 已补完整，现已可只用 `YWCODER_USE_OPENAI`，旧名可安全删除）
- `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL` 保持不变
- `YWCODER_INTRANET=1` 已是新名，正确

---

**底层原因**（供答疑参考）：配置目录迁移当前**不幂等**（所以要先判断）、记忆文件是**读取兼容**（所以零操作）、环境变量 fallback **尚不完整**（所以留着旧名）。
