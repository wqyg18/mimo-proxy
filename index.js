const http = require('http');
const https = require('https');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');

// ============ 配置 ============

const PORT = process.env.MIMO_PROXY_PORT || 8080;

// 节点映射
const ENDPOINTS = {
  cn:  'token-plan-cn.xiaomimimo.com',
  sgp: 'token-plan-sgp.xiaomimimo.com',
};

// 从 keys.json 读取，兼容旧格式（纯字符串数组）和新格式（对象数组）
const KEYS_FILE = path.join(__dirname, 'keys.json');
let KEYS = [];

try {
  const raw = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'));
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('keys.json must be a non-empty array');
  }
  KEYS = raw.map((entry) => {
    if (typeof entry === 'string') {
      return { key: entry, endpoint: 'cn' };
    }
    if (!entry.key || !ENDPOINTS[entry.endpoint]) {
      throw new Error(`Invalid entry: ${JSON.stringify(entry)}`);
    }
    return { key: entry.key, endpoint: entry.endpoint };
  });
} catch (err) {
  console.error(`Failed to load keys.json: ${err.message}`);
  console.error('Please create keys.json with an array of API keys');
  process.exit(1);
}

// 失败后冷却时间（毫秒）
const COOLDOWN_MS = 60_000;
const REQUEST_TIMEOUT = 120_000; // 2 分钟
const BASE_RETRY_PER_KEY = 3; // 基础重试次数
const MAX_RETRY_PER_KEY = 6; // 高权重 key 最多重试次数
const SUCCESS_WINDOW_MS = 10 * 60 * 1000; // 10 分钟内的成功视为"近期"
const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 超过 5 分钟没成功视为"不活跃"
const MIN_WEIGHT = 0.05; // 最低权重，保证每个 key 都有机会

// ============ 持久化统计 ============

const STATS_FILE = path.join(__dirname, 'key-stats.json');

function loadKeyStats() {
  try {
    const data = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
    return data.keys || {};
  } catch {
    return {};
  }
}

function saveKeyStats() {
  const keys = {};
  for (const s of keyStates) {
    const id = s.key.slice(0, 12);
    keys[id] = {
      totalSuccess: s.totalSuccess,
      totalRequests: s.totalRequests,
      lastSuccessAt: s.lastSuccessAt,
      endpoint: s.endpoint,
    };
  }
  try {
    fs.writeFileSync(STATS_FILE, JSON.stringify({ lastSaved: new Date().toISOString(), keys }, null, 2));
    log(`Key 统计已保存到 key-stats.json`);
  } catch (err) {
    log(`保存统计失败: ${err.message}`);
  }
}

// ============ Key 管理 ============

// 按上次运行的质量排序：成功率高的排前面
const savedStats = loadKeyStats();
const sortedKeys = [...KEYS].sort((a, b) => {
  const idA = a.key.slice(0, 12);
  const idB = b.key.slice(0, 12);
  const statA = savedStats[idA];
  const statB = savedStats[idB];
  // 有历史记录的优先，按成功率降序
  if (statA && statB) {
    const rateA = statA.totalRequests > 0 ? statA.totalSuccess / statA.totalRequests : 0;
    const rateB = statB.totalRequests > 0 ? statB.totalSuccess / statB.totalRequests : 0;
    return rateB - rateA;
  }
  if (statA) return -1; // A 有记录，排前面
  if (statB) return 1;
  return 0; // 都没记录，保持原序
});

if (Object.keys(savedStats).length > 0) {
  log(`已加载 key 历史统计，按质量排序：`);
  sortedKeys.forEach((e, i) => {
    const id = e.key.slice(0, 12);
    const stat = savedStats[id];
    if (stat) {
      const rate = stat.totalRequests > 0 ? Math.round(stat.totalSuccess / stat.totalRequests * 100) : 0;
      log(`  ${i + 1}. ${id}... (${e.endpoint}) 成功率 ${rate}% (${stat.totalSuccess}/${stat.totalRequests})`);
    } else {
      log(`  ${i + 1}. ${id}... (${e.endpoint}) 新 key`);
    }
  });
}

const keyStates = sortedKeys.map((entry, i) => ({
  key: entry.key,
  host: ENDPOINTS[entry.endpoint],
  endpoint: entry.endpoint,
  index: i,
  failCount: 0,
  cooldownUntil: 0,
  // 成功统计（从历史恢复）
  totalSuccess: (savedStats[entry.key.slice(0, 12)] || {}).totalSuccess || 0,
  totalRequests: (savedStats[entry.key.slice(0, 12)] || {}).totalRequests || 0,
  recentSuccesses: 0,    // 近期窗口内的成功次数（每次启动重新计算）
  recentRequests: 0,     // 近期窗口内的总请求次数
  lastSuccessAt: (savedStats[entry.key.slice(0, 12)] || {}).lastSuccessAt || 0,
  lastRequestAt: 0,
}));

// 近期统计的滑动窗口清理
setInterval(() => {
  const now = Date.now();
  for (const s of keyStates) {
    // 如果最近一次成功超过窗口期，衰减近期计数
    if (s.lastSuccessAt > 0 && now - s.lastSuccessAt > SUCCESS_WINDOW_MS) {
      s.recentSuccesses = Math.max(0, s.recentSuccesses - 1);
      s.recentRequests = Math.max(0, s.recentRequests - 1);
    }
  }
}, 60_000); // 每分钟清理一次

function getKeyWeight(keyState) {
  const now = Date.now();

  // 冷却中的 key 权重为 0
  if (keyState.cooldownUntil > now) return 0;

  // 全新 key（从未请求过）给一个基础权重
  if (keyState.totalRequests === 0) return 0.5;

  // 计算近期成功率（近期有数据时优先用近期）
  let successRate;
  if (keyState.recentRequests >= 3) {
    successRate = keyState.recentSuccesses / keyState.recentRequests;
  } else {
    // 近期数据不足，用全局成功率
    successRate = keyState.totalSuccess / keyState.totalRequests;
  }

  // 近期活跃度加权：最近有成功的 key 更值得信赖
  let recencyBoost = 1.0;
  if (keyState.lastSuccessAt > 0) {
    const timeSinceSuccess = now - keyState.lastSuccessAt;
    if (timeSinceSuccess < STALE_THRESHOLD_MS) {
      // 最近 5 分钟内有成功，给予加成
      recencyBoost = 1.5;
    } else if (timeSinceSuccess > SUCCESS_WINDOW_MS) {
      // 超过 10 分钟没成功，降权
      recencyBoost = 0.5;
    }
  }

  const weight = Math.max(MIN_WEIGHT, successRate * recencyBoost);
  return weight;
}

function getRetryCount(keyState) {
  // 近期有成功的 key 给更多重试机会
  if (keyState.lastSuccessAt > 0) {
    const timeSinceSuccess = Date.now() - keyState.lastSuccessAt;
    if (timeSinceSuccess < STALE_THRESHOLD_MS) {
      return MAX_RETRY_PER_KEY; // 近期有成功，多给机会
    }
  }
  // 近期成功率高的 key 也多给机会
  if (keyState.recentRequests >= 3) {
    const rate = keyState.recentSuccesses / keyState.recentRequests;
    if (rate > 0.5) return Math.round(BASE_RETRY_PER_KEY + (MAX_RETRY_PER_KEY - BASE_RETRY_PER_KEY) * rate);
  }
  return BASE_RETRY_PER_KEY;
}

function getNextKey() {
  const now = Date.now();

  // 计算所有 key 的权重
  const weights = keyStates.map(s => getKeyWeight(s));
  const totalWeight = weights.reduce((a, b) => a + b, 0);

  if (totalWeight <= 0) {
    // 所有 key 都在冷却，选一个冷却时间最短的
    keyStates.sort((a, b) => a.cooldownUntil - b.cooldownUntil);
    return keyStates[0];
  }

  // 加权随机选择
  let r = Math.random() * totalWeight;
  for (let i = 0; i < keyStates.length; i++) {
    r -= weights[i];
    if (r <= 0) return keyStates[i];
  }
  return keyStates[keyStates.length - 1]; // 兜底
}

function markFailed(keyState) {
  keyState.failCount++;
  // 近期有成功的 key，冷却时间更短
  let cooldownMultiplier = keyState.failCount - 1;
  if (keyState.lastSuccessAt > 0) {
    const timeSinceSuccess = Date.now() - keyState.lastSuccessAt;
    if (timeSinceSuccess < STALE_THRESHOLD_MS) {
      cooldownMultiplier = Math.max(0, cooldownMultiplier - 1); // 减少一级退避
    }
  }
  const cooldown = Math.min(COOLDOWN_MS * Math.pow(2, cooldownMultiplier), 300_000);
  keyState.cooldownUntil = Date.now() + cooldown;
  keyState.totalRequests++;
  keyState.recentRequests++;
  keyState.lastRequestAt = Date.now();

  const weight = getKeyWeight(keyState);
  log(`Key ${keyState.index} (${keyState.endpoint}) 失败 (累计${keyState.failCount}次，权重${weight.toFixed(2)})，冷却 ${Math.round(cooldown / 1000)}s`);
}

function removeKey(keyState) {
  const idx = keyStates.indexOf(keyState);
  if (idx !== -1) {
    keyStates.splice(idx, 1);
    log(`Key ${keyState.index} (${keyState.endpoint}) ${keyState.key.slice(0, 12)}... 已失效，已从池中移除，剩余 ${keyStates.length} 个 key`);
  }
}

function markSuccess(keyState) {
  const now = Date.now();
  keyState.failCount = 0;
  keyState.cooldownUntil = 0;
  keyState.totalSuccess++;
  keyState.totalRequests++;
  keyState.recentSuccesses++;
  keyState.recentRequests++;
  keyState.lastSuccessAt = now;
  keyState.lastRequestAt = now;
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

function makeRequest(host, path, method, headers, body) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: host,
      port: 443,
      path,
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
  const maxKeySwitches = Math.min(keyStates.length, 5);

  for (let keyAttempt = 0; keyAttempt < maxKeySwitches; keyAttempt++) {
    const keyState = getNextKey();
    const keyPreview = keyState.key.slice(0, 12) + '...';

    // 根据 key 质量动态决定重试次数
    const retryCount = getRetryCount(keyState);
    for (let retry = 0; retry < retryCount; retry++) {
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

      log(`key${keyState.index} (${keyState.endpoint}) ${keyPreview} 重试 ${retry + 1}/${retryCount} | ${clientReq.method} ${targetPath}`);

      try {
        const proxyRes = await makeRequest(keyState.host, targetPath, clientReq.method, targetHeaders, body);

        // 如果是无效 key (401)，直接删除，换下一个 key
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
          break; // 跳出重试循环，换下一个 key
        }

        // 如果是可重试的临时错误，用同一个 key 重试
        if (isRetriableStatus(proxyRes.statusCode)) {
          proxyRes.resume();
          log(`  ↳ ${proxyRes.statusCode}，${retry < retryCount - 1 ? '重试中...' : '换 key...'}`);
          if (retry < retryCount - 1) {
            await sleep(1000 * (retry + 1)); // 等一下再重试
            continue;
          }
          markFailed(keyState);
          break; // 重试次数用完，换 key
        }

        // 成功或不可重试的错误，透传给客户端
        markSuccess(keyState);
        log(`  ↳ ${proxyRes.statusCode} OK`);

        // 构造响应 headers
        const resHeaders = { ...proxyRes.headers };
        delete resHeaders['transfer-encoding'];

        clientRes.writeHead(proxyRes.statusCode, resHeaders);

        // 流式透传
        proxyRes.pipe(clientRes);
        return;

      } catch (err) {
        log(`  ↳ 请求异常: ${err.message}`);
        if (retry < retryCount - 1) {
          await sleep(1000 * (retry + 1));
          continue;
        }
        markFailed(keyState);
      }
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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============ 启动服务器 ============

const server = http.createServer((req, res) => {
  // 健康检查
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      keys: keyStates.map(k => {
        const weight = getKeyWeight(k);
        const retryCount = getRetryCount(k);
        return {
          index: k.index,
          endpoint: k.endpoint,
          preview: k.key.slice(0, 12) + '...',
          weight: Math.round(weight * 100) / 100,
          retries: retryCount,
          fails: k.failCount,
          successRate: k.totalRequests > 0 ? Math.round(k.totalSuccess / k.totalRequests * 100) + '%' : 'N/A',
          recentRate: k.recentRequests > 0 ? Math.round(k.recentSuccesses / k.recentRequests * 100) + '%' : 'N/A',
          cooldown: k.cooldownUntil > Date.now() ? Math.round((k.cooldownUntil - Date.now()) / 1000) + 's' : 'none',
        };
      })
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
  const cnCount = keyStates.filter(k => k.endpoint === 'cn').length;
  const sgpCount = keyStates.filter(k => k.endpoint === 'sgp').length;
  log(`MIMO Proxy 已启动 → http://localhost:${PORT}`);
  log(`管理 ${KEYS.length} 个 key (CN: ${cnCount}, SGP: ${sgpCount})`);
  log(`节点: CN=${ENDPOINTS.cn}, SGP=${ENDPOINTS.sgp}`);
  log('');
  log('Claude Code 配置:');
  log(`  export ANTHROPIC_BASE_URL="http://localhost:${PORT}/anthropic"`);
  log(`  # 移除或保留 ANTHROPIC_AUTH_TOKEN 都行，proxy 会自己加`);
});

// 优雅退出
function shutdown(signal) {
  log(`收到 ${signal}，正在关闭...`);
  saveKeyStats(); // 保存 key 质量统计，下次启动时用
  server.close(() => {
    log('服务器已关闭');
    process.exit(0);
  });
  // 5 秒后强制退出
  setTimeout(() => {
    saveKeyStats(); // 再存一次，防止 server.close 卡住
    process.exit(1);
  }, 5000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
