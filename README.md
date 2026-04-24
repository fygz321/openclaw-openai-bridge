# openclaw-openai-bridge
把标准 OpenAI `/v1/chat/completions` 请求桥接到 OpenClaw HTTP Bridge，并将回复转成 SSE 流返回给前端。


# LobeChat + OpenClaw（完整 Agent）复刻步骤

在新环境复现当前 MVP 的最小步骤。

---

## 前置条件

- OpenClaw Gateway 已运行（端口 18789）
- Node.js 可用

---

## 第零步：安装 LobeChat

```bash
# 克隆源码
git clone https://github.com/lobehub/lobe-chat.git /root/lobe-chat
cd /root/lobe-chat

# 安装依赖
pnpm install

# 修复 searchMode 默认值（防止走 /responses API，OpenClaw 不支持）
sed -i "s/searchMode || 'auto'/searchMode || 'off'/" src/store/agent/selectors/chatConfigByIdSelectors.ts

# 构建
pnpm run build:next

# 数据库迁移（首次必须执行）
set -a && source .env && set +a && npx tsx ./scripts/migrateServerDB/index.ts
```

`.env` 关键配置：

```bash
NEXT_PUBLIC_SERVICE_MODE=server
PORT=80
NEXTAUTH_URL=http://<服务器IP>
AUTH_TRUSTED_ORIGINS=http://<服务器IP>
DATABASE_DRIVER=node
DATABASE_URL=postgres://<user>:<pass>@/<dbname>?host=/var/run/postgresql
OPENAI_PROXY_URL=http://localhost:18789/v1
OPENAI_API_KEY=<openclaw-gateway-token>
CUSTOM_MODELS=-all,+openclaw=OpenClaw
SSRF_ALLOW_PRIVATE_IP_ADDRESS=1
FEATURE_FLAGS=-pwa,-settings,-market,-plugins,-files,-provider_settings,-openai_api_key,+openai_proxy_url,-s3
```

---

## 第一步：安装 HTTP Bridge 插件

```bash
# 通过 clawhub 安装
clawhub install openclaw-httpbridge
# 插件安装到 ~/.openclaw/extensions/openclaw-httpbridge
```

---

## 第二步：开启 OpenClaw 所需配置

### 1.1 开启 chat completions 接口

```bash
openclaw config set gateway.http.endpoints.chatCompletions.enabled true
```

### 1.2 启用 HTTP Bridge 插件

```bash
openclaw config set plugins.entries.openclaw-httpbridge.enabled true
openclaw gateway restart
```

验证插件已加载：

```bash
openclaw gateway status
# 确认 openclaw-httpbridge 插件出现在插件列表中
```

---

## 第二步：部署适配层

适配层是一个轻量 Node.js 服务，把标准 OpenAI `/v1/chat/completions` 请求桥接到 OpenClaw HTTP Bridge，并将回复转成 SSE 流返回给前端。

适配层路径：`bridge-adapter/index.js`

### 配置参数

打开文件，修改顶部三个常量：

```js
const BRIDGE_URL = "http://127.0.0.1:18789/httpbridge/inbound"; // OpenClaw HTTP Bridge 入口
const BRIDGE_TOKEN = "bridge-secret-2024";                       // HTTP Bridge token（需与 openclaw.json 一致）
const PORT = 18790;                                              // 适配层对外端口
```
***18790端口需开放才能从公网访问
> `BRIDGE_TOKEN` 需与 OpenClaw 配置中 `plugins.entries.openclaw-httpbridge` 的 token 保持一致。

### 启动

```bash
node bridge-adapter/index.js > /tmp/bridge-adapter.log 2>&1 &

# 验证监听
ss -tlnp | grep 18790
```

### 提供的接口

| 接口 | 说明 |
|------|------|
| `GET /v1/models` | 返回可用模型列表（`openclaw-agent`）|
| `POST /v1/chat/completions` | 接收聊天请求，转发给 OpenClaw，SSE 流式返回 |
| `POST /callback` | OpenClaw 回调端点（内部使用，无需手动调用）|

### 多机部署说明

如果 LobeChat 和 OpenClaw 部署在不同机器：
- 把 `BRIDGE_URL` 中的 `127.0.0.1` 改为 OpenClaw 所在机器的内网 IP
- LobeChat 的代理地址填写适配层所在机器的内网 IP + 端口
- 全程走内网，无需公网

### 日志与排查

```bash
# 查看运行日志
tail -f /tmp/bridge-adapter.log

# 手动测试接口
curl http://localhost:18790/v1/models
```

---

## 第三步：LobeChat 前端配置

在 LobeChat 设置 → 模型服务商 → OpenAI 兼容 中填写：

| 字段 | 值 |
|------|-----|
| API Key | OpenClaw Gateway token |
| 代理地址 | `http://localhost:18790/v1` |
| 模型 | `openclaw-agent` |
| 客户端请求模式 | **关闭**（关键！） |

> ⚠️ **必须关闭客户端请求模式**：开启后请求从浏览器发出，`localhost` 指向用户本机而非服务器，导致连接失败。

---

## 关键卡点汇总

| 卡点 | 现象 | 解决 |
|------|------|------|
| HTTP Bridge 插件未启用 | 适配层 postToBridge 报错 | `openclaw config set plugins.entries.openclaw-httpbridge.enabled true` |
| chat completions 未开启 | `/v1/models` 返回 HTML | `openclaw config set gateway.http.endpoints.chatCompletions.enabled true` |
| 客户端请求模式开启 | ECONNRESET / socket hang up | LobeChat 设置里关闭客户端请求模式 |
| 适配层进程崩溃 | 请求超时无响应 | 检查 `/tmp/bridge-adapter.log`，重启适配层 |
| 代理地址填公网 IP | 服务端 ECONNRESET | 改为 `localhost:18790`，不要填公网 IP |

---

## 数据流

```
用户浏览器
    │ HTTP (port 80)
    ▼
LobeChat（服务端）
    │ POST /v1/chat/completions (port 18790)
    ▼
bridge-adapter（适配层）
    │ POST /httpbridge/inbound (port 18789)
    ▼
OpenClaw HTTP Bridge 插件
    │
    ▼
openclaw Agent（处理消息、工具调用、记忆）
    │ POST /callback (port 18790)
    ▼
bridge-adapter → SSE 流式返回
    ▼
LobeChat 渲染
```
