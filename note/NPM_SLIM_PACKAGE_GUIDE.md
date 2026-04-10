# YwCoder NPM 精简版离线包

## 概述

精简版（Slim）离线包是为了解决完整离线包体积过大（70MB+）的问题而设计的替代方案。

## 版本对比

| 特性 | 完整离线包 | 精简版 |
|------|-----------|--------|
| 体积 | ~70-80MB | ~15-25MB |
| 安装方式 | `npm install -g xxx.tgz` | `npm install -g xxx.tgz` |
| 依赖处理 | 完全离线（所有 node_modules 已打包） | 半离线（仅原生模块打包） |
| 网络要求 | 无需网络 | 首次安装需要网络下载 JS 依赖 |
| ripgrep | 包含 4 平台二进制 | 仅 Windows |
| 适用场景 | 完全隔离的内网环境 | 有代理/镜像的内网环境 |

## 包含的原生依赖

精简版打包以下包含原生二进制代码的依赖：

1. **sharp** + **@img/sharp-*** - 图片处理库及其平台特定二进制
2. **@opentelemetry/*** - OpenTelemetry 追踪（特别是 gRPC 导出器，约 74MB）
3. **@grpc/*** - gRPC 客户端库
4. **protobufjs** - Protocol Buffers 支持

## 安装步骤

### 1. 下载精简版包

从 GitHub Actions 下载 `ywcoder-slim` artifact。

### 2. 准备环境

确保目标机器：
- 已安装 Node.js >= 18.0.0
- 有网络连接（用于下载 JS 依赖）
- 已配置 npm 镜像（推荐，加快下载速度）

```bash
# 配置淘宝镜像（可选）
npm config set registry https://registry.npmmirror.com
```

### 3. 安装

```bash
npm install -g dcywzc-ywcoder-1.0.0.tgz
```

安装过程会：
1. 从 .tgz 解压已打包的原生依赖
2. 从 npm registry 下载剩余的 JS 依赖

### 4. 配置 API

同完整版，设置环境变量：

```bash
export CLAUDE_CODE_USE_OPENAI=1
export OPENAI_API_KEY=your-api-key
export OPENAI_BASE_URL=https://api.kimi.com/coding/v1
export OPENAI_MODEL=kimi-for-coding
```

### 5. 启动使用

```bash
ywcoder
```

## 常见问题

### Q: 为什么还需要网络？

精简版只打包了需要原生编译的依赖（如 sharp、opentelemetry 等）。这些依赖在不同平台（Windows/Linux/macOS）需要不同的二进制文件，编译复杂。

纯 JavaScript 依赖则直接从 npm registry 下载，这样可以：
- 大幅减小包体积（70MB → 20MB）
- 自动获取最新兼容版本
- 减少平台特定问题

### Q: 内网环境如何安装？

**方案 1：使用 npm 私有镜像**

在内网搭建 npm 镜像（如 Verdaccio、Nexus），同步所需依赖。

**方案 2：使用完整离线包**

如果完全无法连接网络，请使用 `build-npm-offline.yml` 构建的完整离线包。

**方案 3：手动准备依赖**

1. 在外网机器执行：
```bash
npm pack @dcywzc/ywcoder
cd /path/to/global/node_modules
npm pack $(ls | tr '\n' ' ')
```

2. 将 tgz 文件传入内网，使用 `npm install <tarball>` 安装

### Q: 体积能再小吗？

当前精简版约 15-25MB，主要占用：
- OpenTelemetry gRPC: ~74MB（未压缩）
- sharp 平台二进制: ~15MB（Windows）
- 其他: ~5MB

如需更小体积，可以：
1. 禁用 OpenTelemetry 功能（需修改代码）
2. 移除 sharp（如果不需要图片处理功能）
3. 使用 ZIP 安装包（跳过 npm 打包开销）

## 技术细节

### bundledDependencies 工作原理

npm 的 `bundledDependencies` 配置会将指定的依赖打包进 .tgz 文件，安装时优先使用。

精简版的 `package.json` 示例：
```json
{
  "bundledDependencies": [
    "sharp",
    "@img/sharp-win32-x64",
    "@opentelemetry/exporter-trace-otlp-grpc",
    "@grpc/grpc-js",
    "protobufjs"
  ]
}
```

### 为什么原生依赖需要打包？

1. **编译依赖**: 包含 C/C++ 代码，需要 node-gyp 编译
2. **平台特定**: 不同操作系统需要不同的二进制文件
3. **内网限制**: 无法下载预编译二进制文件

### 纯 JS 依赖为什么不需要打包？

1. npm registry 可从镜像/代理获取
2. 无平台兼容性问题
3. 自动解析依赖树

## 建议

- **有 npm 镜像的内网**: 使用精简版（体积更小）
- **完全隔离环境**: 使用完整离线版
- **Windows 单机用户**: 使用 ZIP 安装包（最快）
