import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'

// Only the JSON settings endpoint is supported. HTTP/1.0 may omit length for
// large bodies; a fully parsed JSON document then supplies the completion fence.
export function completeSettingsResponse(bytes) {
  const boundary = bytes.indexOf('\r\n\r\n')
  if (boundary < 0) return null
  const headers = bytes.subarray(0, boundary).toString('utf8')
  const status = Number(headers.match(/^HTTP\/1\.[01] (\d{3})\b/)?.[1])
  if (!status || !/^Content-Type:\s*application\/json\b/im.test(headers)) return null
  const body = bytes.subarray(boundary + 4)
  const length = headers.match(/^Content-Length:\s*(\d+)\s*$/im)
  if (length && body.length !== Number(length[1])) return null
  if (/^Transfer-Encoding:/im.test(headers)) return null
  try { JSON.parse(body.toString('utf8')) } catch { return null }
  return { status, body: body.toString('utf8') }
}

export async function isolatedSettingsPut(containerId, token, body, {
  spawnProcess = spawn, timeoutMs = 10000, record = () => {}
} = {}) {
  const json = JSON.stringify(body)
  const wire = `PUT /api/v1/admin/settings HTTP/1.0\r\nHost: localhost\r\nAuthorization: Bearer ${token}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(json)}\r\nConnection: close\r\n\r\n${json}`
  const started = Date.now()
  const child = spawnProcess('docker', ['exec', '-i', containerId, 'nc', '-w', '5', '127.0.0.1', '8080'], { stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = Buffer.alloc(0), stderr = '', receivedBytes = 0, termination = null, processError = null, stdinError = null, response = null
  let killTimer
  const terminate = reason => {
    if (termination) return
    termination = reason
    child.stdin.destroy()
    child.kill('SIGTERM')
    killTimer = setTimeout(() => child.kill('SIGKILL'), 1000)
  }
  const timer = setTimeout(() => terminate('timeout'), timeoutMs)
  child.stdout.on('data', chunk => {
    receivedBytes += chunk.length
    stdout = Buffer.concat([stdout, chunk]).subarray(0, 1 << 20)
    if (receivedBytes > 1 << 20) return terminate('response-limit')
    response = completeSettingsResponse(stdout)
    // nc/server have delivered the complete response. Close Docker's attach
    // stdin now, not before the request has finished and not at a timeout.
    if (response && !child.stdin.writableEnded) child.stdin.end()
  })
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(-16384) })
  child.stdin.on('error', error => { stdinError = error.code || error.name; terminate('stdin-error') })
  child.on('error', error => { processError = error.code || error.name })
  const closed = new Promise(resolve => child.once('close', (exitCode, signal) => resolve({ exitCode, signal })))
  child.stdin.write(wire)
  let exit
  try { exit = await closed } finally { clearTimeout(timer); clearTimeout(killTimer); child.stdin.destroy() }
  const diagnostic = { ...exit, elapsedMs: Date.now() - started, termination, processError, stdinError,
    stderr, receivedBytes, responseFragment: stdout.subarray(0, 4096).toString('utf8'),
    responseComplete: !!response, httpStatus: response?.status ?? null }
  // The caller must retain this only in the protected rehearsal directory:
  // settings responses and Docker errors can contain private configuration.
  await record(diagnostic)
  assert(!termination && !processError && !stdinError && exit.exitCode === 0 && !exit.signal,
    'Isolated PUT transport failed; inspect private PUT diagnostic')
  assert(response, 'Incomplete isolated PUT JSON response; inspect private PUT diagnostic')
  return response
}
