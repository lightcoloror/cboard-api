'use strict';
// Synthetic OpenAI-compatible HTTP endpoint. No external service or model.
const http = require('http');
const assert = require('assert').strict;

async function createCareAiTestProvider({ host = '127.0.0.1', port = 0 } = {}) {
  const queue = [];
  const stats = { calls: 0, unexpected: 0, invalidAuthorization: 0 };
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(404); res.end(); return;
    }
    stats.calls += 1;
    if (req.headers.authorization !== 'Bearer synthetic-care-ai-provider') stats.invalidAuthorization += 1;
    const scenario = queue.shift();
    if (!scenario) {
      stats.unexpected += 1;
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'No synthetic scenario queued' } }));
      req.resume(); return;
    }
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (Buffer.byteLength(body) > 1024 * 1024) req.destroy();
    });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        if (scenario.observeRequest) scenario.observeRequest(parsed);
      } catch (_) { res.writeHead(400); res.end(); return; }
      const respond = () => {
        if (res.destroyed) return;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ model: 'synthetic-care-model',
          choices: [{ message: { role: 'assistant', content: scenario.content }, finish_reason: 'stop' }],
          ...(scenario.usage === false ? {} : { usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } }) }));
      };
      const timer = scenario.gate ? null : setTimeout(respond, scenario.timeout ? 4000 : scenario.delayMs || 0);
      if (scenario.gate) scenario.gate.then(respond);
      res.once('close', () => clearTimeout(timer));
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  return {
    origin: `http://${host}:${server.address().port}`,
    stats,
    enqueue(scenario) {
      let release = () => {};
      const queued = { ...scenario };
      if (scenario.hold) queued.gate = new Promise(resolve => { release = resolve; });
      queue.push(queued);
      return { release };
    },
    assertConsumed() { assert.equal(queue.length, 0); assert.equal(stats.unexpected, 0); assert.equal(stats.invalidAuthorization, 0); },
    close: () => new Promise(resolve => server.close(resolve))
  };
}
module.exports = { createCareAiTestProvider };
