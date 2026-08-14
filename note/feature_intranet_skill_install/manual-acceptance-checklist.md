# /skill-install 手动验证清单（v1.3.0 内网测试包）

> 对应分支：`feature/ywmatrix-shim`
> 本轮新增 commit:`ec110df`（列表 --project 项目级视角）、`8ce59e4`（审查可选项三项）、`ba6f12e`(bump 1.3.0)
> 设计依据：`design-option1-lite.md` §14 验收标准 + 本轮 scope 变更（§2/§2.2）

## 0. 准备

- [ ] 一台干净内网机（或先备份 `~/.ywcoder` 与测试项目的 `.ywcoder`/`.claude` 目录）
- [ ] 安装 1.3.0 测试包，`ywcoder --version` 显示 1.3.0
- [ ] 确认能访问 `http://<hub>/yw-devhub/skills.json`(curl 返回顶层数组）

## 1. 配置

- [ ] **C1-未配置提示**：不配置 `ywdevhubUrl`，执行 `/skill-install` → 报错含 settings.json 完整路径与示例 JSON
- [ ] **C2-配置生效**：在 `~/.ywcoder/settings.json` 写入 `"ywdevhubUrl": "http://<hub>/yw-devhub/"`（故意不带尾斜杠）→ `/skill-install` 正常列出清单（验证尾斜杠归一化）
- [ ] **C3-project 配置不生效**：把 `ywdevhubUrl` 只写进项目 `.ywcoder/settings.json`（用户级不配）→ `/skill-install` 仍报未配置

## 2. 列表与四态（user 视角）

- [ ] **L1**:`/skill-install` 弹窗标题为 `内网 Skill 安装（用户级）— <hub地址>`，footer 有风险提示
- [ ] **L2-四态**：分别验证 未安装 / `(已安装)` / `(已安装 v旧 → 可更新)` / `(本地已存在，来源未知)` 四种标签——可用一个手工复制的 skill 目录制造"来源未知"
- [ ] **L3**：条目超 10 条时滚动正常，数字键直选正常，Esc 取消正常

## 3. 列表 scope（本轮新增，重点）

- [ ] **S1**:`/skill-install --project` 标题显示**项目级**,footer 多一行"项目级 skill 的全部内容将随仓库提交"
- [ ] **S2**：项目级列表中安装一个 skill → 落到 `<项目>/.ywcoder/skills/<id>/`（或 `.claude`，视 flag)，结果路径与磁盘一致；目录内有 `.ywcoder-source.json`
- [ ] **S3-状态隔离**：同一 id 在 user 装 v1.0、project 装不同版本 → 两个列表各自显示正确版本状态，互不干扰
- [ ] **S4**：项目级列表里选"来源未知"条目 → 二次确认文案中的路径是**项目目录**路径；点"取消"返回列表，目录未被改动
- [ ] **S5**：项目级安装后 `git status` 能看到 skill 内容 + sidecar（确认这是预期行为）

## 4. 安装 / 更新 / 幂等（带参数形态）

- [ ] **I1**:`/skill-install <id>` 全新安装 → `/skills` 与斜杠菜单**无需重启**出现新 skill（已知边界：若未出现，记录反馈，启用 §10 预案）
- [ ] **I2-幂等**：重复执行同一安装 → 提示"已是最新版本"，目录 mtime 不变
- [ ] **I3-更新**：服务端 bump 版本后再装 → 显示 `v旧 → v新`,sidecar 版本同步
- [ ] **I4-收编**：手工目录（无 sidecar)+ `--force` → 覆盖并补写 sidecar；不加 `--force` → 报错文案含"永久删除"与 `--force` 引导
- [ ] **I5-卸载**:`/skill-install --remove <id>` 成功，斜杠菜单同步消失；`/skill-install --remove <手工目录id>` → 拒绝并打印实际路径

## 5. 健壮性

- [ ] **B1**：下载中途断网（拔网线/关 hub)→ 旧版本完好；再次执行安装正常，无 `skills-staging/` 残留
- [ ] **B4-遗留恢复**：手工把某个已装 skill 目录改名为 `skills-staging/<id>.old` 并删掉原目录 → 再执行一次安装 → 旧版本先被恢复再更新，无报错
- [ ] **B5-并发**：两个终端同时 `/skill-install <同一id>` → 最终目录是某一次完整安装，无混合文件

## 6. 安全

- [ ] **C4**：清单里构造 `id: "../evil"` 的测试条目 → 该条显示"（仅查看）"不可选中，其余条目正常
- [ ] **C5**：开启 `strictPluginOnlyCustomization` 策略 → 安装被拒、提示明确，`--force` 无法绕过；`--remove` 仍能卸载已装目录

## 备注

- "交互取消显示'已取消安装'"这条在列表 UI 不可达（UI 层自己拦截取消），已由单测覆盖，无需手验
- filename 路径字符校验（审查可选项 6）需服务端配合构造清单才能验证，可跳过
- 全部通过后按仓库规矩合并 main；slash 菜单刷新（I1）和 project 目录名（S2）是两个已知边界，重点盯
