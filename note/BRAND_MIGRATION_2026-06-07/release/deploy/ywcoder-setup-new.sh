#!/usr/bin/env bash
# YWCODER 内网部署脚本（全新用户版 · 适配 Linux）
# 仅用于「干净机器 / 从未配置过」的用户：安装 + 写配置，不做任何清理。
# 存量用户（之前用 export 配过环境变量）请改用 ywcoder-setup.sh --reset。
#
# 配置值可在下方直接改，或用环境变量覆盖：
#   YW_API_KEY=sk-xxx YW_BASE_URL=http://gw/v1 bash ywcoder-setup-new.sh

# 确保用 bash 运行：有人用 sh 跑会因 pipefail 等 bash 特性报错，这里自动切回 bash
if [ -z "${BASH_VERSION:-}" ]; then exec bash "$0" "$@"; fi
set -euo pipefail

# ===================== 可配置项（部署前改这里）=====================
# 离线安装包：管理员每次把下载好的 .tgz 文件名填这里（更新版本就改这一行）
PKG_FILE="${YW_PKG_FILE:-./dcywzc-ywcoder-1.2.1.tgz}"
API_KEY="${YW_API_KEY:-<你的key>}"
OPENAI_BASE_URL="${YW_BASE_URL:-http://<网关>/v1}"
OPENAI_MODEL="${YW_MODEL:-Qwen3.5-27B}"        # ASCII 连字符，且与网关一致
# ===================================================================

GREEN='\033[32m'; YELLOW='\033[33m'; RED='\033[31m'; NC='\033[0m'
info(){ echo -e "${GREEN}$*${NC}"; }
warn(){ echo -e "${YELLOW}$*${NC}"; }
err(){ echo -e "${RED}$*${NC}" >&2; }

CONFIG_DIR="$HOME/.ywcoder"
SETTINGS="$CONFIG_DIR/settings.json"

command -v npm >/dev/null || { err "未找到 npm，请先安装 Node/npm"; exit 1; }

# ---------- 0. key / 网关地址 未预填则交互式询问一次（模型由运维预填）----------
if [ -z "$API_KEY" ] || [ "$API_KEY" = "<你的key>" ]; then
  read -rsp "请输入网关 API Key: " API_KEY; echo
  [ -z "$API_KEY" ] && { err "未输入 key，退出"; exit 1; }
fi
if [ -z "$OPENAI_BASE_URL" ] || [ "$OPENAI_BASE_URL" = "http://<网关>/v1" ]; then
  read -rp "请输入网关地址 (OPENAI_BASE_URL，形如 http://gw/v1): " OPENAI_BASE_URL
  [ -z "$OPENAI_BASE_URL" ] && { err "未输入网关地址，退出"; exit 1; }
fi

# ---------- 1. 安装（离线本地包）----------
info "[1/3] 安装 ywcoder（离线包：$PKG_FILE）..."
[ -e "$PKG_FILE" ] || { err "安装包不存在：$PKG_FILE （把 .tgz 放到当前目录并核对文件名/顶部 PKG_FILE）"; exit 1; }
npm install -g "$PKG_FILE"
command -v ywcoder >/dev/null || { err "ywcoder 不在 PATH 中，检查 npm 全局 bin 目录是否已加入 PATH"; exit 1; }
info "  版本：$(ywcoder --version 2>/dev/null || echo '?')"

# ---------- 2. 写配置（全新用户：直接写，不合并）----------
info "[2/3] 写配置到 $SETTINGS ..."
mkdir -p "$CONFIG_DIR"
if [ -f "$SETTINGS" ]; then
  warn "  检测到已存在 $SETTINGS —— 本脚本面向全新用户、不做合并，将备份后覆盖。"
  warn "  若需保留其它已有设置，请改用 ywcoder-setup.sh（jq/python3 合并）。"
  cp "$SETTINGS" "$SETTINGS.ywbak.$(date +%s)"
fi
cat > "$SETTINGS" <<EOF
{
  "env": {
    "YWCODER_USE_OPENAI": "1",
    "OPENAI_API_KEY": "${API_KEY}",
    "OPENAI_BASE_URL": "${OPENAI_BASE_URL}",
    "OPENAI_MODEL": "${OPENAI_MODEL}",
    "YWCODER_INTRANET": "1"
  }
}
EOF
chmod 600 "$SETTINGS"
info "  配置已写入（已 chmod 600）。"
warn "  注：key 含引号/反斜杠等特殊字符时此处可能产生非法 JSON；如有此情况请用 ywcoder-setup.sh（走 jq 转义）。"

# ---------- 3. 冒烟自检 ----------
info "[3/3] 网关连通自检（ywcoder -p）..."
if timeout 60 ywcoder -p "只回复 ok" >/tmp/ywcoder_smoke.$$ 2>&1; then
  info "  网关连通 ✓（回复：$(head -c 80 /tmp/ywcoder_smoke.$$ | tr -d '\n')）"
else
  warn "  自检未通过/超时，请手动运行  ywcoder  发一句话排查。详细输出：/tmp/ywcoder_smoke.$$"
fi
rm -f /tmp/ywcoder_smoke.$$ 2>/dev/null || true

echo
info "完成。直接运行  ywcoder  即可使用。"
