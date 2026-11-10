'use strict';
// 模拟 GitHub Models 和 Gemini API 的 HTTP 接口
const http = require('http');

function startMockApi() {
  let mode = 'ok';
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const j = body ? JSON.parse(body) : {};
      const send = (status, obj) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (req.url === '/catalog/models') {
        const models = [
          { id: 'meta/llama-x', name: 'Llama', publisher: 'Meta', rate_limit_tier: 'low' },
          { id: 'openai/gpt-4.1', name: 'OpenAI GPT-4.1', publisher: 'OpenAI', rate_limit_tier: 'high' },
        ];
        if (mode === 'catalog-envelope') return send(200, { data: models });
        if (mode === 'catalog-text') {
          res.writeHead(200, { 'content-type': 'text/plain' });
          return res.end('OK');
        }
        return send(200, models);
      }
      if (req.url === '/inference/chat/completions') {
        if (req.headers.authorization !== 'Bearer good-token') return send(401, { error: { message: 'Bad credentials' } });
        if (mode === '429') {
          res.setHeader('retry-after', '120');
          return send(429, { error: { message: 'Rate limit of 50 per 86400s exceeded for UserByModelByDay.' } });
        }
        // 这一次请求本身太大：也是 429，但不是额度用完
        if (mode === '429-large') {
          return send(429, { error: { message: 'Request too large for gpt-4.1 in organization org-mock on tokens per min (TPM): Limit 30000, Requested 44000.', type: 'tokens', code: 'rate_limit_exceeded' } });
        }
        // 只说请求太多，没说等多久（本地模型排队时就是这样）
        if (mode === '429-bare') return send(429, { error: { message: 'server busy, please try again.' } });
        // 模拟非推理模型不认 reasoning_effort
        if (j.reasoning_effort && !/\/o\d/.test(j.model)) return send(400, { error: { message: "Unsupported parameter: 'reasoning_effort' is not supported with this model." } });
        const user = j.messages.find((m) => m.role === 'user').content;
        const info = { model: j.model, effort: j.reasoning_effort, system: j.messages.some((m) => m.role === 'system' && m.content.includes('你是 GPT')), blocks: (user.match(/^【[^】\n]+】$/gm) || []).length };
        const content = user.includes('请只回复两个字') ? '在线' : `GPT：MOCK-GPT ${JSON.stringify(info)}`;
        return send(200, { model: j.model, choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 300, completion_tokens: 40, total_tokens: 340, ...(mode === 'cached' ? { prompt_tokens_details: { cached_tokens: 200 } } : {}) } });
      }
      const g = req.url.match(/^\/v1beta\/models\/([^:]+):generateContent$/);
      if (g) {
        if (req.headers['x-goog-api-key'] !== 'good-key') return send(400, { error: { message: 'API key not valid. Please pass a valid API key.' } });
        // 免费档按天算的额度用完了。返回里的 retryDelay 只有几十秒，其实要等到太平洋时间午夜
        if (mode === 'gemini-daily') {
          return send(429, {
            error: {
              code: 429,
              message:
                'You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits.\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 50\nPlease retry in 34.074824224s.',
              status: 'RESOURCE_EXHAUSTED',
              details: [
                { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests', quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier', quotaValue: '50' }] },
                { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '34s' },
              ],
            },
          });
        }
        // 每分钟的限速：retryDelay 可信
        if (mode === 'gemini-minute') {
          return send(429, {
            error: {
              code: 429,
              message: 'You exceeded your current quota. Please retry in 34.074824224s.',
              status: 'RESOURCE_EXHAUSTED',
              details: [
                { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier', quotaValue: '15' }] },
                { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '34s' },
              ],
            },
          });
        }
        const level = j.generationConfig && j.generationConfig.thinkingConfig && j.generationConfig.thinkingConfig.thinkingLevel;
        if (level && /lite/.test(g[1])) return send(400, { error: { message: 'Thinking level is not supported for this model.' } });
        const text = j.contents[0].parts[0].text;
        const reply = text.includes('请只回复两个字') ? '在线' : `MOCK-GEMINI-API ${JSON.stringify({ system: !!j.systemInstruction, level })}`;
        return send(200, { modelVersion: g[1], usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 30, thoughtsTokenCount: 20, totalTokenCount: 250, ...(mode === 'cached' ? { cachedContentTokenCount: 150 } : {}) }, candidates: [{ content: { parts: [{ text: '（思考过程）', thought: true }, { text: reply }] } }] });
      }
      send(404, {});
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({
        port: server.address().port,
        setMode: (m) => (mode = m),
        close: () => new Promise((r) => server.close(r)),
      })
    );
  });
}

module.exports = { startMockApi };
