import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { test } from 'node:test'
import { liveGateway } from './live-gateway.mjs'

const config = { key: 'synthetic-not-a-real-key', model: 'synthetic-model' }
const complete = [{ type: 'response.output_text.delta', delta: 'OK' },
  { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 5, output_tokens: 1 } } }]

async function fixture(fn, { events = complete, status = 200, type = 'text/event-stream', slot = 'green', splitCRLF = false } = {}) {
  let requests = 0
  const server = createServer(async (req, res) => {
    requests++
    assert.equal(req.headers.authorization, `Bearer ${config.key}`)
    let body = ''
    for await (const chunk of req) body += chunk
    const input = JSON.parse(body)
    assert.equal(input.model, config.model)
    assert.equal(input.max_output_tokens, 128)
    res.writeHead(status, { 'Content-Type': type, 'X-Sub2API-Slot': slot })
    if (type !== 'text/event-stream') { res.end('<html>not-an-asset-or-api</html>'); return }
    for (const event of events) {
      if (splitCRLF) {
        res.write(`data: ${JSON.stringify(event)}\r`)
        await new Promise(resolve => setImmediate(resolve))
        res.write('\n\r')
        await new Promise(resolve => setImmediate(resolve))
        res.write('\n')
      } else res.write(`data: ${JSON.stringify(event)}\n\n`)
    }
    res.end()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try { await fn(`http://127.0.0.1:${server.address().port}/v1`) } finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
  assert.equal(requests, 1, 'The probe must never replay a POST')
}

test('real success requires output plus completed terminal event, including split CRLF', async () => {
  await fixture(async base => {
    const result = await liveGateway(base, 'green', { config, timeoutMs: 3000 })
    assert.equal(result.completed, true)
    assert.equal(result.outputCharacters, 2)
    assert.equal(result.automaticRetries, 0)
    assert.equal(result.outputTokens, 1)
  }, { splitCRLF: true })
})

for (const [name, options] of [
  ['HTTP error', { status: 500 }],
  ['HTML 200', { type: 'text/html' }],
  ['wrong instance', { slot: 'blue' }],
  ['failed terminal event', { events: [{ type: 'response.failed', response: { status: 'failed' } }] }],
  ['missing terminal event', { events: [{ type: 'response.output_text.delta', delta: 'OK' }] }],
  ['empty completed response', { events: [complete[1]] }]
]) {
  test(`reject ${name} without retry`, async () => {
    await fixture(base => assert.rejects(liveGateway(base, 'green', { config, timeoutMs: 3000 })), options)
  })
}

test('never send credentials to an unrelated host', async () => {
  await assert.rejects(liveGateway('https://example.invalid/v1', undefined, { config }), /another host/)
})
