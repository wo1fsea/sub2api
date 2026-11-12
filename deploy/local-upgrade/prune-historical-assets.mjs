import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { assetGraph, mergeAssetInventory, request } from './upgrade-current.mjs'
import { acquireLock, directory, deployment, names, routing } from './service-recovery.mjs'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const pattern = /^\/assets\/[a-zA-Z0-9_.-]+-[a-zA-Z0-9_-]{6,}\.(?:js|css)$/
const cutoff = Date.parse('2026-11-01T00:00:00+08:00')
const currentImage = 'sha256:ed98069e97165ce50a1286cd7707fa250c8b864e4651ab63cad0d3ce1e5b1655'
const summary = items => ({ count: items.length, bytes: items.reduce((n, item) => n + item.bytes, 0) })

export function planPrune(history, currentGraph, mtimes, olderThan = cutoff) {
  // Reuse production validation, including collision and the unchanged budget.
  mergeAssetInventory(history, [])
  assert(currentGraph.size > 50 && currentGraph.size <= 1000, 'Incomplete current asset graph')
  const retained = [], removed = []
  for (const item of history) {
    assert(pattern.test(item.path) && Number.isFinite(mtimes[item.path]), 'Invalid historical asset metadata')
    const current = currentGraph.get(item.path)
    if (current) assert.equal(sha(current), item.sha256, 'Current asset conflicts with historical bytes')
    ;(!current && mtimes[item.path] < olderThan ? removed : retained).push(item)
  }
  const protectedInventory = mergeAssetInventory(retained, [currentGraph]).assets
  // assetGraph rejects >1000 files and >=64MiB for ANY candidate. Treat every
  // candidate file as new, so this upper bound is safe without starting it live.
  const protectedSize = summary(protectedInventory)
  const worstMerged = { count: protectedSize.count + 1000, bytes: protectedSize.bytes + (64 << 20) }
  assert(worstMerged.count < 1800 && worstMerged.bytes < (96 << 20), 'Prune plan cannot guarantee the existing merge budget')
  assert(removed.length > 0, 'No old unprotected assets to prune')
  return { before: summary(history), after: summary(retained), protectedSize, worstMerged,
    retained, removed, currentGraphCount: currentGraph.size, cutoff: new Date(olderThan).toISOString() }
}

function docker(args) {
  const r = spawnSync('docker', args, { encoding: 'utf8', timeout: 30_000, maxBuffer: 1 << 20 })
  assert(!r.error && r.status === 0, `Cache operation docker ${args[0]} failed; details suppressed`)
  return r.stdout.trim()
}
async function currentPin() {
  const state = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'))
  const [container] = JSON.parse(docker(['inspect', names.app]))
  assert.equal(state.image, currentImage)
  assert.equal(container.Image, currentImage)
  assert.equal(container.State.Health.Status, 'healthy')
  assert.equal(await readFile(join(directory, 'haproxy.cfg'), 'utf8'), routing(names.app + ':8080'))
  return container.Id
}
async function reloadMap() {
  docker(['exec', names.ingress, 'haproxy', '-c', '-f', '/usr/local/etc/haproxy/haproxy.cfg'])
  docker(['kill', '--signal=USR2', names.ingress])
  await delay(1500)
  assert.equal((await (await request('http://127.0.0.1:18480', '/health')).json()).status, 'ok')
}

async function main() {
  process.umask(0o077)
  const action = process.argv[2]
  assert(['plan', 'apply'].includes(action), 'Use plan or apply')
  const lockPath = join(deployment, '.release-operation.lock')
  const lock = await acquireLock(lockPath)
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, action: 'prune-historical-assets', startedAt: new Date().toISOString() }))
    const currentId = await currentPin()
    const indexPath = join(directory, 'assets.json'), mapPath = join(directory, 'old-assets.map')
    const [indexBytes, mapBytes] = await Promise.all([readFile(indexPath), readFile(mapPath)])
    const history = JSON.parse(indexBytes), mtimes = {}
    assert.equal(mapBytes.toString(), history.map(item => `${item.path} cached`).join('\n') + '\n', 'Historical routing map differs from inventory')
    for (const folder of ['static', 'static/assets']) {
      const info = await lstat(join(directory, folder))
      assert(info.isDirectory() && !info.isSymbolicLink(), 'Unexpected static directory')
    }
    for (const item of history) {
      assert(pattern.test(item.path), 'Unsafe historical asset path')
      const path = join(directory, 'static', item.path.slice(1)), info = await lstat(path)
      assert(info.isFile() && !info.isSymbolicLink() && info.size === item.bytes, 'Historical asset metadata changed')
      assert.equal(sha(await readFile(path)), item.sha256, 'Historical asset checksum changed')
      mtimes[item.path] = info.mtimeMs
    }
    const graph = await assetGraph('http://127.0.0.1:18583')
    const plan = planPrune(history, graph, mtimes)
    const { retained, removed, ...publicPlan } = plan
    if (action === 'plan') { console.log(JSON.stringify(publicPlan, null, 2)); return }
    assert.equal(await currentPin(), currentId, 'Current application changed during planning')
    assert.equal(sha(await readFile(indexPath)), sha(indexBytes))
    assert.equal(sha(await readFile(mapPath)), sha(mapBytes))
    const archive = await mkdtemp('/Users/clawbotbot/Projects/sub2api-upgrade-private/cache-prune-')
    await chmod(archive, 0o700)
    await mkdir(join(archive, 'assets'), { mode: 0o700 })
    for (const file of ['assets.json', 'old-assets.map']) {
      await copyFile(join(directory, file), join(archive, file))
      await chmod(join(archive, file), 0o600)
    }
    await writeFile(join(archive, 'plan.json'), JSON.stringify({ ...plan, currentImage, currentId,
      protectedCurrent: [...graph].map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: sha(bytes) })) }, null, 2), { flag: 'wx', mode: 0o600 })
    const moved = []
    try {
      await writeFile(indexPath, JSON.stringify(retained, null, 2) + '\n', { mode: 0o644 })
      // Keep the bind-mounted map inode, and reload it before retiring files.
      await writeFile(mapPath, retained.map(item => `${item.path} cached`).join('\n') + '\n', { mode: 0o644 })
      await reloadMap()
      for (const item of removed) {
        await rename(join(directory, 'static', item.path.slice(1)), join(archive, item.path.slice(1)))
        moved.push(item)
      }
      for (const [path, bytes] of graph) {
        const response = await request('http://127.0.0.1:18480', path)
        assert.equal(sha(Buffer.from(await response.arrayBuffer())), sha(bytes), 'Current rollback resource failed after pruning')
      }
      assert.equal(await currentPin(), currentId)
      const result = { ...publicPlan, archive, removedCount: removed.length, currentGraphVerified: true,
        currentAppUnchanged: true, recoverable: true, completedAt: new Date().toISOString() }
      await writeFile(join(archive, 'result.json'), JSON.stringify(result, null, 2), { flag: 'wx', mode: 0o600 })
      console.log(JSON.stringify(result, null, 2))
    } catch (error) {
      for (const item of moved) await rename(join(archive, item.path.slice(1)), join(directory, 'static', item.path.slice(1)))
      await writeFile(indexPath, indexBytes)
      await writeFile(mapPath, mapBytes)
      await reloadMap()
      throw error
    }
  } finally { await lock.close(); await unlink(lockPath) }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('Historical asset pruning failed; no cutover permitted. Private details suppressed.'); process.exitCode = 1 })
}
