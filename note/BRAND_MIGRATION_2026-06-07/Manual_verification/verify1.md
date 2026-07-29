F2 真机登录验证步骤
背景：F2 改的是 getGlobalClaudeFile() —— 全局 auth 配置文件的路径解析（登录态存在该文件的 oauthAccount 字段）。验证目标是确保三分支逻辑 + F2 修复点都正确。

前置：用打包产物验证（bun run build 已生成 dist/cli.mjs）。建议用隔离目录避免污染真实登录态——下面用临时 HOME 或自定义 config dir。

验证判据（每个场景都查这两项）
落点：哪个文件出现/更新了 oauthAccount 字段 → grep -l oauthAccount <候选文件>
登录态保留：启动后是否无需重新登录（已登录直接进入，而非弹登录流程）
场景 1 · 纯新装登录落 .config.json（branch 3）

# 隔离环境：自定义 config dir，确保 .config.json 与 ~/.claude.json 都不存在

export YWCODER_CONFIG_DIR=/tmp/yw-test-new
rm -rf /tmp/yw-test-new && mkdir -p /tmp/yw-test-new

# 确认无干扰文件

ls -la /tmp/yw-test-new ~/.claude.json 2>/dev/null
启动 ywcoder → 完成登录 → 预期：oauthAccount 写入 /tmp/yw-test-new/.config.json，不生成 ~/.claude.json。

场景 2 · 存量 legacy 登录态保留（branch 2）

unset YWCODER_CONFIG_DIR CLAUDE_CONFIG_DIR

# 此时已存在真实 ~/.claude.json（或旧版 ywcoder 登录态）

grep -l oauthAccount ~/.claude.json # 确认存量登录态存在
启动 ywcoder → 预期：直接读到 ~/.claude.json 登录态，无需重新登录，不被新 .config.json 抢走。

场景 3 · F2 核心修复点：只设 YWCODER_CONFIG_DIR 时不被 ~/.claude.json 抢走

# 只设 YWCODER_CONFIG_DIR（不设 CLAUDE_CONFIG_DIR），且自定义目录是全新的

export YWCODER_CONFIG_DIR=/tmp/yw-test-custom
unset CLAUDE_CONFIG_DIR
rm -rf /tmp/yw-test-custom && mkdir -p /tmp/yw-test-custom

# 关键：机器上存在存量 ~/.claude.json（模拟装过官方 CC）

grep -l oauthAccount ~/.claude.json # 确认存量文件在
启动 ywcoder → 完成登录 → 预期（修复后）：oauthAccount 落 /tmp/yw-test-custom/.config.json，不读取 ~/.claude.json。

这是回归点：修复前会因 legacyFile 用 CLAUDE_CONFIG_DIR || homedir() 命中 ~/.claude.json，错误返回它（用旧账号鉴权）。修复后 legacyFile 跟随 YWCODER_CONFIG_DIR，/tmp/yw-test-custom/.claude\*.json 不存在 → 正确落新装默认。

场景 4 · 已迁移用户（branch 1）

export YWCODER_CONFIG_DIR=/tmp/yw-test-migrated
rm -rf /tmp/yw-test-migrated && mkdir -p /tmp/yw-test-migrated

# 预置一个含登录态的 .config.json（可从场景1登录后的文件拷过来）

启动 ywcoder → 预期：直接用 /tmp/yw-test-migrated/.config.json，无回退、无需重新登录。

收尾

unset YWCODER_CONFIG_DIR CLAUDE_CONFIG_DIR
rm -rf /tmp/yw-test-\*
重点是场景 3——它是 F2 唯一改变的行为路径；场景 1/2/4 是确保修复没有破坏原三分支。已有单测（env.test.ts）覆盖了路径选择逻辑，但真机跑通登录流程能确认 oauthAccount 实际读写与 token 不丢失，这是单测替代不了的。

需要我把这套验证步骤也追加到 backlog 或 review 文档里留档吗？
