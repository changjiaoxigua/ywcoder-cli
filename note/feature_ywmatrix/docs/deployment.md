# 部署指南

## 1. 部署前准备

### 1.1 确认目标平台

| 平台 | 常见 CPU 架构 | Go 构建参数 |
|------|--------------|------------|
| Windows 10/11 | amd64 | `GOOS=windows GOARCH=amd64` |
| Windows 7 | amd64 | **需 Go 1.20 或更早** |
| Linux x64 | amd64 | `GOOS=linux GOARCH=amd64` |
| 麒麟桌面（飞腾/鲲鹏） | arm64 | `GOOS=linux GOARCH=arm64` |
| 麒麟桌面（x86） | amd64 | `GOOS=linux GOARCH=amd64` |
| 麒麟桌面（龙芯） | loong64 | `GOOS=linux GOARCH=loong64` |
| macOS Intel | amd64 | `GOOS=darwin GOARCH=amd64` |
| macOS Apple Silicon | arm64 | `GOOS=darwin GOARCH=arm64` |

### 1.2 网络要求

- 终端必须能访问网关的内网地址和端口
- 网关不需要访问终端，只需要监听端口
- 所有通信建议走 HTTPS/WSS（生产环境）

## 2. 构建二进制

### 2.1 使用构建脚本（推荐）

```bash
./scripts/build.sh
```

输出到 `dist/` 目录。

如果 `go` 不在 PATH 中：

```bash
GO=/usr/local/go/bin/go ./scripts/build.sh
```

### 2.2 手动构建

```bash
# Windows x64
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -o dist/client-windows.exe ./cmd/client
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -o dist/gateway-windows.exe ./cmd/gateway

# Linux x64
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -o dist/client-linux ./cmd/client
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -o dist/gateway-linux ./cmd/gateway

# Linux arm64（麒麟飞腾/鲲鹏）
GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -o dist/client-kylin-arm64 ./cmd/client
GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -o dist/gateway-kylin-arm64 ./cmd/gateway
```

### 2.3 Windows 7 特殊说明

Go 1.21 起不再支持 Windows 7。如需兼容 Win7：

```bash
# 使用 Go 1.20 构建
/path/to/go1.20/bin/go build -o dist/client-win7.exe ./cmd/client
```

## 3. 网关部署

### 3.1 Linux 服务器部署

```bash
# 上传二进制到服务器
scp dist/gateway-linux-amd64 user@gateway-server:/opt/agent-manage/

# 启动
/opt/agent-manage/gateway-linux-amd64 -addr 0.0.0.0:8080
```

### 3.2 使用 systemd 管理（推荐）

创建 `/etc/systemd/system/agent-gateway.service`：

```ini
[Unit]
Description=Agent Manage Gateway
After=network.target

[Service]
Type=simple
ExecStart=/opt/agent-manage/gateway-linux-amd64 -addr 0.0.0.0:8080
Restart=always
RestartSec=5
User=agent
Group=agent
WorkingDirectory=/opt/agent-manage

[Install]
WantedBy=multi-user.target
```

启动：

```bash
sudo systemctl daemon-reload
sudo systemctl enable agent-gateway
sudo systemctl start agent-gateway
```

### 3.3 使用 Nginx 反向代理（可选）

如果需要 HTTPS 或域名：

```nginx
server {
    listen 80;
    server_name gateway.internal;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

**注意**：WebSocket 必须配置 `Upgrade` 和 `Connection` 头。

## 4. 终端 Client 部署

### 4.1 Windows 部署

#### 方式一：命令行启动

```powershell
# HTTP 型本地 Agent
client-windows-amd64.exe `
  -adapter http `
  -gateway ws://gateway.internal:8080/ws/agent `
  -agent-id PC-ZHANGSAN `
  -local-agent http://localhost:9001 `
  -token user:zhangsan

# 命令行型本地 Agent（如 Claude Code 类 Agent）
client-windows-amd64.exe `
  -adapter stdio `
  -gateway ws://gateway.internal:8080/ws/agent `
  -agent-id PC-ZHANGSAN `
  -local-agent "C:\Program Files\MyAgent\agent.exe" `
  -token user:zhangsan
```

#### 方式二：注册为 Windows 服务（推荐）

使用 `nssm`（Non-Sucking Service Manager）：

```powershell
nssm install AgentClient
# 在弹出的窗口中：
# Path: C:\Program Files\AgentManage\client-windows-amd64.exe
# Startup directory: C:\Program Files\AgentManage
# Arguments: -adapter http -gateway ws://gateway.internal:8080/ws/agent -agent-id PC-ZHANGSAN -local-agent http://localhost:9001 -token user:zhangsan

nssm start AgentClient
```

### 4.2 Linux / 麒麟部署

```bash
# 上传二进制
scp dist/client-linux-amd64 user@terminal:/opt/agent-manage/client

# HTTP 型本地 Agent
/opt/agent-manage/client \
  -adapter http \
  -gateway ws://gateway.internal:8080/ws/agent \
  -agent-id kylin-zhangsan \
  -local-agent http://localhost:9001 \
  -token user:zhangsan

# Stdio 型本地 Agent
/opt/agent-manage/client \
  -adapter stdio \
  -gateway ws://gateway.internal:8080/ws/agent \
  -agent-id kylin-zhangsan \
  -local-agent "/opt/my-agent/bin/agent" \
  -token user:zhangsan
```

#### 使用 systemd

创建 `/etc/systemd/system/agent-client.service`：

```ini
[Unit]
Description=Agent Client
After=network.target

[Service]
Type=simple
ExecStart=/opt/agent-manage/client \
  -adapter http \
  -gateway ws://gateway.internal:8080/ws/agent \
  -agent-id kylin-zhangsan \
  -local-agent http://localhost:9001 \
  -token user:zhangsan
Restart=always
RestartSec=5
User=zhangsan
Group=zhangsan

[Install]
WantedBy=multi-user.target
```

启动：

```bash
sudo systemctl daemon-reload
sudo systemctl enable agent-client
sudo systemctl start agent-client
```

### 4.3 macOS 部署

```bash
# HTTP 型本地 Agent
./client-darwin-arm64 \
  -adapter http \
  -gateway ws://gateway.internal:8080/ws/agent \
  -agent-id mac-zhangsan \
  -local-agent http://localhost:9001 \
  -token user:zhangsan

# Stdio 型本地 Agent
./client-darwin-arm64 \
  -adapter stdio \
  -gateway ws://gateway.internal:8080/ws/agent \
  -agent-id mac-zhangsan \
  -local-agent "/opt/my-agent/bin/agent" \
  -token user:zhangsan
```

使用 `launchd` 后台运行：

创建 `~/Library/LaunchAgents/com.agent.client.plist`：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.agent.client</string>
    <key>ProgramArguments</key>
    <array>
        <string>/opt/agent-manage/client</string>
        <string>-adapter</string>
        <string>http</string>
        <string>-gateway</string>
        <string>ws://gateway.internal:8080/ws/agent</string>
        <string>-agent-id</string>
        <string>mac-zhangsan</string>
        <string>-local-agent</string>
        <string>http://localhost:9001</string>
        <string>-token</string>
        <string>user:zhangsan</string>
    </array>
    <key>KeepAlive</key>
    <true/>
    <key>RunAtLoad</key>
    <true/>
</dict>
</plist>
```

加载：

```bash
launchctl load ~/Library/LaunchAgents/com.agent.client.plist
```

## 5. 本地 Agent 部署

本地 Agent 需要与 AgentClient 同机运行，暴露 HTTP 服务。

### 5.1 使用 Demo 本地 Agent

```bash
# Windows
local-agent-windows-amd64.exe -addr :9001

# Linux/麒麟
./local-agent-linux-amd64 -addr :9001
```

### 5.2 接入真实 Agent

只要真实 Agent 提供以下接口，AgentClient 就可以调用：

```http
GET /capabilities
Response:
{
  "capabilities": [
    {"type": "chat", "name": "coding", "description": "编码助手"}
  ]
}

POST /tasks
Request Body: {"task_id": "...", "session_id": "...", "type": "chat", "content": "..."}
Response: text/event-stream
```

SSE 响应格式（每个 `data:` 行是一条 JSON-RPC 通知，type 由 Agent 自行定义）：

```
data: {"jsonrpc":"2.0","method":"stream.chunk","params":{"task_id":"...","type":"text","content":[{"type":"text","text":"收到指令"}],"done":false}}
data: {"jsonrpc":"2.0","method":"stream.chunk","params":{"task_id":"...","type":"confirm_required","confirm_id":"c-1","content":[{"type":"text","text":"确认执行？"}]}}
data: {"jsonrpc":"2.0","method":"stream.chunk","params":{"task_id":"...","type":"text","content":[{"type":"text","text":"完成"}],"done":true}}
```

## 6. 配置参数说明

### gateway

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `-addr` | 监听地址 | `:8080` |

### client

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `-gateway` | 网关 WebSocket URL | `ws://localhost:8080/ws/agent` |
| `-agent-id` | Agent 唯一标识 | 主机名 |
| `-adapter` | 本地 Agent 适配器类型：`http` 或 `stdio` | `http` |
| `-local-agent` | 本地 Agent HTTP 地址或命令路径 | `http://localhost:9001` |
| `-token` | 用户 Token，格式 `user:<user_id>` | `user:default` |

### local-agent

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `-addr` | 监听地址 | `:9001` |

## 7. 常见问题

### 7.1 终端 Client 连不上网关

检查：
- 终端能否 `ping gateway.internal`
- 终端能否 `curl http://gateway.internal:8080`
- 防火墙是否放行终端到网关的出站连接
- 网关是否监听 `0.0.0.0` 而不是 `127.0.0.1`

### 7.2 用户页面不显示 Agent

检查：
- Client 是否启动成功
- Client 日志是否显示 `registered as xxx`
- 浏览器控制台是否有 WebSocket 报错
- 网关和 Client 之间网络是否连通

### 7.3 发消息后无响应

检查：
- 本地 Agent 是否启动（`curl http://localhost:9001/capabilities`）
- Client 日志是否有错误
- 本地 Agent 是否正确返回 SSE 格式

### 7.4 Windows 7 无法运行

如果报错缺少系统 API 或无法启动，可能是用高版本 Go 构建的。请使用 Go 1.20 重新构建。

## 8. 生产部署 checklist

- [ ] 网关部署在稳定的内网服务器，配置 systemd 自启
- [ ] 启用 HTTPS/WSS
- [ ] 配置用户认证和 Agent 接入 Token
- [ ] 终端 Client 配置为系统服务开机自启
- [ ] 本地 Agent 有异常退出自动重启机制
- [ ] 配置审计日志落盘或入库
- [ ] 敏感操作需要终端用户二次确认
- [ ] 限制 Agent 可执行命令和访问路径
