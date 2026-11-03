import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { test } from 'node:test'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { currentCodex, liveGateway } from './live-gateway.mjs'

test('configuration parser uses the process-only interpreter override and preserves validation', t => {
  const priorPython = process.env.SUB2API_CONFIG_PYTHON, priorKey = process.env.SUB2API_API_KEY
  const executable = '/synthetic/python3.11'
  const key = 'synthetic-private-key'
  process.env.SUB2API_CONFIG_PYTHON = executable
  process.env.SUB2API_API_KEY = key
  const metadata = { provider: 'sub2api', model: 'synthetic-model',
    baseUrl: 'https://openclaw-macmini-ts.tailff52e6.ts.net/v1', envKey: 'SUB2API_API_KEY', wireApi: 'responses' }
  let result = { status: 0, stdout: JSON.stringify(metadata) }, calls = 0
  const mock = t.mock.method(childProcess, 'spawnSync', (command, args, options) => {
    calls++
    assert.equal(command, executable)
    assert.equal(args[0], '-c')
    assert(args[1].includes('import tomllib'))
    assert(!JSON.stringify(args).includes(key))
    assert.equal(options.timeout, 5000)
    assert.equal(options.maxBuffer, 16 << 10)
    return result
  })
  syncBuiltinESMExports()
  try {
    assert.deepEqual(currentCodex(), { ...metadata, key })
    result = { status: null, error: Object.assign(new Error(key), { code: 'ENOENT' }) }
    assert.throws(() => currentCodex(), error => /Cannot parse/.test(error.message) && !error.message.includes(key))
    assert.equal(calls, 2, 'A missing explicit override must fail without silently trying another runtime')
    result = { status: 1, stderr: key }
    assert.throws(() => currentCodex(), error => /Cannot parse/.test(error.message) && !error.message.includes(key))
    for (const change of [{ provider: 'other' }, { wireApi: 'chat' }, { envKey: 'OTHER_KEY' }, { baseUrl: 'https://example.invalid/v1' }]) {
      result = { status: 0, stdout: JSON.stringify({ ...metadata, ...change }) }
      assert.throws(() => currentCodex())
    }
    result = { status: 0, stdout: JSON.stringify(metadata) }
    delete process.env.SUB2API_API_KEY
    assert.throws(() => currentCodex(), /key is not available/)
  } finally {
    mock.mock.restore(); syncBuiltinESMExports()
    if (priorPython === undefined) delete process.env.SUB2API_CONFIG_PYTHON
    else process.env.SUB2API_CONFIG_PYTHON = priorPython
    if (priorKey === undefined) delete process.env.SUB2API_API_KEY
    else process.env.SUB2API_API_KEY = priorKey
  }
})

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
