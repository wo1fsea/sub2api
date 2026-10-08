import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

export function currentCodex() {
  const python = process.env.SUB2API_CONFIG_PYTHON ||
    '/Users/clawbotbot/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3'
  const result = spawnSync(python, ['-c', `import tomllib,json,pathlib
c=tomllib.loads(pathlib.Path('/Users/clawbotbot/.codex/config.toml').read_text())
p=c['model_providers'][c['model_provider']]
print(json.dumps({'provider':c['model_provider'],'model':c['model'],'baseUrl':p['base_url'],'envKey':p['env_key'],'wireApi':p['wire_api']}))`],
  { encoding: 'utf8', timeout: 5000, maxBuffer: 16 << 10 })
  assert(!result.error && result.status === 0, 'Cannot parse current Codex configuration; details suppressed')
  const config = JSON.parse(result.stdout)
  assert.equal(config.provider, 'sub2api')
  assert.equal(config.wireApi, 'responses')
  assert.equal(config.envKey, 'SUB2API_API_KEY')
  assert.equal(new URL(config.baseUrl).hostname, 'openclaw-macmini-ts.tailff52e6.ts.net')
  assert(process.env[config.envKey], 'The current configured API key is not available in this process')
  return { ...config, key: process.env[config.envKey] }
}

export async function liveGateway(baseUrl, expectedSlot, { config = currentCodex(), timeoutMs = 90_000 } = {}) {
  const base = new URL(baseUrl)
  assert(['127.0.0.1', 'openclaw-macmini-ts.tailff52e6.ts.net', 'getcodex.pro'].includes(base.hostname), 'Do not send the key to another host')
  if (base.hostname !== '127.0.0.1') assert.equal(base.protocol, 'https:')
  const started = Date.now()
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/responses`, {
    method: 'POST', headers: { Authorization: `Bearer ${config.key}`, 'Content-Type': 'application/json', Connection: 'close' },
    body: JSON.stringify({ model: config.model, instructions: 'This is a connectivity check. Reply with exactly OK.',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'Reply OK.' }] }],
      reasoning: { effort: 'low' }, max_output_tokens: 128, stream: true, store: false }),
    redirect: 'error', signal: AbortSignal.timeout(timeoutMs)
  })
  assert.equal(response.status, 200, `Gateway returned HTTP ${response.status}; response details suppressed`)
  if (expectedSlot) assert.equal(response.headers.get('x-sub2api-slot'), expectedSlot)
  assert(response.headers.get('content-type')?.includes('text/event-stream'), 'Expected a real Responses stream')
  let bytes = 0, pending = '', firstTokenMs, terminal, output = ''
  const types = new Set()
  const decoder = new TextDecoder()
  for await (const chunk of response.body) {
    bytes += chunk.length
    assert(bytes <= 1 << 20, 'Connectivity response exceeded its byte budget')
    pending = (pending + decoder.decode(chunk, { stream: true })).replace(/\r\n/g, '\n')
    let boundary
    while ((boundary = pending.indexOf('\n\n')) >= 0) {
      const event = pending.slice(0, boundary)
      pending = pending.slice(boundary + 2)
      const data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
      if (!data || data === '[DONE]') continue
      const value = JSON.parse(data)
      types.add(value.type)
      assert(!['error', 'response.failed', 'response.incomplete'].includes(value.type), 'Upstream stream failed or was incomplete; details suppressed')
      if (value.type === 'response.output_text.delta' && typeof value.delta === 'string') {
        firstTokenMs ??= Date.now() - started
        output += value.delta
      }
      if (value.type === 'response.completed' || value.type === 'response.done') terminal = value.response
    }
  }
  assert(terminal && terminal.status === 'completed', 'Missing completed Responses terminal event')
  assert(output.trim().length > 0 && /\bOK\b/.test(output), 'The actual model did not return the expected check text')
  return { checkedAt: new Date().toISOString(), model: config.model, httpStatus: response.status,
    firstTokenMs, totalMs: Date.now() - started, outputCharacters: output.length,
    completed: true, slot: response.headers.get('x-sub2api-slot'),
    inputTokens: terminal.usage?.input_tokens, outputTokens: terminal.usage?.output_tokens,
    eventTypes: [...types].filter(type => typeof type === 'string'), automaticRetries: 0 }
}
