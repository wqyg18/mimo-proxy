# MIMO Proxy

本地代理服务器，自动管理多个 MIMO API key，失败时自动切换。

## 使用

### 1. 配置 keys

编辑 `keys.json`，填入你的 API keys：

```json
[
  "tp-key1...",
  "tp-key2...",
  "tp-key3..."
]
```

### 2. 启动 proxy

```bash
cd ~/dev/mimo-proxy
node index.js
```

### 3. 配置 Claude Code

在 `~/.zshrc` 中添加以下环境变量：

```bash
# 指向本地 proxy
export ANTHROPIC_BASE_URL="http://localhost:8080/anthropic"

# API key（proxy 会自动注入，这里随便填一个非空值即可）
export ANTHROPIC_AUTH_TOKEN="sk-placeholder"

# 指定模型（必须，否则 Claude Code 会用默认的 Claude 模型名）
export ANTHROPIC_MODEL="mimo-v2.5-pro[1m]"
export ANTHROPIC_DEFAULT_SONNET_MODEL="mimo-v2.5-pro[1m]"
export ANTHROPIC_DEFAULT_OPUS_MODEL="mimo-v2.5-pro[1m]"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="mimo-v2.5-pro[1m]"
```

然后 `source ~/.zshrc` 并重启 Claude Code。

> **为什么需要设置这么多模型变量？** Claude Code 内部会根据任务类型自动选择 Sonnet/Opus/Haiku，如果不把这些都指向 MIMO 的模型，某些任务会 fallback 到真实的 Claude API 导致失败。

## 功能

- **自动切换 key** - 遇到 401/429/5xx 自动换下一个 key
- **冷却期** - 失败的 key 会暂时跳过，指数退避（最多 5 分钟）
- **健康检查** - `curl http://localhost:8080/health` 查看所有 key 状态
- **流式透传** - 完整支持 SSE 流式输出

## 配置

环境变量：

- `MIMO_PROXY_PORT` - 监听端口（默认 8080）

## 测试

```bash
# 查看 key 状态
curl http://localhost:8080/health

# 测试 API 调用
curl http://localhost:8080/anthropic/v1/messages \
  -H "content-type: application/json" \
  -d '{
    "model": "mimo-v2.5-pro[1m]",
    "max_tokens": 100,
    "messages": [{"role": "user", "content": "hi"}]
  }'
```
