import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { desiredCompose, roleEnvironment, routing, names, image, assertCurrent, assertVersion, retired, acquireLock } from './service-recovery.mjs'

test('background ownership moves to the new app without mutating its seed', () => {
  const seed = { JWT_SECRET: 'private-fixture', TOKEN_REFRESH_ENABLED: 'false', USAGE_CLEANUP_ENABLED: 'false', CHANNEL_MONITOR_V2_DISABLE_AGGREGATOR: '1' }
  const env = roleEnvironment(seed)
  assert.equal(env.JWT_SECRET, seed.JWT_SECRET)
  assert.equal(env.TOKEN_REFRESH_ENABLED, 'true')
  assert.equal(env.USAGE_CLEANUP_ENABLED, 'true')
  assert.equal(env.CHANNEL_MONITOR_V2_DISABLE_AGGREGATOR, '0')
  assert.equal(env.GATEWAY_SCHEDULING_LEGACY_SNAPSHOT_COMPAT, 'false')
  assert.equal(seed.TOKEN_REFRESH_ENABLED, 'false')
})

test('only fingerprinted GET/HEAD historical resources route to static storage', () => {
  const config = routing(`${names.app}:8080`)
  assert(config.includes('acl asset_read method GET HEAD'))
  assert(config.includes('use_backend historical_assets if asset_read historical_asset'))
  assert(config.includes('default_backend blue'))
  assert(config.includes('retries 0'))
  assert(!config.includes('18080'))
  assert.throws(() => routing('other:8080\nmalicious'), /Invalid pinned upstream/)
})

test('startup owns only pinned current services, preserves loopback clients and bounds logs', () => {
  const config = desiredCompose({ JWT_SECRET: 'private-fixture' })
  assert.deepEqual(Object.keys(config.services), ['app', 'ingress', 'assets', 'compat'])
  assert.equal(config.services.app.image, image)
  assert.equal(config.services.app.volumes[0], 'current-data:/app/data')
  assert.deepEqual(config.services.compat.ports, ['127.0.0.1:18080:8080'])
  assert.equal(config.networks.assets.internal, true)
  for (const service of Object.values(config.services)) {
    assert.equal(service.restart, 'always')
    assert.equal(service.logging.options['max-file'], '2')
    assert.equal(service.pull_policy, 'never')
  }
  assert.equal(config.services.assets.environment, undefined)
  assert.equal(config.services.assets.read_only, true)
  assert(!retired.includes(names.app))
})

test('recovery refuses a changed image, project or disabled background owner', () => {
  const container = { Image: image, Config: { Labels: { 'com.docker.compose.project': 'sub2api-current' }, Env: Object.entries(roleEnvironment({})).map(([k, v]) => `${k}=${v}`) } }
  assert.doesNotThrow(() => assertCurrent(container))
  assert.throws(() => assertCurrent({ ...container, Image: 'wrong-image' }))
  container.Config.Env = ['TOKEN_REFRESH_ENABLED=false']
  assert.throws(() => assertCurrent(container))
})

test('admin version uses the live API envelope and rejects another version', () => {
  assert.doesNotThrow(() => assertVersion({ code: 0, data: { version: '0.2.13' } }))
  assert.throws(() => assertVersion({ data: { version: '0.2.4' } }))
  assert.throws(() => assertVersion({ data: { version: { version: '0.2.13' } } }))
})

test('a crash-left lock does not permanently block boot recovery', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'sub2api-lock-test-'))
  try {
    const path = join(temporary, 'operation.lock')
    await writeFile(path, JSON.stringify({ pid: 999999, action: 'boot' }))
    const lock = await acquireLock(path)
    await lock.writeFile('new owner')
    await lock.close()
    assert.equal(await readFile(path, 'utf8'), 'new owner')
  } finally { await rm(temporary, { recursive: true, force: true }) }
})
