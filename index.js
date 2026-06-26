const http = require('http');
const https = require('https');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');

// ============ 配置 ============

const PORT = process.env.MIMO_PROXY_PORT || 8080;
const TARGET_HOST = 'token-plan-cn.xiaomimimo.com';

// 从 keys.json 读取
const KEYS_FILE = path.join(__dirname, 'keys.json');
let KEYS = [];

try {
  KEYS = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'));
  if (!Array.isArray(KEYS) || KEYS.length === 0) {
    throw new Error('keys.json must be a non-empty array');
  }
} catch (err) {
  console.error(`Failed to load keys.json: ${err.message}`);
  console.error('Please create keys.json with an array of API keys');
  process.exit(1);
}

// 失败后冷却时间（毫秒）
const COOLDOWN_MS = 60_000;
const REQUEST_TIMEOUT = 120_000; // 2 分钟

// ============ Key 管理 ============

const keyStates = KEYS.map((key, i) => ({
  key,
  index: i,
  failCount: 0,
  cooldownUntil: 0,
}));

let currentIndex = 0;

function getNextKey() {
  const now = Date.now();
  const total = keyStates.length;

  for (let i = 0; i < total; i++) {
    const idx = (currentIndex + i) % total;
    const state = keyStates[idx];

    if (state.cooldownUntil > now) {
      continue; // 还在冷却中
    }

    currentIndex = (idx + 1) % total; // 下次从下一个开始
    return state;
  }

  // 所有 key 都在冷却，选一个冷却时间最短的
  keyStates.sort((a, b) => a.cooldownUntil - b.cooldownUntil);
  return keyStates[0];
}

function markFailed(keyState) {
  keyState.failCount++;
  // 指数退避，最多 5 分钟
  const cooldown = Math.min(COOLDOWN_MS * Math.pow(2, keyState.failCount - 1), 300_000);
  keyState.cooldownUntil = Date.now() + cooldown;
  log(`Key ${keyState.index} 失败 (累计${keyState.failCount}次)，冷却 ${Math.round(cooldown / 1000)}s`);
}

function removeKey(keyState) {
  const idx = keyStates.indexOf(keyState);
  if (idx !== -1) {
    keyStates.splice(idx, 1);
    log(`Key ${keyState.index} (${keyState.key.slice(0, 12)}...) 已失效，已从池中移除，剩余 ${keyStates.length} 个 key`);
  }
  // 调整 currentIndex 防止越界
  if (currentIndex >= keyStates.length) {
    currentIndex = 0;
  }
}

function markSuccess(keyState) {
  keyState.failCount = 0;
  keyState.cooldownUntil = 0;
}

// ============ 日志 ============

function log(msg) {
  const time = new Date().toLocaleTimeString('zh-CN');
  console.log(`[${time}] ${msg}`);
}

// ============ Proxy 逻辑 ============

function isRetriableStatus(code) {
  return code === 429 || code === 500 || code === 502 || code === 503;
}

function isInvalidKey(code) {
  return code === 401;
}

function makeRequest(targetUrl, method, headers, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(targetUrl);
    const options = {
      hostname: url.hostname,
      port: 443,
      path: url.pathname + url.search,
      method,
      headers,
    };

    const req = https.request(options, (res) => {
      resolve(res);
    });

    req.on('error', reject);
    req.setTimeout(REQUEST_TIMEOUT, () => {
      req.destroy(new Error('timeout'));
    });

    if (body && body.length > 0) {
      req.write(body);
    }
    req.end();
  });
}

async function handleRequest(clientReq, clientRes) {
  // 收集请求 body
  const chunks = [];
  for await (const chunk of clientReq) {
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);

  const targetPath = clientReq.url;
  const maxAttempts = Math.min(keyStates.length, 3);
  let attempt = 0;

  while (attempt < maxAttempts) {
    const keyState = getNextKey();
    const keyPreview = keyState.key.slice(0, 12) + '...';
    attempt++;

    // 构造发往小米的 headers
    const targetHeaders = {
      'content-type': clientReq.headers['content-type'] || 'application/json',
      'x-api-key': keyState.key,
      'authorization': `Bearer ${keyState.key}`,
      'anthropic-version': clientReq.headers['anthropic-version'] || '2023-06-01',
    };

    // 保留一些有用的 headers
    if (clientReq.headers['anthropic-beta']) {
      targetHeaders['anthropic-beta'] = clientReq.headers['anthropic-beta'];
    }

    const targetUrl = `https://${TARGET_HOST}${targetPath}`;
    log(`[${attempt}/${maxAttempts}] ${clientReq.method} ${targetPath} → key${keyState.index} (${keyPreview})`);

    try {
      const proxyRes = await makeRequest(targetUrl, clientReq.method, targetHeaders, body);

      // 如果是无效 key (401)，直接删除
      if (isInvalidKey(proxyRes.statusCode)) {
        proxyRes.resume();
        removeKey(keyState);
        if (keyStates.length === 0) {
          log('  ↳ 没有可用 key 了！');
          clientRes.writeHead(502, { 'content-type': 'application/json' });
          clientRes.end(JSON.stringify({
            error: { message: 'All keys are invalid', type: 'proxy_error' }
          }));
          return;
        }
        // 用下一个 key 重试，不消耗 attempt
        attempt--;
        continue;
      }

      // 如果是可重试的临时错误，换 key
      if (isRetriableStatus(proxyRes.statusCode)) {
        // 消费掉响应体
        proxyRes.resume();
        markFailed(keyState);
        log(`  ↳ ${proxyRes.statusCode}，切换 key...`);
        continue;
      }

      // 成功或不可重试的错误，透传给客户端
      markSuccess(keyState);
      log(`  ↳ ${proxyRes.statusCode} OK`);

      // 构造响应 headers
      const resHeaders = { ...proxyRes.headers };
      // 移除一些不应该透传的 headers
      delete resHeaders['transfer-encoding'];

      clientRes.writeHead(proxyRes.statusCode, resHeaders);

      // 流式透传
      proxyRes.pipe(clientRes);
      return;

    } catch (err) {
      markFailed(keyState);
      log(`  ↳ 请求异常: ${err.message}`);
    }
  }

  // 所有尝试都失败了
  clientRes.writeHead(502, { 'content-type': 'application/json' });
  clientRes.end(JSON.stringify({
    error: {
      message: 'All keys failed after multiple attempts',
      type: 'proxy_error',
    }
  }));
}

// ============ 启动服务器 ============

const server = http.createServer((req, res) => {
  // 健康检查
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      keys: keyStates.map(k => ({
        index: k.index,
        preview: k.key.slice(0, 12) + '...',
        fails: k.failCount,
        cooldown: k.cooldownUntil > Date.now() ? Math.round((k.cooldownUntil - Date.now()) / 1000) + 's' : 'none',
      }))
    }));
    return;
  }

  handleRequest(req, res).catch(err => {
    log(`未捕获异常: ${err.message}`);
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: err.message } }));
    }
  });
});

server.listen(PORT, () => {
  log(`MIMO Proxy 已启动 → http://localhost:${PORT}`);
  log(`管理 ${KEYS.length} 个 key`);
  log(`目标: ${TARGET_HOST}`);
  log('');
  log('Claude Code 配置:');
  log(`  export ANTHROPIC_BASE_URL="http://localhost:${PORT}/anthropic"`);
  log(`  # 移除或保留 ANTHROPIC_AUTH_TOKEN 都行，proxy 会自己加`);
});

// 优雅退出
function shutdown(signal) {
  log(`收到 ${signal}，正在关闭...`);
  server.close(() => {
    log('服务器已关闭');
    process.exit(0);
  });
  // 5 秒后强制退出
  setTimeout(() => process.exit(1), 5000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
