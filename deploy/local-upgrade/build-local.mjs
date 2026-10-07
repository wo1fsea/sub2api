import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const inputs = JSON.parse(await readFile(join(root, 'deploy/local-upgrade/build-inputs.json'), 'utf8'))
// Keep the local ARM package name unchanged; remote x86 hosts need their own tag.
inputs.platform = process.env.SUB2API_PLATFORM || inputs.platform
const validation = JSON.parse(await readFile(join(root, 'deploy/local-upgrade/source-validation.json'), 'utf8'))
const buildx = process.env.SUB2API_BUILDX || 'docker-buildx'
const builder = process.env.SUB2API_BUILDER || 'sub2api-release-20261002'

function run(command, args, capture = false) {
  const result = spawnSync(command, args, {
    cwd: root, encoding: capture === 'raw' ? undefined : 'utf8',
    stdio: capture ? 'pipe' : 'inherit', maxBuffer: 8 * 1024 * 1024
  })
  if (result.error) throw result.error
  assert.equal(result.status, 0, `${command} failed${capture ? `: ${result.stderr}` : ''}`)
  return capture === 'raw' ? result.stdout : capture ? result.stdout.trim() : undefined
}

async function checksum(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

assert.equal(run('git', ['status', '--porcelain'], true), '', 'Commit source changes before packaging')
assert.match(inputs.version, /^[0-9]+\.[0-9]+\.[0-9]+$/)
assert.equal(inputs.upstreamTag, `v${inputs.version}`)
assert.equal((await readFile(join(root, 'backend/cmd/server/VERSION'), 'utf8')).trim(), inputs.version)
assert(['linux/arm64', 'linux/amd64'].includes(inputs.platform), 'Unsupported release platform')
assert.equal(run('git', ['rev-parse', `${inputs.upstreamTag}^{commit}`], true), inputs.upstreamCommit)
run('git', ['merge-base', '--is-ancestor', inputs.upstreamCommit, 'HEAD'])
const commit = run('git', ['rev-parse', 'HEAD'], true)
assert.equal(run('git', ['rev-parse', 'HEAD:backend'], true), validation.backendTree,
  'Backend changed since source qualification; re-run and record its checks')
assert.equal(run('git', ['rev-parse', 'HEAD:frontend'], true), validation.frontendTree,
  'Frontend changed since source qualification; re-run and record its checks')
assert.equal(validation.status, 'source-checks-passed-not-production-approved')
if (inputs.buildResources.viteNodeOptions) {
  const frontendPackage = JSON.parse(await readFile(join(root, 'frontend/package.json'), 'utf8'))
  assert.equal(frontendPackage.scripts.build, 'pnpm run check:i18n && vue-tsc -b && vite build',
    'Update the direct build stages if upstream changes its required checks')
}
const date = run('git', ['show', '-s', '--format=%cI', commit], true)
const image = `sub2api-local:${inputs.version}-${commit.slice(0, 12)}${inputs.platform === 'linux/amd64' ? '-amd64' : ''}`
const name = `sub2api_${inputs.version}_${inputs.platform.replace('/', '_')}_${commit.slice(0, 12)}`
const output = join(root, 'release', name)
await mkdir(join(root, 'release'), { recursive: true })
const buildMarker = join(output, 'BUILDING.json')
const buildIdentity = { commit, inputs }
try {
  await mkdir(output)
  await writeFile(buildMarker, JSON.stringify(buildIdentity), { flag: 'wx' })
} catch (error) {
  if (error.code !== 'EEXIST') throw error
  assert.deepEqual(JSON.parse(await readFile(buildMarker, 'utf8')), buildIdentity,
    'Only an interrupted build of exactly the same source and inputs can be retried')
  await assert.rejects(readFile(join(output, 'manifest.json')), { code: 'ENOENT' },
    'Do not overwrite a completed package')
}
const imagePath = join(output, 'image.tar')
const sourcePath = join(output, 'source.tar.gz')
run('git', ['archive', '--format=tar.gz', `--output=${sourcePath}`, commit])
const context = await mkdtemp(join(root, 'release', '.build-context-'))
try {
  // Build only committed source; ignored local files must never enter the context.
  run('tar', ['-xzf', sourcePath, '-C', context])

  run(buildx, [
  'build', '--builder', builder, '--platform', inputs.platform, '--progress', 'plain',
  '--tag', image, '--output', `type=docker,dest=${imagePath}`, '--provenance=false',
  '--build-arg', `VERSION=${inputs.version}`, '--build-arg', `COMMIT=${commit}`, '--build-arg', `DATE=${date}`,
  '--build-arg', `PNPM_VERSION=${inputs.pnpmVersion}`,
  '--build-arg', `NODE_BUILD_OPTIONS=${inputs.buildResources.nodeOptions}`,
  '--build-arg', `VITE_BUILD_OPTIONS=${inputs.buildResources.viteNodeOptions || ''}`,
  '--build-arg', `GO_BUILD_PARALLELISM=${inputs.buildResources.goParallelism}`,
  '--build-arg', `GO_BUILD_MEMORY_LIMIT=${inputs.buildResources.goMemoryLimit}`,
  '--build-arg', 'GOPROXY=https://proxy.golang.org,direct', '--build-arg', 'GOSUMDB=sum.golang.org',
  ...Object.entries(inputs.baseImages).flatMap(([key, value]) => ['--build-arg', `${key}=${value}`]),
  '--label', 'org.opencontainers.image.source=https://github.com/wo1fsea/sub2api',
  '--label', `org.opencontainers.image.revision=${commit}`, '--label', `org.opencontainers.image.version=${inputs.version}`,
    '--label', `io.sub2api.upstream.revision=${inputs.upstreamCommit}`, context
  ])
} finally {
  await rm(context, { recursive: true })
}

const archiveManifest = JSON.parse(run('tar', ['-xOf', imagePath, 'manifest.json'], true))
assert.equal(archiveManifest.length, 1)
const imageConfig = run('tar', ['-xOf', imagePath, archiveManifest[0].Config], 'raw')
const config = JSON.parse(imageConfig)
assert.equal(`${config.os}/${config.architecture}`, inputs.platform)
assert.equal(config.config.Labels['org.opencontainers.image.revision'], commit)
const imageConfigDigest = `sha256:${createHash('sha256').update(imageConfig).digest('hex')}`
run('docker', ['load', '--input', imagePath])
const [loaded] = JSON.parse(run('docker', ['image', 'inspect', image], true))
assert.equal(`${loaded.Os}/${loaded.Architecture}`, inputs.platform)
assert.equal(loaded.Config.Labels['org.opencontainers.image.revision'], commit)
assert.equal(loaded.Config.Labels['org.opencontainers.image.version'], inputs.version)
const imageId = loaded.Id

await copyFile(join(root, 'docs/LOCAL_UPGRADE.md'), join(output, 'README.md'))
for (const file of ['smoke.mjs', 'smoke-compose.yaml']) {
  await copyFile(join(root, 'deploy/local-upgrade', file), join(output, file))
}
await copyFile(join(root, 'deploy/local-upgrade/source-validation.json'), join(output, 'source-validation.json'))
await writeFile(join(output, 'manifest.json'), `${JSON.stringify({
  ...inputs, commit, buildDate: date, image, imageId, imageConfigDigest,
  buildCommand: 'node deploy/local-upgrade/build-local.mjs',
  status: 'candidate-not-approved-for-production',
  productionDeploymentPerformed: false,
  sourceValidation: validation,
  releaseGates: ['exact-image smoke and current database restore compatibility',
    'fresh private backup and retained background-role owner',
    'successful real gateway response on the candidate', 'entry activation and real response through original URL',
    'old static assets and healthy rollback instance retained']
}, null, 2)}\n`)
const files = ['image.tar', 'source.tar.gz', 'README.md', 'manifest.json', 'source-validation.json', 'smoke.mjs', 'smoke-compose.yaml']
const checksums = []
for (const file of files) checksums.push(`${await checksum(join(output, file))}  ${file}`)
await writeFile(join(output, 'SHA256SUMS'), `${checksums.join('\n')}\n`)
await rm(buildMarker)
const bundle = join(root, 'release', `${name}.tar.gz`)
run('tar', ['-czf', bundle, '-C', join(root, 'release'), name])
await writeFile(`${bundle}.sha256`, `${await checksum(bundle)}  ${name}.tar.gz\n`)
console.log(JSON.stringify({ bundle, directory: output, image, imageId, commit, productionDeploymentPerformed: false }, null, 2))
