import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { completeSettingsResponse, isolatedSettingsPut } from './isolated-put.mjs'

const wire = body => `HTTP/1.0 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
const fixture = source => () => spawn(process.execPath, ['-e', source], { stdio: ['pipe', 'pipe', 'pipe'] })
test('settings completion requires full UTF-8 JSON and exact framing', () => {
  const bytes = Buffer.from(wire('{"name":"图片"}'))
  for (let n = 0; n < bytes.length; n++) assert.equal(completeSettingsResponse(bytes.subarray(0, n)), null)
  assert.equal(completeSettingsResponse(bytes).status, 200)
  assert.equal(completeSettingsResponse(Buffer.concat([bytes, Buffer.from('x')])), null)
  assert.equal(completeSettingsResponse(Buffer.from('HTTP/1.0 200 OK\r\nContent-Type: application/json\r\n\r\n{"ok":true}')).status, 200)
  assert.equal(completeSettingsResponse(Buffer.from('HTTP/1.0 200 OK\r\nContent-Type: text/html\r\n\r\n{}')), null)
})
test('stdin remains open through partial response and closes after complete response', async () => {
  let evidence
  const response = wire('{"ok":true}')
  const result = await isolatedSettingsPut('fixture', 'private-token', {}, {
    spawnProcess: fixture(`let complete=false; process.stdin.once('data',()=>{process.stdout.write(${JSON.stringify(response.slice(0,-1))});setTimeout(()=>{complete=true;process.stdout.write('}')},80)});process.stdin.on('end',()=>process.exit(complete?0:9));process.stdin.resume()`),
    record: d => { evidence=d }
  })
  assert.equal(result.status,200);assert.equal(evidence.exitCode,0);assert.equal(evidence.termination,null)
  assert(evidence.elapsedMs >= 80);assert(!JSON.stringify(evidence).includes('private-token'))
})
test('nonzero exit preserves stderr and received partial response', async () => {
  let evidence
  await assert.rejects(isolatedSettingsPut('fixture','secret',{}, {
    spawnProcess:fixture("process.stdin.once('data',()=>{process.stdout.write('HTTP/1.0 200');process.stderr.write('nc: connection reset');process.exitCode=7;process.stdin.destroy()})"),
    record:d=>{evidence=d}
  }),/transport failed/)
  assert.equal(evidence.exitCode,7);assert.equal(evidence.stderr,'nc: connection reset');assert.equal(evidence.responseFragment,'HTTP/1.0 200')
})
test('timeout cannot become a success even when SIGTERM produces exit zero', async () => {
  let evidence
  await assert.rejects(isolatedSettingsPut('fixture','secret',{}, {
    timeoutMs:150,spawnProcess:fixture("process.on('SIGTERM',()=>process.exit(0));process.stdin.resume();setInterval(()=>{},1000)"),record:d=>{evidence=d}
  }),/transport failed/)
  assert.equal(evidence.termination,'timeout');assert.equal(evidence.exitCode,0);assert.equal(evidence.responseComplete,false)
})
test('truncated JSON with clean process exit is rejected', async () => {
  let evidence
  await assert.rejects(isolatedSettingsPut('fixture','secret',{}, {
    spawnProcess:fixture(`process.stdin.once('data',()=>{process.stdout.write(${JSON.stringify(wire('{'))});process.stdin.destroy()})`),record:d=>{evidence=d}
  }),/Incomplete/)
  assert.equal(evidence.exitCode,0);assert.equal(evidence.responseComplete,false)
})
test('oversize response is bounded and rejected', async () => {
  let evidence
  await assert.rejects(isolatedSettingsPut('fixture','secret',{}, {
    spawnProcess:fixture("process.stdin.once('data',()=>process.stdout.write('x'.repeat(2<<20)));process.stdin.resume()"),record:d=>{evidence=d}
  }),/transport failed/)
  assert.equal(evidence.termination,'response-limit');assert.equal(evidence.responseFragment.length,4096)
})
