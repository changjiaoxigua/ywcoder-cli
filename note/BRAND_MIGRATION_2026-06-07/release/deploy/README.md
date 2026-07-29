# YWCODER 内网部署脚本

三个脚本,覆盖"安装/更新、配置、卸载"。适配 Linux(用 `sh`/`bash`/`./` 跑都行,脚本会自动切到 bash)。

| 脚本 | 作用 |
|---|---|
| `ywcoder-setup.sh` | **主力脚本**:安装/更新 + 写配置 + 自动清理旧 shell 残留。新老用户通用、可反复跑 |
| `ywcoder-setup-new.sh` | 全新用户精简版:只装 + 写配置,不做清理(机器确认干净时用) |
| `ywcoder-uninstall.sh` | 卸载 + 移除 `~/.ywcoder` 配置 + 清理 shell 残留,还原到干净状态 |

---

## 准备工作(运维做一次)

1. **拿到离线安装包** `.tgz`(由 `npm pack` 产出,如 `dcywzc-ywcoder-1.2.1.tgz`),和脚本放同一目录。
2. **编辑脚本顶部"可配置项"**,至少改这一行为实际包名:
   ```bash
   PKG_FILE="${YW_PKG_FILE:-./dcywzc-ywcoder-1.2.1.tgz}"   # 改成实际的 .tgz 文件名
   ```
3. 网关地址/key/模型可选:
   - **共享 key**:把 `YW_API_KEY` / `YW_BASE_URL` / `YW_MODEL` 对应的默认值填进脚本顶部 → 用户跑时零输入;
   - **每人一个 key**:留空 → 用户首次跑时**交互输入一次**(之后自动复用)。
4. **建议装 `jq`**(`yum install jq` / `apt install jq`):写配置时安全合并、正确转义。没有也能跑(自动退到 python3,再没有就整文件覆盖)。

> 前置依赖:目标机器需有 Node/npm。离线安装不连外网。

---

## 用法

### 1. 安装 / 更新 / 配置 —— `ywcoder-setup.sh`(主力)

```bash
bash ywcoder-setup.sh
```
它会依次:
1. 解析配置 —— 优先级:**`~/.ywcoder/settings.json` 已有值 → 当前 shell 环境变量(老用户自动迁移) → 运维预填 → 交互询问**;
2. 清理 `~/.bashrc` / `~/.zshrc` 等里旧的 `export`(含历史 typo `YWCODEDR_USE_OPENAI`,仅在确有残留时才动并备份);
3. 离线安装/更新 ywcoder;
4. 把配置写入 `~/.ywcoder/settings.json`;
5. 用 `ywcoder -p` 连一次网关做冒烟自检。

**首次**会问 key/网关(若运维没预填);**之后再跑**(如更新版本)会自动复用已有配置,**不再询问**。

### 2. 全新用户精简版 —— `ywcoder-setup-new.sh`

```bash
bash ywcoder-setup-new.sh
```
仅适合**确认干净、从没配过**的机器:只装 + 写配置,**不做任何清理**。key/网关未预填时也会交互询问一次。
> 存量用户(之前用 `export` 配过)请用 `ywcoder-setup.sh`,它会自动迁移并清理旧配置。

### 3. 卸载 / 还原 —— `ywcoder-uninstall.sh`

```bash
bash ywcoder-uninstall.sh        # 交互确认后执行
bash ywcoder-uninstall.sh -y     # 跳过确认
```
卸载 npm 包(`npm uninstall -g @dcywzc/ywcoder`)+ 把 `~/.ywcoder` 移到 `~/.ywcoder.removed.<时间戳>`(可恢复)+ 清理 shell 残留。**不动** `~/.claude.json`。

---

## 特殊用法:修改已有配置(换网关 / 轮换 key)

### `--reconfigure`(重新输入 key 和网关)
```bash
bash ywcoder-setup.sh --reconfigure
```
**忽略**已有的 key/网关、**强制重新询问**并覆盖写入;**模型保持不变**。适合"换网关 + 轮换 key"。

非交互(批量推送)写法:
```bash
YW_API_KEY=新key YW_BASE_URL=http://新网关/v1 bash ywcoder-setup.sh --reconfigure
```

### 只改一个值 —— 直接编辑配置文件
`~/.ywcoder/settings.json` 是普通 JSON,改对应值、存盘、重启 ywcoder 即生效:
```json
{
  "env": {
    "YWCODER_USE_OPENAI": "1",
    "OPENAI_API_KEY": "新key",
    "OPENAI_BASE_URL": "http://新网关/v1",
    "OPENAI_MODEL": "Qwen3.5-27B",
    "YWCODER_INTRANET": "1"
  }
}
```
或用 jq 改一行(以改网关为例):
```bash
tmp=$(mktemp); jq '.env.OPENAI_BASE_URL="http://新网关/v1"' ~/.ywcoder/settings.json > "$tmp" && mv "$tmp" ~/.ywcoder/settings.json
```

---

## 常见问题

- **配置存哪?会被更新冲掉吗?**
  存 `~/.ywcoder/settings.json`(在 HOME 下)。`npm install -g` 只换程序、**不碰配置**;所以更新版本不会丢配置,改配置也不用重装。
- **更新版本怎么做?**
  把新 `.tgz` 放好、改脚本顶部 `PKG_FILE` 的版本号,再跑一次 `ywcoder-setup.sh` 即可(配置自动复用,无需重输)。或直接 `npm install -g ./新包.tgz`。
- **模型怎么改?**
  模型默认 `Qwen3.5-27B`(不交互询问)。改 `~/.ywcoder/settings.json` 的 `OPENAI_MODEL`,或运维改脚本顶部 `YW_MODEL`。
- **用环境变量传参(不改脚本)**
  `YW_PKG_FILE` / `YW_API_KEY` / `YW_BASE_URL` / `YW_MODEL` 都可在命令前临时指定,例:
  ```bash
  YW_PKG_FILE=./dcywzc-ywcoder-1.2.1.tgz YW_API_KEY=sk-x YW_BASE_URL=http://gw/v1 bash ywcoder-setup.sh
  ```
- **Windows 用户?** 这些是 bash 脚本,原生 Windows 跑不了;WSL 里可跑。需要原生 Windows 支持可另写 PowerShell 版。
