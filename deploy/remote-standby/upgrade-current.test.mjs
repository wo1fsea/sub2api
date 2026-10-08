import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { forwardArgs, readBoundedBody, recordActivationFailure, recordFailedTunnel, recoverActivationFailure, requireProbe, requireResume, requireRetry, retryConnection, remoteProgram, routing, validateRelease } from './upgrade-current.mjs'

const revision = '0123456789ab'
const manifest = { version: '0.2.13', platform: 'linux/amd64', commit: revision + '0'.repeat(28), imageId: 'sha256:' + '1'.repeat(64), imageConfigDigest: 'sha256:' + '2'.repeat(64) }
const path = `/Users/clawbotbot/Projects/sub2api-neubrutalism/release/sub2api_0.2.13_linux_amd64_${revision}/manifest.json`
const asset = '/assets/AccountsView-aBc_1234.js'
test('release rejects another architecture, an incomplete checksum identity, or an unrelated directory', () => {
  assert.equal(validateRelease(manifest, path), revision)
  assert.throws(() => validateRelease({ ...manifest, platform: 'linux/arm64' }, path))
  assert.throws(() => validateRelease({ ...manifest, imageConfigDigest: undefined }, path))
  assert.throws(() => validateRelease(manifest, '/tmp/manifest.json'))
  assert.throws(() => validateRelease({ ...manifest, version: '0.2.14' }, path))
})
test('probe forwards own a foreground SSH connection without the shared control master', () => {
  const args = forwardArgs(49123, 18585)
  for (const option of ['ControlMaster=no', 'ControlPath=none', 'ControlPersist=no', 'ForkAfterAuthentication=no', 'ExitOnForwardFailure=yes']) assert(args.includes(option))
  assert(args.includes('-N'))
  assert(args.includes('127.0.0.1:49123:127.0.0.1:18585'))
  assert.equal(args.at(-1), 'getcodex-prod')
  assert.throws(() => forwardArgs(0, 18585))
  assert.throws(() => forwardArgs(49123, 8080))
})
test('transient SSH handshaking is retried within a budget before any business work runs', async () => {
  let connections = 0, workCalls = 0, closed = 0
  const waits = []
  const result = await retryConnection(async attempt => {
    connections++
    if (attempt < 3) throw new Error('preauth MaxStartups')
    return { base: 'fixture-tunnel', close() { closed++ } }
  }, async base => { workCalls++; assert.equal(base, 'fixture-tunnel'); return 'once' }, { wait: async ms => waits.push(ms) })
  assert.equal(result, 'once'); assert.equal(connections, 3); assert.equal(workCalls, 1); assert.equal(closed, 1)
  assert.deepEqual(waits, [750, 1500])
})
test('model or HTTP work failure is never retried on another SSH connection', async () => {
  let connections = 0, workCalls = 0, closed = 0
  await assert.rejects(retryConnection(async () => { connections++; return { base: 'fixture', close() { closed++ } } },
    async () => { workCalls++; throw new Error('Responses failed') }, { wait: async () => {} }), /Responses failed/)
  assert.equal(connections, 1); assert.equal(workCalls, 1); assert.equal(closed, 1)
})
test('an exhausted SSH connection budget does not invoke a business request', async () => {
  let connections = 0, workCalls = 0
  await assert.rejects(retryConnection(async () => { connections++; throw new Error('preauth closed') },
    async () => { workCalls++ }, { wait: async () => {} }), /preauth closed/)
  assert.equal(connections, 3); assert.equal(workCalls, 0)
})
test('retrying a revision requires completed rollback, cleaned resources and the exact prior image', () => {
  const state = { revision, commit: manifest.commit, image: manifest.imageId, previousImage: 'sha256:' + '0'.repeat(64) }
  const prior = { ...state, phase: 'rolled-back', rollbackGateway: { completed: true, httpStatus: 200, automaticRetries: 0 },
    cleanup: { candidateRemoved: true, candidateVolumeRemoved: true, ownedUploadRemoved: true } }
  requireRetry(prior, state)
  for (const phase of ['active', 'preparing', 'rollback-needs-attention']) assert.throws(() => requireRetry({ ...prior, phase }, state))
  assert.throws(() => requireRetry({ ...prior, previousImage: 'sha256:' + '9'.repeat(64) }, state))
  assert.throws(() => requireRetry({ ...prior, rollbackGateway: { ...prior.rollbackGateway, completed: false } }, state))
  assert.throws(() => requireRetry({ ...prior, cleanup: { ...prior.cleanup, candidateRemoved: false } }, state))
})
test('activation failures record their concrete step and bounded cause in a protected new file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sub2api-activation-failure-test-'))
  try {
    const record = await recordActivationFailure(directory, 'current-proof', new Error('fixture transport failure'))
    assert.equal(record.step, 'current-proof')
    const data = JSON.parse(await readFile(record.diagnostic, 'utf8'))
    assert.equal(data.message, 'fixture transport failure'); assert.equal(data.step, 'current-proof')
    assert.equal((await stat(record.diagnostic)).mode & 0o777, 0o600)
    const second = await recordActivationFailure(directory, 'current-route', new Error('second failure'))
    assert.notEqual(record.diagnostic, second.diagnostic)
  } finally { await rm(directory, { recursive: true }) }
})
test('failed diagnostic and journal writes still restore the previous serving application', async () => {
  const state = { phase: 'rebuilding-current' }, calls = []
  const diskError = Object.assign(new Error('private disk full'), { code: 'ENOSPC' })
  await assert.rejects(recoverActivationFailure('fixture', state, 'current-proof', new Error('activation failed'), {
    record: async () => { calls.push('diagnostic'); throw diskError },
    journal: async () => { calls.push('journal'); throw diskError },
    restore: async () => { calls.push('restore'); state.phase = 'rolled-back' }
  }), /old HK application and routing were restored/)
  assert.deepEqual(calls, ['diagnostic', 'journal', 'restore'])
  assert.equal(state.phase, 'rolled-back'); assert.equal(state.activationFailure.diagnosticSaved, false)
  assert.deepEqual(state.failureMetadataWrites.map(v => v.operation), ['activation-diagnostic', 'activation-journal'])
  assert(state.failureMetadataWrites.every(v => v.code === 'ENOSPC'))
})
test('attention journal write failure cannot hide an unsuccessful rollback', async () => {
  const state = {}, calls = []
  await assert.rejects(recoverActivationFailure('fixture', state, 'current-proof', new Error('activation failed'), {
    record: async () => { throw new Error('diagnostic unavailable') },
    journal: async () => { calls.push('journal'); throw new Error('journal unavailable') },
    restore: async () => { calls.push('restore'); throw new Error('rollback unavailable') }
  }), /automatic rollback needs attention/)
  assert.deepEqual(calls, ['journal', 'restore', 'journal'])
  assert.equal(state.phase, 'rollback-needs-attention')
  assert(state.failureMetadataWrites.some(v => v.operation === 'rollback-attention-journal'))
})
test('failed tunnel diagnostics always terminate the owned SSH child', async () => {
  let kills = 0
  const result = await recordFailedTunnel({ kill(signal) { assert.equal(signal, 'SIGTERM'); kills++ } },
    { exitCode: 255 }, 'fixture-private-path', { write: async () => { throw new Error('private disk full') } })
  assert.equal(result.diagnosticSaved, false); assert.equal(kills, 1)
})
test('prepare resume only accepts the same qualified candidate and fresh complete backup', () => {
  const backup = { oldImageId: 'sha256:' + '0'.repeat(64), oldContainerId: 'original', finished: new Date().toISOString(),
    archives: ['postgres.dump', 'redis.rdb', 'app-data.tar.gz', 'configuration-private.tar.gz'].map(name => ({ name, bytes: 128, sha256: 'a'.repeat(64) })) }
  const state = { phase: 'candidate-started', currentChanged: false, manifestPath: path, revision, image: manifest.imageId,
    commit: manifest.commit, imageConfigDigest: manifest.imageConfigDigest, previousImage: backup.oldImageId, previousId: backup.oldContainerId,
    imageQualification: { imageLoaded: true, imageConfigDigestVerified: true, revisionVerified: true, loadedImageId: manifest.imageId, archiveConfigDigest: manifest.imageConfigDigest },
    candidate: 'fixture-owned', candidateContainer: { image: manifest.imageId, name: 'fixture-owned', healthy: true }, backup }
  requireResume(state, manifest, backup)
  for (const change of [{ phase: 'preparing' }, { phase: 'active' }, { currentChanged: true },
    { image: 'sha256:' + '3'.repeat(64) }, { candidateContainer: { ...state.candidateContainer, healthy: false } },
    { imageQualification: { ...state.imageQualification, loadedImageId: 'sha256:' + '4'.repeat(64) } }]) {
    assert.throws(() => requireResume({ ...state, ...change }, manifest, backup))
  }
  assert.throws(() => requireResume(state, manifest, { ...backup, oldImageId: 'sha256:' + '5'.repeat(64) }))
  assert.throws(() => requireResume(state, manifest, { ...backup, finished: new Date(Date.now() - 31 * 60_000).toISOString() }))
  assert.throws(() => requireResume(state, manifest, { ...backup, archives: backup.archives.slice(1) }))
})
test('old resources only handle exact fingerprinted GET/HEAD paths and never an API route', () => {
  const config = routing('app:8080', revision, [asset])
  assert(config.includes('admin off'))
  assert(config.includes('method GET HEAD'))
  assert(config.includes('path ' + asset))
  assert(config.includes('root * /data/sub2api-release-assets/retained'))
  assert(config.includes('header X-Sub2API-Slot hk-current'))
  assert(config.includes('reverse_proxy app:8080'))
  for (const unsafe of ['/assets/*', '/api/v1/auth/me', '/assets/a/../secret-123456.js', '/assets/plain.js']) {
    assert.throws(() => routing('app:8080', revision, [unsafe]))
  }
  assert.throws(() => routing('unverified:8080', revision, [asset]))
  assert.throws(() => routing('app:8080', revision, []))
})
test('candidate route is unambiguous and distinguishes it from the canonical app', () => {
  const target = `getcodex-sub2api-quota-candidate-${revision}:8080`
  const config = routing(target, revision, [asset])
  assert(config.includes('header X-Sub2API-Slot hk-candidate'))
  assert(config.includes(`header X-Sub2API-Release ${revision}`))
  assert(config.includes(`reverse_proxy ${target}`))
  assert(!config.includes('reverse_proxy app:8080'))
})
const state = { image: manifest.imageId, commit: manifest.commit, preparedAt: new Date(Date.now() - 60_000).toISOString() }
function proof() {
  return { stage: 'candidate', image: state.image, commit: state.commit, checkedAt: new Date().toISOString(),
    existingSession: true, sharedAppearance: true, quotaEndpoint: true, quotaChunk: true,
    gateway: { completed: true, httpStatus: 200, eventTypes: ['response.created', 'response.completed'], automaticRetries: 0 } }
}
test('activation requires fresh real completion and all continuity checks for the exact image', () => {
  requireProbe(proof(), state, 'candidate')
  for (const change of [{ image: 'sha256:' + '3'.repeat(64) }, { stage: 'current' }, { existingSession: false },
    { sharedAppearance: false }, { quotaEndpoint: false }, { quotaChunk: false },
    { checkedAt: new Date(Date.now() - 31 * 60_000).toISOString() }, { checkedAt: new Date(Date.now() + 60_000).toISOString() }]) {
    assert.throws(() => requireProbe({ ...proof(), ...change }, state, 'candidate'))
  }
  for (const change of [{ completed: false }, { httpStatus: 502 }, { eventTypes: ['response.created'] }, { automaticRetries: 1 }]) {
    const p = proof(); p.gateway = { ...p.gateway, ...change }
    assert.throws(() => requireProbe(p, state, 'candidate'))
  }
})
test('the full remote program parses before it can be sent to a server', () => {
  const result = spawnSync('python3', ['-c', 'import ast,sys;ast.parse(sys.stdin.read())'], { input: remoteProgram, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
})
test('asset reads stop at their byte budget before collecting an oversized response', async () => {
  assert.equal((await readBoundedBody(new Response('bounded'), 16)).toString(), 'bounded')
  let cancelled = false
  const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(64)) }, cancel() { cancelled = true } })
  await assert.rejects(readBoundedBody(new Response(body), 16), /byte budget/)
  assert(cancelled)
})

const recoveryFixture = String.raw`
import io,json,subprocess,sys,tempfile,urllib.request
from pathlib import Path
task=json.load(sys.stdin)
with tempfile.TemporaryDirectory(prefix='sub2api-hk-recovery-test-') as td:
    base=Path(td)/'etc'; deploy=Path(td)/'opt'; base.mkdir(); deploy.mkdir()
    revision='0123456789ab'; release=base/'upgrades'/('quota-'+revision); release.mkdir(parents=True)
    image='sha256:'+'1'*64; candidate='getcodex-sub2api-quota-candidate-'+revision; volume=candidate+'-data'
    compose={'services':{'app':{'image':'sha256:'+'0'*64,'environment':{'TOKEN_REFRESH_ENABLED':'false','USAGE_CLEANUP_ENABLED':'false','CHANNEL_MONITOR_V2_DISABLE_AGGREGATOR':'1','ADMIN_EMAIL':'fixture@example.invalid','ADMIN_PASSWORD':'fixture-only'},'networks':['private','egress'],'volumes':['app-data:/app/data']}}}
    (release/'compose-before.json').write_text(json.dumps(compose))
    memory=Path(td)/'meminfo'; memory.write_text('MemAvailable: 1048576 kB\n')
    bridge={'Id':'fixture-candidate','Name':'/'+candidate,'Image':image,'RestartCount':0,'Config':{'Labels':{'io.sub2api.hk-upgrade':revision}},'State':{'Running':True,'StartedAt':'fixture-start','Health':{'Status':'healthy'}}}
    calls=[]; urls=[]
    def fake_run(args,**kwargs):
        calls.append(args)
        if args[:2]==['docker','inspect']:
            if args[2]=='getcodex-sub2api-app': return subprocess.CompletedProcess(args,1,b'',b'canonical replacement failed')
            assert args[2]==candidate; return subprocess.CompletedProcess(args,0,json.dumps([bridge]).encode(),b'')
        if args[:3]==['docker','volume','inspect']:
            assert args[3]==volume; return subprocess.CompletedProcess(args,0,json.dumps([{'Labels':{'io.sub2api.hk-upgrade':revision}}]).encode(),b'')
        assert args[:2]==['docker','compose']; return subprocess.CompletedProcess(args,0,b'',b'')
    subprocess.run=fake_run
    class Response:
        headers={}
        def __init__(self,value): self.value=value
        def __enter__(self): return self
        def __exit__(self,*args): pass
        def read(self,n): return json.dumps({'data':self.value}).encode()
    def urlopen(request,**kwargs):
        url=request.full_url; urls.append(url)
        assert url.startswith('http://127.0.0.1:18585/'),'Recovery attempted a login/read on failed canonical'
        path=url.split(':18585')[1]
        values={'/api/v1/auth/login':{'access_token':'fixture-token'},'/api/v1/settings/public':{'site_appearance':{'theme':'fixture'},'registration_enabled':False},'/api/v1/auth/me':{'role':'admin'},'/api/v1/admin/system/version':{'version':'0.2.13'},'/api/v1/admin/accounts?page=1&page_size=100&lite=1':{'items':[{'id':1,'platform':'openai','type':'oauth'}]},'/api/v1/admin/accounts/usage/batch':{'usage':{'1':{}},'errors':{}}}
        assert path in values; return Response(values[path])
    urllib.request.urlopen=urlopen
    action=task['case']
    args={'action':action,'revision':revision,'image':image,'candidate':candidate,'candidateVolume':volume,'currentChanged':True,'port':18585,'recovery':True}
    program=task['program'].replace("base=Path('/etc/sub2api')",'base=Path('+repr(str(base))+')').replace("deploy=Path('/opt/sub2api')",'deploy=Path('+repr(str(deploy))+')').replace("Path('/proc/meminfo')",'Path('+repr(str(memory))+')')
    sys.stdin=io.StringIO(json.dumps(args)); output=io.StringIO()
    original=sys.stdout; sys.stdout=output
    try: exec(program,{})
    finally: sys.stdout=original
    result=json.loads(output.getvalue())
    assert not any(c[:3]==['docker','inspect','getcodex-sub2api-app'] for c in calls),'Canonical inspect blocked recovery'
    if action=='candidate-start': assert result['healthy'] and result['image']==image
    else: assert result['existingSession'] and result['quotaEndpoint'] and result['unknownQuotaAccounts']==1
    print(json.dumps({'passed':True,'case':action,'canonicalAbsent':True,'calls':len(calls),'candidateRequests':len(urls)}))
`
for (const scenario of ['candidate-start', 'admin-probe']) {
  test(`interrupted replacement recovers through its owned candidate without canonical: ${scenario}`, () => {
    const result = spawnSync('python3', ['-c', recoveryFixture], { input: JSON.stringify({ program: remoteProgram, case: scenario }), encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(JSON.parse(result.stdout).passed, true)
  })
}

const retryArchiveFixture = String.raw`
import io,json,subprocess,sys,tempfile
from pathlib import Path
task=json.load(sys.stdin)
with tempfile.TemporaryDirectory(prefix='sub2api-hk-retry-test-') as td:
    base=Path(td)/'etc'; deploy=Path(td)/'opt'; (deploy/'releases').mkdir(parents=True); base.mkdir()
    revision='0123456789ab'; release=base/'upgrades'/('quota-'+revision); release.mkdir(parents=True)
    image='sha256:'+'1'*64; previous='sha256:'+'0'*64; candidate='getcodex-sub2api-quota-candidate-'+revision; volume=candidate+'-data'
    compose={'services':{'app':{'image':previous,'container_name':'getcodex-sub2api-app','ports':['127.0.0.1:18584:8080'],'environment':{'TOKEN_REFRESH_ENABLED':'false','USAGE_CLEANUP_ENABLED':'false','CHANNEL_MONITOR_V2_DISABLE_AGGREGATOR':'1'}}}}
    state={'phase':'active-standby','continuousSynchronization':False,'image':previous,'commit':'0'*40}
    manifest={'imageId':previous,'commit':'0'*40,'version':'0.2.13'}
    caddy='admin off\ngetcodex.pro {\n reverse_proxy app:8080\n @retired path /api/store/*\n}\n'
    pairs=[(base/'compose-private.json',json.dumps(compose),'compose-before.json'),(base/'state.json',json.dumps(state),'state-before.json'),(deploy/'releases/manifest.json',json.dumps(manifest),'manifest-before.json'),(deploy/'Caddyfile',caddy,'Caddyfile.before')]
    for p,b,name in pairs: p.write_text(b); (release/name).write_text(b)
    proof={'proof':'prior-attempt-must-survive'}; (release/'candidate-verification.json').write_text(json.dumps(proof))
    prior={'phase':'rolled-back','revision':revision,'image':image,'commit':revision+'0'*28,'previousImage':previous,'rollbackGateway':{'completed':True,'httpStatus':200,'automaticRetries':0},'cleanup':{'candidateRemoved':True,'candidateVolumeRemoved':True,'ownedUploadRemoved':True}}
    (release/'state.json').write_text(json.dumps(prior))
    case=task['case']
    if case=='drift': (base/'compose-private.json').write_text(json.dumps(compose)+' ')
    if case=='unconfirmed': prior['phase']='rollback-needs-attention'; (release/'state.json').write_text(json.dumps(prior))
    healthy={'Running':True,'StartedAt':'fixture','Health':{'Status':'healthy'}}
    app={'Id':'new-old-container','Image':previous,'Config':{'Labels':{'com.docker.compose.project':'getcodex-sub2api'}},'State':healthy}
    caddycontainer={'Id':'same-ingress','Path':'caddy','Args':['run','--config','/etc/caddy/Caddyfile','--adapter','caddyfile'],'State':healthy}
    def fake_run(args,**kwargs):
        if args[:2]==['docker','inspect']:
            if args[2]=='getcodex-sub2api-app': result=app
            elif args[2]=='getcodex-sub2api-caddy': result=caddycontainer
            else: result={'State':healthy}
            output=json.dumps([result]).encode()
        elif args[:3]==['docker','exec','same-ingress']: output=b'v2.11.4 fixture'
        elif args[:2]==['systemctl','is-enabled']: output=b'enabled'
        elif args[:2]==['systemctl','is-active']: output=b'active'
        elif args[:2]==['systemctl','cat']: output=b'/etc/sub2api/compose-private.json'
        elif args[:2]==['docker','ps']: output=(candidate if case=='candidate-remains' else '').encode()
        elif args[:3]==['docker','volume','ls']: output=b''
        else: raise AssertionError(args)
        return subprocess.CompletedProcess(args,0,output,b'')
    subprocess.run=fake_run
    args={'action':'init','revision':revision,'image':image,'commit':revision+'0'*28,'previousImage':previous,'previousId':app['Id'],'candidate':candidate,'candidateVolume':volume}
    program=task['program'].replace("base=Path('/etc/sub2api')",'base=Path('+repr(str(base))+')').replace("deploy=Path('/opt/sub2api')",'deploy=Path('+repr(str(deploy))+')')
    sys.stdin=io.StringIO(json.dumps(args)); output=io.StringIO(); original=sys.stdout; sys.stdout=output
    failure=None
    try: exec(program,{})
    except AssertionError as error: failure=error
    finally: sys.stdout=original
    archives=list(release.parent.glob('quota-'+revision+'-rolled-back-*'))
    if case=='safe':
        assert failure is None and len(archives)==1
        assert json.loads((archives[0]/'candidate-verification.json').read_text())==proof
        assert json.loads((archives[0]/'state.json').read_text())==prior
        assert not (release/'state.json').exists() and (release/'compose-before.json').exists()
        assert json.loads(output.getvalue())['archivedPriorAttempt']==str(archives[0])
    else:
        assert failure is not None and not archives
        assert json.loads((release/'state.json').read_text())==prior
    print(json.dumps({'passed':True,'case':case,'archiveCount':len(archives)}))
`
for (const scenario of ['safe', 'drift', 'unconfirmed', 'candidate-remains']) {
  test(`new attempt preserves the prior journal and rejects unsafe archive state: ${scenario}`, () => {
    const result = spawnSync('python3', ['-c', retryArchiveFixture], { input: JSON.stringify({ program: remoteProgram, case: scenario }), encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(JSON.parse(result.stdout).passed, true)
  })
}
