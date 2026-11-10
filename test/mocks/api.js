'use strict';
// 模拟 GitHub Models 和 Gemini API 的 HTTP 接口
const http = require('http');

function startMockApi() {
  let mode = 'ok';
  const requests = []; // 收到的请求，测试用它来检查图片和文件有没有带上
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const j = body ? JSON.parse(body) : {};
      requests.push({ url: req.url, body: j });
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
        if (mode === '429') return send(429, { error: { message: 'Rate limit of 50 per 86400s exceeded for UserByModelByDay.' } });
        // 模拟非推理模型不认 reasoning_effort
        if (j.reasoning_effort && !/\/o\d/.test(j.model)) return send(400, { error: { message: "Unsupported parameter: 'reasoning_effort' is not supported with this model." } });
        // 带图片 / 文件时 content 是数组；'no-vision' 模拟不能看图的模型
        const raw = j.messages.find((m) => m.role === 'user').content;
        if (mode === 'no-vision' && Array.isArray(raw)) return send(400, { error: { message: 'Invalid content type. image_url is only supported by certain models.' } });
        const user = Array.isArray(raw) ? raw.map((p) => p.text || '').join('\n') : raw;
        const info = { model: j.model, effort: j.reasoning_effort, system: j.messages.some((m) => m.role === 'system' && m.content.includes('你是 GPT')), blocks: (user.match(/^【[^】\n]+】$/gm) || []).length };
        const content = user.includes('请只回复两个字') ? '在线' : `GPT：MOCK-GPT ${JSON.stringify(info)}`;
        return send(200, { model: j.model, choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] });
      }
      const g = req.url.match(/^\/v1beta\/models\/([^:]+):generateContent$/);
      if (g) {
        if (req.headers['x-goog-api-key'] !== 'good-key') return send(400, { error: { message: 'API key not valid. Please pass a valid API key.' } });
        const level = j.generationConfig && j.generationConfig.thinkingConfig && j.generationConfig.thinkingConfig.thinkingLevel;
        if (level && /lite/.test(g[1])) return send(400, { error: { message: 'Thinking level is not supported for this model.' } });
        if (mode === 'no-vision' && j.contents[0].parts.some((p) => p.inlineData)) return send(400, { error: { message: 'Unable to process input image. Please retry or report in https://developers.generativeai.google/guide/troubleshooting' } });
        const text = j.contents[0].parts[0].text;
        const reply = text.includes('请只回复两个字') ? '在线' : `MOCK-GEMINI-API ${JSON.stringify({ system: !!j.systemInstruction, level })}`;
        return send(200, { modelVersion: g[1], candidates: [{ content: { parts: [{ text: '（思考过程）', thought: true }, { text: reply }] } }] });
      }
      send(404, {});
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({
        port: server.address().port,
        setMode: (m) => (mode = m),
        requests,
        close: () => new Promise((r) => server.close(r)),
      })
    );
  });
}

module.exports = { startMockApi };
