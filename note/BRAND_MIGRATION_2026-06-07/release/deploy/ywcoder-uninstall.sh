#!/usr/bin/env bash
# YWCODER 卸载/还原脚本（适配 Linux）
# 作用：卸载 npm 包 + 移除 ~/.ywcoder 配置 + 清理 shell rc 里的旧 export，
#       让机器回到“干净未安装”状态，方便反复测试。
# 用法：
#   bash ywcoder-uninstall.sh          # 交互确认后执行
#   bash ywcoder-uninstall.sh -y       # 跳过确认

# 确保用 bash 运行：有人用 sh 跑会因 pipefail 等 bash 特性报错，这里自动切回 bash
if [ -z "${BASH_VERSION:-}" ]; then exec bash "$0" "$@"; fi
set -euo pipefail

GREEN='\033[32m'; YELLOW='\033[33m'; RED='\033[31m'; NC='\033[0m'
info(){ echo -e "${GREEN}$*${NC}"; }
warn(){ echo -e "${YELLOW}$*${NC}"; }
err(){ echo -e "${RED}$*${NC}" >&2; }

MANAGED_VARS=(
  YWCODER_USE_OPENAI YWCODEDR_USE_OPENAI CLAUDE_CODE_USE_OPENAI
  OPENAI_API_KEY OPENAI_BASE_URL OPENAI_API_BASE OPENAI_MODEL
  YWCODER_INTRANET CLAUDE_CODE_INTRANET
)

YES=0
[ "${1:-}" = "-y" ] && YES=1
if [ "$YES" != 1 ]; then
  warn "将执行：卸载 npm 包 [@dcywzc/ywcoder]、移除 ~/.ywcoder、清理 shell rc 旧配置。"
  read -rp "确认继续？[y/N] " ans
  case "$ans" in y|Y) ;; *) echo "已取消"; exit 0;; esac
fi

# ---------- 1. 卸载 npm 包 ----------
info "[1/3] 卸载 npm 包..."
if command -v npm >/dev/null; then
  npm uninstall -g @dcywzc/ywcoder 2>/dev/null && info "  已卸载 @dcywzc/ywcoder" || warn "  跳过（可能未安装）"
else
  warn "  未找到 npm，跳过"
fi

# ---------- 2. 移除 ~/.ywcoder（mv 备份，非直接 rm，可恢复）----------
info "[2/3] 移除配置目录..."
if [ -d "$HOME/.ywcoder" ]; then
  dst="$HOME/.ywcoder.removed.$(date +%s)"
  mv "$HOME/.ywcoder" "$dst"
  info "  ~/.ywcoder 已移到 $dst"
  warn "  如需彻底删除：rm -rf \"$dst\""
else
  info "  ~/.ywcoder 不存在，跳过"
fi
# 注：~/.claude.json（存量/官方 CC 登录态）不在本脚本处理范围，刻意不动。

# ---------- 3. 清理 shell rc 里的旧 export ----------
info "[3/3] 清理 shell 环境变量配置..."
clean_rc(){
  local rc="$1"; [ -f "$rc" ] || return 0
  cp "$rc" "$rc.ywbak.$(date +%s)"
  local v
  for v in "${MANAGED_VARS[@]}"; do
    sed -i "/^[[:space:]]*export[[:space:]]\+$v=/d" "$rc"
  done
  info "  已清理 $rc（备份 .ywbak.*）"
}
for rc in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.bash_profile" "$HOME/.profile"; do
  clean_rc "$rc"
done

echo
info "完成。机器已还原到干净状态。"
warn "当前终端里旧的环境变量仍在内存中，重开终端/重新登录后彻底失效。"
