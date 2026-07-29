#!/usr/bin/env bash
# YWCODER 内网部署脚本（智能合一版 · 适配 Linux）
# 一个脚本搞定：安装/更新 + 写配置 + 自动清理旧 shell 残留。新老用户通用、可反复运行。
#
# 行为：
#   - key / 网关地址：首次运行交互询问一次，写入 ~/.ywcoder/settings.json；
#     之后再运行，若 settings.json 已有值则直接复用、不再询问。
#   - 每次都顺手清理 shell rc 里旧的 export 残留（仅在确有残留时才动）。
#
# 用法：
#   bash ywcoder-setup.sh                 # 装/更新 + 配置（首次问，之后复用）
#   bash ywcoder-setup.sh --reconfigure   # 强制重新输入 key/地址（换网关 / 轮换 key 时用）

# 确保用 bash 运行：有人用 sh 跑会因 pipefail 等 bash 特性报错，这里自动切回 bash
if [ -z "${BASH_VERSION:-}" ]; then exec bash "$0" "$@"; fi
set -euo pipefail

# ===== 运维可预填（留空则首次运行时交互询问；模型建议预填）=====
# 离线安装包：管理员每次把下载好的 .tgz 文件名填这里（更新版本就改这一行）
PKG_FILE="${YW_PKG_FILE:-./dcywzc-ywcoder-1.2.1.tgz}"
DEFAULT_API_KEY="${YW_API_KEY:-}"         # 共享一个 key 可填这里；留空=问用户
DEFAULT_BASE_URL="${YW_BASE_URL:-}"       # 网关地址；留空=问用户
DEFAULT_MODEL="${YW_MODEL:-Qwen3.5-27B}"  # 模型名（ASCII 连字符，且与网关一致）
# =======================================================================

GREEN='\033[32m'; YELLOW='\033[33m'; RED='\033[31m'; NC='\033[0m'
info(){ echo -e "${GREEN}$*${NC}"; }
warn(){ echo -e "${YELLOW}$*${NC}"; }
err(){ echo -e "${RED}$*${NC}" >&2; }

RECONFIG=0; [ "${1:-}" = "--reconfigure" ] && RECONFIG=1
CONFIG_DIR="$HOME/.ywcoder"; SETTINGS="$CONFIG_DIR/settings.json"
MANAGED_VARS=(
  YWCODER_USE_OPENAI YWCODEDR_USE_OPENAI CLAUDE_CODE_USE_OPENAI
  OPENAI_API_KEY OPENAI_BASE_URL OPENAI_API_BASE OPENAI_MODEL
  YWCODER_INTRANET CLAUDE_CODE_INTRANET
)

command -v npm >/dev/null || { err "未找到 npm，请先安装 Node/npm"; exit 1; }

# ---------- 读 settings.json 里已有的值（jq/python3，缺则返回空）----------
read_setting(){
  local k="$1"
  [ -f "$SETTINGS" ] || { echo ""; return; }
  if command -v jq >/dev/null; then
    jq -r --arg k "$k" '.env[$k] // empty' "$SETTINGS" 2>/dev/null || echo ""
  elif command -v python3 >/dev/null; then
    YW_S="$SETTINGS" YW_K="$k" python3 -c 'import json,os
try: d=json.load(open(os.environ["YW_S"]))
except Exception: d={}
print((d.get("env",{}) or {}).get(os.environ["YW_K"],"") or "")' 2>/dev/null || echo ""
  else
    echo ""
  fi
}

# ---------- 决定 key / url / model ----------
# 优先级：settings.json 已有 → 当前 shell 环境变量(老用户迁移) → 运维预填 → 交互询问
EXIST_KEY="$(read_setting OPENAI_API_KEY)"
EXIST_URL="$(read_setting OPENAI_BASE_URL)"
EXIST_MODEL="$(read_setting OPENAI_MODEL)"

# 老用户用 export 配过的值此刻就在本进程环境里(子进程继承)；:- 防 set -u 报错
ENV_KEY="${OPENAI_API_KEY:-}"
ENV_URL="${OPENAI_BASE_URL:-${OPENAI_API_BASE:-}}"
ENV_MODEL="${OPENAI_MODEL:-}"

API_KEY=""; BASE_URL=""; OPENAI_MODEL=""; FROM_ENV=0
# 模型：始终复用(settings.json → 环境 → 默认)，--reconfigure 也不重置它
[ -n "$EXIST_MODEL" ] && OPENAI_MODEL="$EXIST_MODEL"
[ -z "$OPENAI_MODEL" ] && [ -n "$ENV_MODEL" ] && OPENAI_MODEL="$ENV_MODEL"
if [ "$RECONFIG" != 1 ]; then
  # 1) settings.json 已有
  [ -n "$EXIST_KEY" ] && API_KEY="$EXIST_KEY"
  [ -n "$EXIST_URL" ] && BASE_URL="$EXIST_URL"
  # 2) 退到当前环境变量(老用户自动迁移)
  [ -z "$API_KEY" ]  && [ -n "$ENV_KEY" ] && { API_KEY="$ENV_KEY"; FROM_ENV=1; }
  [ -z "$BASE_URL" ] && [ -n "$ENV_URL" ] && { BASE_URL="$ENV_URL"; FROM_ENV=1; }
fi
# 3) 运维预填 → 4) 交互询问（--reconfigure 时 EXIST/ENV 不复用 → 必然重问 key/url）
[ -z "$API_KEY" ]      && API_KEY="$DEFAULT_API_KEY"
[ -z "$BASE_URL" ]     && BASE_URL="$DEFAULT_BASE_URL"
[ -z "$OPENAI_MODEL" ] && OPENAI_MODEL="$DEFAULT_MODEL"
if [ -z "$API_KEY" ]; then read -rsp "请输入网关 API Key: " API_KEY; echo; fi
if [ -z "$BASE_URL" ]; then read -rp "请输入网关地址 (OPENAI_BASE_URL，形如 http://gw/v1): " BASE_URL; fi
[ -z "$API_KEY" ]  && { err "未提供 API Key，退出"; exit 1; }
[ -z "$BASE_URL" ] && { err "未提供网关地址，退出"; exit 1; }
[ "$FROM_ENV" = 1 ] && info "  检测到旧的环境变量配置，已自动迁移到 settings.json（稍后清理 shell 里的旧 export）。"
info "本次配置：地址=$BASE_URL  模型=$OPENAI_MODEL  key=***(已隐藏)"

# ---------- 1. 清理旧 shell 残留（仅当确有 managed export 才动）----------
info "[1/4] 检查并清理旧 shell 环境变量残留..."
rc_has_managed(){ local rc="$1" v; [ -f "$rc" ] || return 1; for v in "${MANAGED_VARS[@]}"; do grep -qE "^[[:space:]]*export[[:space:]]+$v=" "$rc" && return 0; done; return 1; }
cleaned=0
for rc in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.bash_profile" "$HOME/.profile"; do
  if rc_has_managed "$rc"; then
    cp "$rc" "$rc.ywbak.$(date +%s)"
    for v in "${MANAGED_VARS[@]}"; do sed -i "/^[[:space:]]*export[[:space:]]\+$v=/d" "$rc"; done
    info "  已清理 $rc（备份 .ywbak.*）"; cleaned=1
  fi
done
[ "$cleaned" = 0 ] && info "  无旧残留，跳过。"
[ "$cleaned" = 1 ] && warn "  注意：当前已打开的终端里旧变量仍在内存，重开终端/重新登录后才彻底失效。"

# ---------- 2. 安装/更新（离线本地包）----------
info "[2/4] 安装/更新 ywcoder（离线包：$PKG_FILE）..."
[ -e "$PKG_FILE" ] || { err "安装包不存在：$PKG_FILE （把 .tgz 放到当前目录并核对文件名/顶部 PKG_FILE）"; exit 1; }
npm install -g "$PKG_FILE"
command -v ywcoder >/dev/null || { err "ywcoder 不在 PATH 中，检查 npm 全局 bin 目录是否已加入 PATH"; exit 1; }
info "  版本：$(ywcoder --version 2>/dev/null || echo '?')"

# ---------- 3. 写配置到 settings.json（jq/python3 安全合并，缺则备份后整写）----------
info "[3/4] 写入配置到 $SETTINGS ..."
mkdir -p "$CONFIG_DIR"
if command -v jq >/dev/null; then
  base="{}"; [ -f "$SETTINGS" ] && base="$(cat "$SETTINGS")"
  tmp="$(mktemp)"
  printf '%s' "$base" | jq \
    --arg k "$API_KEY" --arg u "$BASE_URL" --arg m "$OPENAI_MODEL" \
    '.env = ((.env // {}) + {YWCODER_USE_OPENAI:"1", OPENAI_API_KEY:$k, OPENAI_BASE_URL:$u, OPENAI_MODEL:$m, YWCODER_INTRANET:"1"})' \
    > "$tmp" && mv "$tmp" "$SETTINGS"
  info "  （jq 合并，保留其它已有设置）"
elif command -v python3 >/dev/null; then
  YW_K="$API_KEY" YW_U="$BASE_URL" YW_M="$OPENAI_MODEL" YW_S="$SETTINGS" python3 - <<'PY'
import json, os
p = os.environ['YW_S']
try:
    d = json.load(open(p))
    if not isinstance(d, dict): d = {}
except Exception:
    d = {}
d.setdefault('env', {}).update({
    'YWCODER_USE_OPENAI': '1',
    'OPENAI_API_KEY':     os.environ['YW_K'],
    'OPENAI_BASE_URL':    os.environ['YW_U'],
    'OPENAI_MODEL':       os.environ['YW_M'],
    'YWCODER_INTRANET':   '1',
})
json.dump(d, open(p, 'w'), indent=2, ensure_ascii=False)
PY
  info "  （python3 合并，保留其它已有设置）"
else
  [ -f "$SETTINGS" ] && { cp "$SETTINGS" "$SETTINGS.ywbak.$(date +%s)"; warn "  无 jq/python3：已备份后整写（其它设置如有见备份）"; }
  cat > "$SETTINGS" <<EOF
{
  "env": {
    "YWCODER_USE_OPENAI": "1",
    "OPENAI_API_KEY": "${API_KEY}",
    "OPENAI_BASE_URL": "${BASE_URL}",
    "OPENAI_MODEL": "${OPENAI_MODEL}",
    "YWCODER_INTRANET": "1"
  }
}
EOF
  warn "  （无 jq/python3：整写；key 含特殊字符时可能产生非法 JSON，建议装 jq）"
fi
chmod 600 "$SETTINGS"
info "  配置已写入（已 chmod 600）"

# ---------- 4. 冒烟自检（非交互 -p，连一次网关）----------
info "[4/4] 网关连通自检..."
if timeout 60 ywcoder -p "只回复 ok" >/tmp/ywcoder_smoke.$$ 2>&1; then
  info "  网关连通 ✓（回复：$(head -c 80 /tmp/ywcoder_smoke.$$ | tr -d '\n')）"
else
  warn "  自检未通过/超时。手动运行 ywcoder 排查；若刚清理过残留，先重开终端。输出：/tmp/ywcoder_smoke.$$"
fi
rm -f /tmp/ywcoder_smoke.$$ 2>/dev/null || true

echo
info "完成。直接运行  ywcoder  即可使用。后续更新再跑本脚本即可（配置会自动复用、无需重输）。"
