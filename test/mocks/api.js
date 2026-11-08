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
        return send(200, [
          { id: 'openai/gpt-4.1', name: 'OpenAI GPT-4.1', publisher: 'OpenAI', rate_limit_tier: 'high' },
          { id: 'meta/llama-x', name: 'Llama', publisher: 'Meta', rate_limit_tier: 'low' },
        ]);
      }
      if (req.url === '/inference/chat/completions') {
        if (req.headers.authorization !== 'Bearer good-token') return send(401, { error: { message: 'Bad credentials' } });
        if (mode === '429') return send(429, { error: { message: 'Rate limit of 50 per 86400s exceeded for UserByModelByDay.' } });
        const user = j.messages.find((m) => m.role === 'user').content;
        const info = { model: j.model, system: j.messages.some((m) => m.role === 'system' && m.content.includes('你是 GPT')), blocks: (user.match(/^【[^】\n]+】$/gm) || []).length };
        const content = user.includes('请只回复两个字') ? '在线' : `GPT：MOCK-GPT ${JSON.stringify(info)}`;
        return send(200, { model: j.model, choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] });
      }
      const g = req.url.match(/^\/v1beta\/models\/([^:]+):generateContent$/);
      if (g) {
        if (req.headers['x-goog-api-key'] !== 'good-key') return send(400, { error: { message: 'API key not valid. Please pass a valid API key.' } });
        const text = j.contents[0].parts[0].text;
        const reply = text.includes('请只回复两个字') ? '在线' : `MOCK-GEMINI-API ${JSON.stringify({ system: !!j.systemInstruction })}`;
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
        close: () => new Promise((r) => server.close(r)),
      })
    );
  });
}

module.exports = { startMockApi };
