import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { forwardArgs, readBoundedBody, requireProbe, requireResume, remoteProgram, routing, validateRelease } from './upgrade-current.mjs'

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
