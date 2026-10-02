import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

process.umask(0o077)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const suite = process.argv[2] || 'unit'
assert(['unit', 'integration'].includes(suite))
const output = join(root, 'frontend/tmp/backend-tests')
await mkdir(output, { recursive: true, mode: 0o700 })
assert((await readdir(output)).length < 10, 'Review/archive previous backend reports before exceeding the ten-run retention budget')
const directory = await mkdtemp(join(output, 'run-'))
const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
  GOTOOLCHAIN: 'go1.27.0', GOMAXPROCS: '2', GOMEMLIMIT: '1GiB' }
if (suite === 'integration') Object.assign(env, {
  DOCKER_HOST: process.env.DOCKER_HOST || 'unix:///Users/clawbotbot/.colima/default/docker.sock',
  TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE: '/var/run/docker.sock', TESTCONTAINERS_HOST_OVERRIDE: '127.0.0.1', CI: 'true'
})
const child = spawn('go', ['test', '-json', `-tags=${suite}`, '-p', suite === 'integration' ? '1' : '2',
  '-parallel', '2', '-count=1', '-timeout=10m', './...'], { cwd: join(root, 'backend'), env,
  detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
const completion = new Promise(resolve => {
  child.once('error', error => resolve({ code: null, error: error.message }))
  child.once('exit', (code, signal) => resolve({ code, signal }))
})
function terminate() {
  if (child.pid && child.exitCode === null) {
    try { process.kill(-child.pid, 'SIGTERM') } catch (error) { if (error.code !== 'ESRCH') throw error }
  }
}
process.once('SIGINT', terminate)
process.once('SIGTERM', terminate)
const timer = setTimeout(terminate, 12 * 60_000)
const logs = new Map()
const failures = []
let stderr = '', events = 0, packagesPassed = 0, testsPassed = 0, testsSkipped = 0, failureBytes = 0
child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-32_768) })
try {
  for await (const line of createInterface({ input: child.stdout })) {
    let event
    try { event = JSON.parse(line) } catch { stderr = (stderr + line).slice(-32_768); continue }
    events++
    const id = `${event.Package}:${event.Test || ''}`
    if (event.Output) logs.set(id, ((logs.get(id) || '') + event.Output).slice(-32_768))
    if (event.Action === 'pass') {
      if (event.Test) testsPassed++; else packagesPassed++
    }
    if (event.Action === 'skip' && event.Test) testsSkipped++
    if (event.Action === 'fail' || event.Action === 'build-fail') {
      const detail = (logs.get(id) || '').slice(0, Math.max(0, (4 << 20) - failureBytes))
      failureBytes += Buffer.byteLength(detail)
      failures.push({ package: event.Package, test: event.Test, action: event.Action, detail })
    }
    if (['pass', 'skip', 'fail', 'build-fail'].includes(event.Action)) logs.delete(id)
    if (logs.size > 512) logs.delete(logs.keys().next().value)
  }
  const result = await completion
  const passed = result.code === 0 && events > 0 && packagesPassed > 0 && failures.length === 0
  const report = { suite, toolchain: env.GOTOOLCHAIN, result, passed, packagesPassed, testsPassed,
    testsSkipped, failures, stderr, productionDeploymentPerformed: false, liveTestCredentialsInherited: false }
  await writeFile(join(directory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  console.log(JSON.stringify({ ...report, failures: failures.map(({ package: pkg, test }) => ({ package: pkg, test })),
    stderr: undefined, directory }, null, 2))
  if (!passed) process.exitCode = 1
} finally {
  clearTimeout(timer)
  process.removeListener('SIGINT', terminate)
  process.removeListener('SIGTERM', terminate)
  terminate()
}
