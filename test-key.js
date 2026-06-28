#!/usr/bin/env node
const https = require('https');

const ENDPOINTS = {
  cn:  'token-plan-cn.xiaomimimo.com',
  sgp: 'token-plan-sgp.xiaomimimo.com',
};
const MODEL = 'mimo-v2.5-pro';

let input = process.argv[2];
let endpoint = process.argv[3] || 'cn';

if (!input) {
  console.error('用法: node test-key.js <key 或 base64> [cn|sgp]');
  process.exit(1);
}

if (!ENDPOINTS[endpoint]) {
  console.error('endpoint 必须是 cn 或 sgp');
  process.exit(1);
}

// 如果不以 tp- 开头，尝试 base64 解码
if (!input.startsWith('tp-')) {
  try {
    input = Buffer.from(input, 'base64').toString('utf8');
    console.log('Base64 解码:', input);
  } catch {
    console.error('Base64 解码失败');
    process.exit(1);
  }
}

// 校验格式
if (!/^tp-[a-z0-9]{48}$/.test(input)) {
  console.error('格式校验失败: 需要 tp- + 48位小写字母数字，实际:', input, '长度:', input.length);
  process.exit(1);
}

function test(host) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: MODEL,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'hi' }]
    });

    const req = https.request({
      hostname: host,
      port: 443,
      path: '/anthropic/v1/messages',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': input,
        'authorization': 'Bearer ' + input,
        'anthropic-version': '2023-06-01',
      },
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });

    req.on('error', e => resolve({ status: 'ERROR', body: e.message }));
    req.setTimeout(15000, () => { req.destroy(); resolve({ status: 'TIMEOUT', body: '' }); });
    req.write(body);
    req.end();
  });
}

function report(ep, result) {
  const host = ENDPOINTS[ep];
  console.log(`\n[${ep}] ${host}`);
  console.log('HTTP', result.status);
  if (result.status === 200 || result.status === 429) {
    console.log('✅ Key 有效' + (result.status === 429 ? '（限流中）' : ''));
    return true;
  } else if (result.status === 401) {
    console.log('❌ Key 无效');
    return false;
  } else {
    console.log('⚠️  其他状态:', result.body.slice(0, 200));
    return false;
  }
}

(async () => {
  console.log('测试 key:', input.slice(0, 16) + '...');
  console.log('模型:', MODEL);

  const result = await test(ENDPOINTS[endpoint]);
  const ok = report(endpoint, result);

  // 如果指定节点失败（401），自动尝试另一个节点
  if (!ok && result.status === 401) {
    const other = endpoint === 'cn' ? 'sgp' : 'cn';
    console.log(`\n自动尝试 ${other} 节点...`);
    const otherResult = await test(ENDPOINTS[other]);
    const otherOk = report(other, otherResult);
    if (otherOk) {
      console.log(`\n💡 此 key 属于 ${other} 节点`);
    }
  }
})();
