import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { acquireLock, deployment, directory, names, retired } from './service-recovery.mjs'

process.umask(0o077)
const volumes = ['sub2api_app-data', 'sub2api-release-clash2_green-data', 'sub2api-release-v0213_green-data', 'sub2api-release-hatches_candidate-data']
const imageTags = ['weishaw/sub2api:latest', 'sub2api-local:0.2.13-fb5fdab87f49', 'sub2api-local:0.2.13-e4f96ee3f5fd',
  'sub2api-local:0.2.12-clash.2-d69e52c0ff2e', 'sub2api-local:0.2.12-clash.1-f8e8556c8ac4',
  'sub2api-local:0.2.12-clash.1-7aa67e785b36', 'sub2api-local:0.2.12-clash.1-47a9b609c4bf']
const builderName = 'sub2api-release-20261002'
const builderContainer = 'buildx_buildkit_sub2api-release-202610020'
const builderVolume = 'buildx_buildkit_sub2api-release-202610020_state'
const retiredNetwork = 'sub2api-release-clash2_assets'

function command(binary, args) {
  const r = spawnSync(binary, args, { encoding: 'utf8', timeout: 60_000, maxBuffer: 16 << 20 })
  assert(!r.error && r.status === 0, `${binary.split('/').at(-1)} ${args[0]} failed; private details suppressed`)
  return r.stdout.trim()
}
const docker = args => command('/opt/homebrew/bin/docker', args)
const inspect = targets => JSON.parse(docker(['inspect', ...targets]))
const liveNames = () => docker(['ps', '-a', '--format', '{{.Names}}']).split('\n').filter(Boolean)

export function removeLegacyCompose(source) {
  const lines = source.split('\n')
  for (const [section, target] of [['services', 'sub2api'], ['volumes', 'app-data']]) {
    const start = lines.indexOf(`${section}:`)
    assert(start >= 0, 'Unexpected base Compose structure')
    let end = start + 1
    while (end < lines.length && !/^[a-zA-Z0-9_-]+:/.test(lines[end])) end++
    const first = lines.findIndex((line, i) => i > start && i < end && line === `  ${target}:`)
    if (first < 0) continue
    let last = first + 1
    while (last < end && !/^  [a-zA-Z0-9_-]+:/.test(lines[last])) last++
    lines.splice(first, last - first)
  }
  assert(lines.includes('  postgres:') && lines.includes('  redis:'), 'Do not remove shared dependencies')
  return lines.join('\n')
}

async function cleanup() {
  const lockPath = join(deployment, '.release-operation.lock')
  const lock = await acquireLock(lockPath)
  await lock.writeFile(JSON.stringify({ pid: process.pid, action: 'cleanup', startedAt: new Date().toISOString() }))
  try {
    const state = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'))
    assert.equal(state.phase, 'active-old-retired')
    const all = inspect(liveNames())
    const protectedNames = [...Object.values(names), ...state.dependencies.map(d => d.name)]
    const protectedContainers = all.filter(c => protectedNames.includes(c.Name.slice(1)))
    assert.equal(protectedContainers.length, protectedNames.length)
    assert(protectedContainers.every(c => c.State.Running))
    assert.equal(protectedContainers.find(c => c.Name === `/${names.app}`).Image, state.image)
    for (const c of protectedContainers.filter(c => c.State.Health)) assert.equal(c.State.Health.Status, 'healthy')
    const old = all.filter(c => retired.includes(c.Name.slice(1)))
    assert(old.every(c => !c.State.Running), 'Do not force-remove a running legacy container')
    for (const c of all.filter(c => !retired.includes(c.Name.slice(1)))) {
      assert(!c.Mounts.some(m => volumes.includes(m.Name)), 'An old data volume is still used by another container')
      assert(!c.Mounts.some(m => m.Source?.startsWith(join(deployment, 'releases/'))), 'Old configuration remains mounted by a surviving container')
    }
    const builder = all.find(c => c.Name.slice(1) === builderContainer)
    assert(!builder?.State.Running, 'Do not remove an active build worker')
    assert(!all.some(c => c.Name.slice(1) !== builderContainer && c.Mounts.some(m => m.Name === builderVolume)))
    const existingTags = new Set(docker(['image', 'ls', '--format', '{{.Repository}}:{{.Tag}}']).split('\n'))
    const obsoleteImages = imageTags.filter(tag => existingTags.has(tag)).map(tag => ({ tag, metadata: inspect([tag])[0] }))
    const survivingImageIds = new Set(all.filter(c => !retired.includes(c.Name.slice(1))).map(c => c.Image))
    assert(obsoleteImages.every(i => !survivingImageIds.has(i.metadata.Id)), 'An old image is still used by another container')
    const network = JSON.parse(docker(['network', 'inspect', retiredNetwork]))[0]
    const oldIds = new Set(old.map(c => c.Id))
    assert(Object.keys(network.Containers || {}).every(id => oldIds.has(id)))
    assert.equal(network.Labels['com.docker.compose.project'], 'sub2api-release-clash2')

    const archive = join('/Users/clawbotbot/Projects/sub2api-upgrade-private', `retired-${new Date().toISOString().replace(/[:.]/g, '-')}`)
    await mkdir(archive, { mode: 0o700 })
    const original = await readFile(join(deployment, 'compose.yaml'), 'utf8')
    const replacement = removeLegacyCompose(original)
    await writeFile(join(archive, 'compose-original-private.yaml'), original, { mode: 0o600 })
    await writeFile(join(archive, 'inventory-private.json'), JSON.stringify(old), { mode: 0o600 })
    await writeFile(join(archive, 'images.json'), JSON.stringify(obsoleteImages.map(i => ({ tag: i.tag, id: i.metadata.Id, repoDigests: i.metadata.RepoDigests }))), { mode: 0o600 })
    for (const name of ['clash-2', 'v0.2.13', 'hatches-0.2.13']) {
      const source = join(deployment, 'releases', name)
      assert((await lstat(source)).isDirectory(), 'Do not archive an unexpected deployment symlink')
      await rename(source, join(archive, name))
    }
    await writeFile(join(deployment, 'compose.yaml'), replacement, { mode: 0o600 })
    docker(['compose', '--project-name', 'sub2api', '--file', join(deployment, 'compose.yaml'), 'config', '--quiet'])
    assert.equal(docker(['compose', '--project-name', 'sub2api', '--file', join(deployment, 'compose.yaml'), 'config', '--services']), 'postgres\nredis')

    if (old.length) docker(['rm', ...old.map(c => c.Id)])
    const existingVolumes = new Set(docker(['volume', 'ls', '--format', '{{.Name}}']).split('\n'))
    const deletedVolumes = volumes.filter(name => existingVolumes.has(name))
    if (deletedVolumes.length) docker(['volume', 'rm', ...deletedVolumes])
    docker(['network', 'rm', network.Id])
    if (builder) command('/opt/homebrew/opt/docker-buildx/bin/docker-buildx', ['rm', builderName])
    assert(!liveNames().includes(builderContainer), 'The old build worker was not removed')
    assert(!docker(['volume', 'ls', '--format', '{{.Name}}']).split('\n').includes(builderVolume), 'The build cache was not removed')
    for (const i of obsoleteImages) docker(['image', 'rm', i.tag])

    const after = inspect(protectedNames)
    for (const before of protectedContainers) {
      const current = after.find(c => c.Id === before.Id)
      assert(current && current.State.Running && current.State.StartedAt === before.State.StartedAt,
        'A production dependency changed during cleanup')
    }
    assert(!liveNames().some(name => retired.includes(name)))
    state.cleanup = { completedAt: new Date().toISOString(), archive, containers: old.length, volumes: deletedVolumes,
      images: obsoleteImages.map(i => i.tag), network: retiredNetwork, builder: builderName }
    await writeFile(join(directory, 'state.json.pending'), JSON.stringify(state, null, 2), { mode: 0o600 })
    await rename(join(directory, 'state.json.pending'), join(directory, 'state.json'))
    console.log(JSON.stringify(state.cleanup, null, 2))
  } finally { await lock.close(); await unlink(lockPath) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cleanup().catch(error => { console.error(error.message); process.exitCode = 1 })
}
