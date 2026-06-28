#!/usr/bin/env node
const https = require('https');

const TARGET = 'token-plan-cn.xiaomimimo.com';
const MODEL = 'mimo-v2.5-pro';

let input = process.argv[2];
if (!input) {
  console.error('用法: node test-key.js <key 或 base64>');
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

console.log('测试 key:', input.slice(0, 16) + '...');
console.log('模型:', MODEL);
console.log('');

const body = JSON.stringify({
  model: MODEL,
  max_tokens: 1,
  messages: [{ role: 'user', content: 'hi' }]
});

const req = https.request({
  hostname: TARGET,
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
  res.on('end', () => {
    console.log('HTTP', res.statusCode);
    if (res.statusCode === 200 || res.statusCode === 429) {
      console.log('✅ Key 有效' + (res.statusCode === 429 ? '（限流中）' : ''));
    } else if (res.statusCode === 401) {
      console.log('❌ Key 无效');
    } else {
      console.log('⚠️  其他状态:', d.slice(0, 200));
    }
  });
});

req.on('error', e => console.log('❌ 请求失败:', e.message));
req.setTimeout(15000, () => { req.destroy(); console.log('❌ 超时'); });
req.write(body);
req.end();
