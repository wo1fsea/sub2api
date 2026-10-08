import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { createReadStream, createWriteStream, writeFileSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { liveGateway } from '../local-upgrade/live-gateway.mjs'

// This upgrades the existing HK standby. It never replays initial provisioning,
// restores a database, changes proxy assignments, or promotes HK to primary.
const host = 'getcodex-prod'
const privateRoot = '/Users/clawbotbot/Projects/sub2api-upgrade-private'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const sshOptions = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=3']
const digest = value => createHash('sha256').update(value).digest('hex')
const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'"
const now = () => new Date().toISOString()
const assetPattern = /^\/assets\/[a-zA-Z0-9_.\/-]+-[a-zA-Z0-9_-]{6,}\.(?:js|css)$/
const maxAssetBytes = 96 << 20
const activationSteps = new Set(['candidate-proof', 'candidate-route', 'candidate-public-proof', 'retained-assets-before-current',
  'rebuild-current', 'current-proof', 'current-route', 'current-public-proof', 'retained-assets-after-current', 'persist-current', 'cleanup-candidate'])

export function validateRelease(manifest, manifestPath) {
  assert.equal(manifest.version, '0.2.13', 'This same-schema upgrade is qualified for 0.2.13 only')
  assert.equal(manifest.platform, 'linux/amd64')
  assert.match(manifest.commit, /^[a-f0-9]{40}$/)
  for (const key of ['imageId', 'imageConfigDigest']) assert.match(manifest[key], /^sha256:[a-f0-9]{64}$/)
  assert.equal(resolve(manifestPath), join(root, 'release', `sub2api_${manifest.version}_linux_amd64_${manifest.commit.slice(0, 12)}`, 'manifest.json'))
  return manifest.commit.slice(0, 12)
}

export function routing(target, revision, assets) {
  assert.match(revision, /^[a-f0-9]{12}$/)
  assert(['app:8080', `getcodex-sub2api-quota-candidate-${revision}:8080`].includes(target))
  assert(assets.length > 0 && assets.length <= 2000)
  assert(assets.every(path => assetPattern.test(path) && !path.includes('..')))
  const slot = target === 'app:8080' ? 'hk-current' : 'hk-candidate'
  return `{\n admin off\n log {\n  exclude http.log.error\n }\n}\nwww.getcodex.pro {\n redir https://getcodex.pro{uri} permanent\n}\ngetcodex.pro {\n header Strict-Transport-Security "max-age=31536000"\n encode zstd gzip\n request_body {\n  max_size 256MB\n }\n @retired path /ops /ops/* /api/store/* /api/payments/zpay/* /api/worker/*\n handle @retired {\n  respond "The former sales service has been retired." 410\n }\n @retained {\n  method GET HEAD\n  path ${[...new Set(assets)].sort().join(' ')}\n }\n handle @retained {\n  root * /data/sub2api-release-assets/retained\n  header Cache-Control "public, max-age=31536000, immutable"\n  header X-Sub2API-Slot hk-retained-assets\n  file_server\n }\n handle {\n  header X-Sub2API-Slot ${slot}\n  header X-Sub2API-Release ${revision}\n  reverse_proxy ${target} {\n   flush_interval -1\n   header_up X-Forwarded-For {remote_host}\n   header_up X-Forwarded-Proto {scheme}\n   transport http {\n    dial_timeout 5s\n    response_header_timeout 120s\n   }\n  }\n }\n}\n`
}

export function requireProbe(report, state, stage) {
  assert.equal(report.stage, stage)
  assert.equal(report.image, state.image)
  assert.equal(report.commit, state.commit)
  assert(Number.isFinite(Date.parse(report.checkedAt)) && Date.parse(report.checkedAt) >= Date.parse(state.preparedAt))
  assert(Date.now() - Date.parse(report.checkedAt) < 30 * 60_000 && Date.parse(report.checkedAt) <= Date.now() + 5000)
  for (const key of ['existingSession', 'sharedAppearance', 'quotaEndpoint', 'quotaChunk']) assert.equal(report[key], true)
  assert.equal(report.gateway.completed, true)
  assert.equal(report.gateway.httpStatus, 200)
  assert(report.gateway.eventTypes.includes('response.completed') || report.gateway.eventTypes.includes('response.done'))
  assert.equal(report.gateway.automaticRetries, 0)
}

export function forwardArgs(localPort, remotePort) {
  assert(Number.isInteger(localPort) && localPort > 1023 && localPort <= 65535)
  assert([18584, 18585].includes(remotePort))
  // A mux client can successfully create a forward and exit immediately.
  // Own an independent foreground connection so its lifetime is meaningful.
  return [...sshOptions, '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'ControlPersist=no',
    '-o', 'ForkAfterAuthentication=no', '-o', 'ExitOnForwardFailure=yes', '-N',
    '-L', `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`, host]
}

export function requireResume(state, manifest, backupReport, time = Date.now()) {
  assert.equal(state.phase, 'candidate-started')
  assert.equal(state.currentChanged, false)
  assert.equal(validateRelease(manifest, state.manifestPath), state.revision)
  for (const [key, expected] of [['imageId', state.image], ['commit', state.commit], ['imageConfigDigest', state.imageConfigDigest]]) assert.equal(manifest[key], expected)
  for (const key of ['imageLoaded', 'imageConfigDigestVerified', 'revisionVerified']) assert.equal(state.imageQualification[key], true)
  assert.equal(state.imageQualification.loadedImageId, state.image)
  assert.equal(state.imageQualification.archiveConfigDigest, state.imageConfigDigest)
  assert.equal(state.candidateContainer.image, state.image)
  assert.equal(state.candidateContainer.name, state.candidate)
  assert.equal(state.candidateContainer.healthy, true)
  assert.equal(backupReport.oldImageId, state.previousImage)
  assert.equal(backupReport.oldContainerId, state.previousId)
  const finished = Date.parse(backupReport.finished)
  assert(Number.isFinite(finished) && finished <= time + 5000 && time - finished < 30 * 60_000, 'Resume requires a fresh protected HK backup')
  assert.deepEqual(backupReport.archives, state.backup.archives)
  assert.deepEqual(backupReport.archives.map(v => v.name).sort(), ['app-data.tar.gz', 'configuration-private.tar.gz', 'postgres.dump', 'redis.rdb'])
  for (const file of backupReport.archives) {
    assert.match(file.sha256, /^[a-f0-9]{64}$/)
    assert(Number.isInteger(file.bytes) && file.bytes > 0)
  }
}

export function requireRetry(record, state) {
  assert.equal(record.phase, 'rolled-back', 'Only a completed verified rollback can be archived for another attempt')
  for (const key of ['revision', 'commit', 'image', 'previousImage']) assert.equal(record[key], state[key])
  assert.equal(record.rollbackGateway.completed, true)
  assert.equal(record.rollbackGateway.httpStatus, 200)
  assert.equal(record.rollbackGateway.automaticRetries, 0)
  for (const key of ['candidateRemoved', 'candidateVolumeRemoved', 'ownedUploadRemoved']) assert.equal(record.cleanup[key], true)
}

export async function retryConnection(connect, work, { attempts = 3, wait = delay } = {}) {
  assert(Number.isInteger(attempts) && attempts >= 1 && attempts <= 3)
  let connection, last
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try { connection = await connect(attempt); break } catch (error) {
      last = error
      if (attempt < attempts) await wait(attempt * 750)
    }
  }
  if (!connection) throw last
  // After handshaking succeeds, HTTP/model work runs exactly once. A failure
  // here cannot be retried as another billable or business request.
  try { return await work(connection.base) } finally { await connection.close() }
}

export async function recordActivationFailure(directory, step, error) {
  assert(activationSteps.has(step))
  const record = { at: now(), step, name: String(error?.name || 'Error').slice(0, 128),
    message: String(error?.message || error).slice(0, 16384), stack: String(error?.stack || '').slice(-16384) }
  const path = join(directory, `activation-failure-${randomBytes(6).toString('hex')}.json`)
  await writeFile(path, JSON.stringify(record, null, 2), { flag: 'wx', mode: 0o600 })
  return { at: record.at, step, diagnostic: path }
}

function metadataFailure(state, operation, error) {
  state.failureMetadataWrites ||= []
  state.failureMetadataWrites.push({ operation, name: String(error?.name || 'Error').slice(0, 64),
    code: String(error?.code || 'unavailable').slice(0, 64) })
}

export async function recoverActivationFailure(directory, state, step, error, {
  record = recordActivationFailure, journal = save, restore = rollback
} = {}) {
  state.activationFailedAt = now()
  state.activationFailure = { at: state.activationFailedAt, step, diagnosticSaved: false }
  try {
    state.activationFailure = { ...await record(directory, step, error), diagnosticSaved: true }
  } catch (failure) { metadataFailure(state, 'activation-diagnostic', failure) }
  try { await journal(directory, state) } catch (failure) { metadataFailure(state, 'activation-journal', failure) }
  // Diagnostics never gate restoration of a previously working service.
  try { await restore(directory, state) } catch {
    state.phase = 'rollback-needs-attention'
    try { await journal(directory, state) } catch (failure) { metadataFailure(state, 'rollback-attention-journal', failure) }
    throw new Error('Activation failed and automatic rollback needs attention; the verified candidate and protected backup are retained')
  }
  throw new Error('Activation failed; old HK application and routing were restored and verified')
}

export async function recordFailedTunnel(child, record, diagnostic, { write = writeFile } = {}) {
  try {
    await write(diagnostic, JSON.stringify(record), { flag: 'wx', mode: 0o600 })
    return { diagnosticSaved: true }
  } catch {
    return { diagnosticSaved: false }
  } finally {
    child.kill('SIGTERM')
  }
}

// Everything involving private Compose values and administrator credentials
// remains inside a root-only Python process on HK. Only allowlisted results
// cross SSH. Docker stderr is never printed, including failure paths.
export const remoteProgram = String.raw`
import copy, hashlib, json, math, os, re, shutil, subprocess, sys, tarfile, time, urllib.request
from datetime import datetime, timezone
from pathlib import Path
a=json.load(sys.stdin)
action=a['action']
revision=a.get('revision','')
assert not revision or re.fullmatch(r'[a-f0-9]{12}',revision)
base=Path('/etc/sub2api')
deploy=Path('/opt/sub2api')
release=base/'upgrades'/('quota-'+revision)
dc=['docker','compose','-p','getcodex-sub2api','--env-file','/dev/null','-f',str(base/'compose-private.json')]
def run(args, timeout=150, data=None):
    p=subprocess.run(args,input=data,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=timeout)
    assert p.returncode==0,'Remote operation failed; sensitive diagnostics suppressed'
    return p.stdout
def read(p): return json.loads(Path(p).read_text())
def write(p,v):
    p=Path(p); temporary=p.with_name(p.name+'.pending')
    fd=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
    with os.fdopen(fd,'w') as f: json.dump(v,f,indent=2); f.flush(); os.fsync(f.fileno())
    os.chmod(temporary,0o600); os.replace(temporary,p)
def inspect(name): return json.loads(run(['docker','inspect',name]))[0]
def healthy(name,image=None):
    c=inspect(name)
    assert c['State']['Running'] and c['State'].get('Health',{}).get('Status')=='healthy','Application is not healthy'
    if image: assert c['Image']==image,'Application image mismatch'
    return c
def flags(s):
    e=s['environment']
    assert e.get('TOKEN_REFRESH_ENABLED')=='false'
    assert e.get('USAGE_CLEANUP_ENABLED')=='false'
    assert e.get('CHANNEL_MONITOR_V2_DISABLE_AGGREGATOR')=='1'
def summary(c):
    return {'id':c['Id'],'name':c['Name'].lstrip('/'),'image':c['Image'],'startedAt':c['State']['StartedAt'],'restartCount':c['RestartCount'],'healthy':c['State'].get('Health',{}).get('Status')=='healthy','running':c['State']['Running']}
def request(url,data=None,headers=None,timeout=45):
    q=urllib.request.Request(url,data=json.dumps(data).encode() if data is not None else None,headers={'Content-Type':'application/json',**(headers or {})})
    with urllib.request.urlopen(q,timeout=timeout) as r:
        b=r.read(8*1024*1024+1); assert len(b)<=8*1024*1024
        return json.loads(b),dict(r.headers)
def caddy_check():
    c=inspect('getcodex-sub2api-caddy')
    assert c['State']['Running']
    assert c['Path']=='caddy' and c['Args']==['run','--config','/etc/caddy/Caddyfile','--adapter','caddyfile']
    assert run(['docker','exec',c['Id'],'caddy','version']).decode().startswith('v2.11.4 '),'Requalify SIGUSR1 for another Caddy version'
    return c
def active_state(): return read(base/'state.json')
def initial():
    compose=read(base/'compose-private.json'); app=healthy('getcodex-sub2api-app'); caddy=caddy_check()
    flags(compose['services']['app'])
    assert compose['services']['app']['image']==app['Image']
    assert compose['services']['app']['container_name']=='getcodex-sub2api-app'
    assert compose['services']['app']['ports']==['127.0.0.1:18584:8080']
    assert app['Config']['Labels']['com.docker.compose.project']=='getcodex-sub2api'
    state=active_state(); manifest=read(deploy/'releases/manifest.json')
    assert state['phase']=='active-standby' and state['continuousSynchronization'] is False
    assert state['image']==app['Image']==manifest['imageId']
    assert state['commit']==manifest['commit']
    assert run(['systemctl','is-enabled','getcodex-sub2api.service']).strip()==b'enabled'
    assert run(['systemctl','is-active','getcodex-sub2api.service']).strip()==b'active'
    assert b'/etc/sub2api/compose-private.json' in run(['systemctl','cat','getcodex-sub2api.service'])
    text=(deploy/'Caddyfile').read_text()
    assert 'admin off' in text and 'reverse_proxy app:8080' in text
    assert '/api/store/*' in text and 'getcodex.pro {' in text
    for name in ['getcodex-sub2api-postgres','getcodex-sub2api-redis']: healthy(name)
    return compose,app,caddy,state,manifest
def candidate_config():
    compose=read(release/'compose-before.json')
    s=copy.deepcopy(compose['services']['app']); s['image']=a['image']; s['container_name']=a['candidate']
    s['ports']=['127.0.0.1:18585:8080']; s['volumes']=[a['candidateVolume']+':/app/data']; s.pop('depends_on',None)
    s['labels']={**s.get('labels',{}),'io.sub2api.hk-upgrade':revision}
    s['networks']=['private','egress']; flags(s)
    conf={'services':{'candidate':s},'networks':{n:{'external':True,'name':'getcodex-sub2api_'+n} for n in ['private','egress']},'volumes':{a['candidateVolume']:{'external':True,'name':a['candidateVolume']}}}
    write(release/'candidate-compose.json',conf)
    return conf
def candidate_start():
    conf=candidate_config(); volume=a['candidateVolume']
    available=int(next(v.split()[1] for v in Path('/proc/meminfo').read_text().splitlines() if v.startswith('MemAvailable:')))*1024
    present=subprocess.run(['docker','inspect',a['candidate']],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    if present.returncode==0:
        c=json.loads(present.stdout)[0]; assert c['Config']['Labels'].get('io.sub2api.hk-upgrade')==revision and c['Image']==a['image']
    if present.returncode or not json.loads(present.stdout)[0]['State']['Running']:
        assert available>=896*1024*1024,'HK memory headroom is insufficient for a safe candidate'
    existing=subprocess.run(['docker','volume','inspect',volume],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    if existing.returncode:
        # A surviving owned candidate/volume is the recovery bridge when the
        # canonical replacement crashed. Inspect canonical only when cloning.
        old=inspect('getcodex-sub2api-app')
        run(['docker','volume','create','--label','io.sub2api.hk-upgrade='+revision,volume])
        source=next(m['Name'] for m in old['Mounts'] if m['Type']=='volume' and m['Destination']=='/app/data')
        run(['docker','run','--rm','--network','none','--memory','64m','--log-driver','none','--entrypoint','sh','-v',source+':/source:ro','-v',volume+':/target',a['image'],'-ec','cp -a /source/. /target/; chown -R 1000:1000 /target'])
    else:
        meta=json.loads(existing.stdout)[0]; assert meta.get('Labels',{}).get('io.sub2api.hk-upgrade')==revision
    run(['docker','compose','-p','getcodex-quota-'+revision,'--env-file','/dev/null','-f',str(release/'candidate-compose.json'),'up','-d','--wait','--wait-timeout','120'])
    c=healthy(a['candidate'],a['image']); assert c['Config']['Labels']['io.sub2api.hk-upgrade']==revision
    return summary(c)
def cleanup():
    p=subprocess.run(['docker','inspect',a['candidate']],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    if p.returncode==0:
        c=json.loads(p.stdout)[0]; assert c['Config']['Labels'].get('io.sub2api.hk-upgrade')==revision and c['Image']==a['image']
        run(['docker','rm','--force',c['Id']])
    p=subprocess.run(['docker','volume','inspect',a['candidateVolume']],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    if p.returncode==0:
        v=json.loads(p.stdout)[0]; assert v.get('Labels',{}).get('io.sub2api.hk-upgrade')==revision
        run(['docker','volume','rm',a['candidateVolume']])
    (release/'session-private.json').unlink(missing_ok=True)
    return {'candidateRemoved':True,'candidateVolumeRemoved':True,'previousImageRetained':True}
if action=='lock':
    p=base/'upgrade-operation.lock'; p.mkdir(mode=0o700)
    write(p/'owner.json',{'token':a['token'],'startedAt':a['startedAt']})
    result={'locked':True}
elif action=='unlock':
    p=base/'upgrade-operation.lock'; assert read(p/'owner.json')['token']==a['token']
    (p/'owner.json').unlink(); p.rmdir(); result={'unlocked':True}
elif action=='inventory':
    compose,app,caddy,state,manifest=initial()
    prior=read(release/'state.json') if revision and (release/'state.json').exists() else None
    result={'app':summary(app),'caddy':summary(caddy),'previousCommit':state['commit'],'version':manifest['version'],'bootId':Path('/proc/sys/kernel/random/boot_id').read_text().strip(),'retainedAssets':read(deploy/'releases/retained-assets.json') if (deploy/'releases/retained-assets.json').exists() else {},'priorAttempt':prior}
elif action=='init':
    compose,app,caddy,state,manifest=initial(); assert app['Id']==a['previousId'] and app['Image']==a['previousImage']
    release.parent.mkdir(mode=0o700,exist_ok=True)
    archived=None
    if release.exists():
        assert release.is_dir() and not release.is_symlink()
        prior=read(release/'state.json')
        assert prior['phase']=='rolled-back' and prior['revision']==revision and prior['image']==a['image'] and prior['commit']==a['commit']
        assert prior['previousImage']==app['Image']
        assert prior.get('rollbackGateway',{}).get('completed') is True and prior['rollbackGateway']['httpStatus']==200 and prior['rollbackGateway']['automaticRetries']==0
        assert all(prior.get('cleanup',{}).get(k) is True for k in ['candidateRemoved','candidateVolumeRemoved','ownedUploadRemoved'])
        for source,name in [(base/'compose-private.json','compose-before.json'),(base/'state.json','state-before.json'),(deploy/'Caddyfile','Caddyfile.before'),(deploy/'releases/manifest.json','manifest-before.json')]:
            assert source.read_bytes()==(release/name).read_bytes(),'A rolled-back deployment drifted from its saved originals'
        assert read(release/'state-before.json')['image']==app['Image']
        retained=deploy/'releases/retained-assets.json'; saved=release/'retained-assets-before.json'
        assert retained.exists()==saved.exists()
        if retained.exists(): assert retained.read_bytes()==saved.read_bytes()
        names=run(['docker','ps','-a','--format','{{.Names}}']).decode().splitlines(); assert a['candidate'] not in names
        volumes=run(['docker','volume','ls','--format','{{.Name}}']).decode().splitlines(); assert a['candidateVolume'] not in volumes
        refs=run(['docker','ps','-a','--filter','label=io.sub2api.hk-upgrade='+revision,'--format','{{.Names}}']).strip(); assert not refs,'A prior candidate remains referenced'
        # Keep the immutable image and every before-config/proof intact. Rename
        # only this validated release journal; previous local backup remains.
        if re.search(r'(?<![a-zA-Z0-9-])'+re.escape(a['candidate'])+r':8080',(deploy/'Caddyfile').read_text()): raise ValueError('Old candidate is still routed')
        archive=release.parent/('quota-'+revision+'-rolled-back-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S')+'-'+os.urandom(3).hex())
        assert not archive.exists(); os.rename(release,archive); archived=str(archive)
    release.mkdir(mode=0o700)
    for source,name in [(base/'compose-private.json','compose-before.json'),(base/'state.json','state-before.json'),(deploy/'Caddyfile','Caddyfile.before'),(deploy/'releases/manifest.json','manifest-before.json')]:
        shutil.copyfile(source,release/name); os.chmod(release/name,0o600)
    if (deploy/'releases/retained-assets.json').exists(): shutil.copyfile(deploy/'releases/retained-assets.json',release/'retained-assets-before.json')
    result={'savedOriginals':True,'archivedPriorAttempt':archived}
elif action=='stage':
    upload=Path(a['upload']); assert re.fullmatch(r'/home/ubuntu/sub2api-upgrade-[a-f0-9]{12}',str(upload))
    image=upload/'image.tar'; mf=upload/'manifest.json'
    def hashfile(p):
        h=hashlib.sha256()
        with Path(p).open('rb') as f:
            for chunk in iter(lambda:f.read(1024*1024),b''): h.update(chunk)
        return h.hexdigest()
    assert hashfile(image)==a['imageTarSha256'] and hashfile(mf)==a['manifestSha256']
    m=read(mf); assert m['commit']==a['commit'] and m['imageId']==a['image'] and m['platform']=='linux/amd64'
    with tarfile.open(image,'r:') as t:
        metadata=json.load(t.extractfile('manifest.json')); assert len(metadata)==1
        b=t.extractfile(metadata[0]['Config']).read(4*1024*1024+1); assert len(b)<=4*1024*1024
        assert 'sha256:'+hashlib.sha256(b).hexdigest()==m['imageConfigDigest']
        config=json.loads(b); assert config['os']=='linux' and config['architecture']=='amd64'
        assert config['config']['Labels']['org.opencontainers.image.revision']==m['commit']
    out=deploy/'releases'/('upgrade-'+revision); out.mkdir(mode=0o700,exist_ok=True)
    if (out/'manifest.json').exists(): assert hashfile(out/'manifest.json')==a['manifestSha256'],'Immutable manifest changed between attempts'
    else: shutil.copyfile(mf,out/'manifest.json'); os.chmod(out/'manifest.json',0o600)
    run(['docker','load','-i',str(image)],timeout=240)
    c=json.loads(run(['docker','image','inspect',m['imageId']]))[0]
    assert c['Id']==m['imageId'],'Engine returned another image identity; explicit requalification is required'
    assert c['Os']=='linux' and c['Architecture']=='amd64'
    assert c['Config']['Labels']['org.opencontainers.image.revision']==m['commit'] and c['Config']['Labels']['org.opencontainers.image.version']==m['version']
    # The transferred immutable archive is recoverable locally; avoid an extra HK copy.
    image.unlink(); mf.unlink()
    result={'imageLoaded':True,'imageConfigDigestVerified':True,'revisionVerified':True,'loadedImageId':c['Id'],'archiveConfigDigest':m['imageConfigDigest']}
elif action=='assets':
    c=caddy_check(); source=Path(a['upload'])/'assets'
    data=next(m['Source'] for m in c['Mounts'] if m['Destination']=='/data' and m['Type']=='volume')
    destination=Path(data)/'sub2api-release-assets'/'retained'; destination.mkdir(parents=True,mode=0o755,exist_ok=True)
    assert not destination.is_symlink()
    for path,meta in a['newAssets'].items():
        assert re.fullmatch(r'/assets/[a-zA-Z0-9_.\/-]+-[a-zA-Z0-9_-]{6,}\.(js|css)',path) and '..' not in path
        p=source/path.lstrip('/'); b=p.read_bytes(); assert len(b)==meta['bytes'] and hashlib.sha256(b).hexdigest()==meta['sha256']
        dest=destination/path.lstrip('/'); dest.parent.mkdir(parents=True,mode=0o755,exist_ok=True)
        assert not dest.is_symlink()
        if dest.exists(): assert hashlib.sha256(dest.read_bytes()).hexdigest()==meta['sha256'],'Hashed asset URL collision'
        else: dest.write_bytes(b); os.chmod(dest,0o644)
    assert sum(v['bytes'] for v in a['assets'].values())<96*1024*1024
    for path,meta in a['assets'].items():
        p=destination/path.lstrip('/'); assert p.is_file() and not p.is_symlink() and hashlib.sha256(p.read_bytes()).hexdigest()==meta['sha256']
    write(release/'retained-assets-next.json',a['assets']); result={'assetsCached':len(a['assets'])}
elif action=='candidate-start': result=candidate_start()
elif action=='resume-check':
    compose,old,caddy,state,manifest=initial()
    assert old['Id']==a['previousId'] and old['Image']==a['previousImage']
    assert caddy['Id']==a['caddyId'] and caddy['State']['StartedAt']==a['caddyStartedAt']
    assert compose==read(release/'compose-before.json')
    assert (deploy/'Caddyfile').read_bytes()==(release/'Caddyfile.before').read_bytes(),'Serving config changed before resume'
    mpath=deploy/'releases'/('upgrade-'+revision)/'manifest.json'
    assert hashlib.sha256(mpath.read_bytes()).hexdigest()==a['manifestSha256']
    m=read(mpath); assert m['imageId']==a['image'] and m['commit']==a['commit'] and m['imageConfigDigest']==a['imageConfigDigest']
    c=healthy(a['candidate'],a['image'])
    assert c['Config']['Labels'].get('io.sub2api.hk-upgrade')==revision
    assert any(v['Type']=='volume' and v['Name']==a['candidateVolume'] and v['Destination']=='/app/data' for v in c['Mounts'])
    v=json.loads(run(['docker','volume','inspect',a['candidateVolume']]))[0]; assert v.get('Labels',{}).get('io.sub2api.hk-upgrade')==revision
    image=json.loads(run(['docker','image','inspect',a['image']]))[0]
    assert image['Id']==a['image'] and image['Architecture']=='amd64' and image['Os']=='linux'
    assert image['Config']['Labels']['org.opencontainers.image.revision']==a['commit']
    cached=read(release/'retained-assets-next.json'); assert cached==a['assets'] and len(cached)>0
    data=next(v['Source'] for v in caddy['Mounts'] if v['Type']=='volume' and v['Destination']=='/data')
    cache=Path(data)/'sub2api-release-assets'/'retained'
    for path,meta in cached.items():
        assert re.fullmatch(r'/assets/[a-zA-Z0-9_.\/-]+-[a-zA-Z0-9_-]{6,}\.(js|css)',path) and '..' not in path
        p=cache/path.lstrip('/'); assert p.is_file() and not p.is_symlink() and p.stat().st_size==meta['bytes']
        assert hashlib.sha256(p.read_bytes()).hexdigest()==meta['sha256']
    result={'previousStillHealthy':True,'ownedCandidateReady':True,'exactImageVerified':True,'retainedAssetsVerified':len(cached),'originalConfigUnchanged':True,'originalConfig':(release/'Caddyfile.before').read_text()}
elif action=='admin-probe':
    assert a['port'] in [18584,18585]; url='http://127.0.0.1:'+str(a['port'])
    healthy(a['candidate'] if a['port']==18585 else 'getcodex-sub2api-app',a['image'])
    p=release/'session-private.json'
    if not p.exists():
        e=read(release/'compose-before.json')['services']['app']['environment']
        loginbase=url if a.get('recovery') else 'http://127.0.0.1:18584'
        login,_=request(loginbase+'/api/v1/auth/login',{'email':e['ADMIN_EMAIL'],'password':e['ADMIN_PASSWORD']})
        token=login['data']['access_token']; before,_=request(loginbase+'/api/v1/settings/public')
        write(p,{'token':token,'appearance':before['data']['site_appearance']})
    session=read(p); headers={'Authorization':'Bearer '+session['token']}
    me,_=request(url+'/api/v1/auth/me',headers=headers); assert me['data']['role']=='admin'
    version,_=request(url+'/api/v1/admin/system/version',headers=headers); assert version['data']['version']=='0.2.13'
    settings,_=request(url+'/api/v1/settings/public'); assert settings['data']['site_appearance']==session['appearance']
    assert settings['data']['registration_enabled'] is False
    accounts,_=request(url+'/api/v1/admin/accounts?page=1&page_size=100&lite=1',headers=headers)
    selected=[v['id'] for v in accounts['data']['items'] if v['platform']=='openai' and v['type']=='oauth'][:2]
    assert selected,'Expected existing OpenAI subscription accounts'
    usage,_=request(url+'/api/v1/admin/accounts/usage/batch',{'account_ids':selected,'force':False},headers)
    assert isinstance(usage['data'].get('usage'),dict) and isinstance(usage['data'].get('errors'),dict)
    windows=0; unknown=0
    for id in selected:
        value=usage['data']['usage'].get(str(id)); error=usage['data']['errors'].get(str(id))
        assert isinstance(value,dict) or isinstance(error,str),'Quota batch omitted a requested account'
        if value is None: unknown+=1; continue
        readings=value.get('quota_windows',[]); assert isinstance(readings,list)
        if not readings: unknown+=1
        for w in readings:
            assert isinstance(w,dict) and isinstance(w.get('key'),str) and w['key']
            assert w.get('scope') in ['account','model']
            assert w.get('source') in ['upstream','response_headers','estimated','local','unknown']
            u=w.get('utilization'); assert u is None or (type(u) in (float,int) and math.isfinite(u) and u>=0)
            for field in ['resets_at','sampled_at']:
                if w.get(field) is not None: datetime.fromisoformat(w[field].replace('Z','+00:00'))
            windows+=1
    result={'existingSession':True,'sharedAppearance':True,'quotaEndpoint':True,'quotaWindows':windows,'unknownQuotaAccounts':unknown,'registrationDisabled':True}
elif action=='reload':
    c=caddy_check(); assert c['Id']==a['caddyId'] and c['State']['StartedAt']==a['caddyStartedAt']
    text=a['config']; assert 'admin off' in text and len(text)<128*1024
    temporary=release/'Caddyfile.next'; temporary.write_text(text); os.chmod(temporary,0o600)
    inside='/tmp/sub2api-upgrade-'+revision+'.Caddyfile'
    run(['docker','cp',str(temporary),c['Id']+':'+inside])
    run(['docker','exec',c['Id'],'caddy','validate','--config',inside,'--adapter','caddyfile'])
    current=deploy/'Caddyfile'; inode=current.stat().st_ino
    with current.open('r+b') as f: f.seek(0); f.write(text.encode()); f.truncate(); f.flush(); os.fsync(f.fileno())
    assert current.stat().st_ino==inode
    stamp=datetime.now(timezone.utc).isoformat(); run(['docker','kill','--signal=USR1',c['Id']])
    deadline=time.monotonic()+45; successful=False
    while time.monotonic()<deadline:
        p=subprocess.run(['docker','logs','--since',stamp,c['Id']],stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=10)
        logs=p.stdout+p.stderr
        if b'successfully reloaded config from file' in logs: successful=True; break
        if b'failed to reload config from file' in logs: break
        time.sleep(.25)
    assert successful,'SIGUSR1 reload was not confirmed'
    after=inspect(c['Id']); assert after['State']['StartedAt']==c['State']['StartedAt'] and after['RestartCount']==c['RestartCount']
    result={'gracefulReloadConfirmed':True,'caddyNotRestarted':True,'configInodePreserved':True}
elif action=='update-current':
    conf=read(base/'compose-private.json'); assert conf['services']['app']['image'] in [a['previousImage'],a['image']]
    conf['services']['app']['image']=a['image']; flags(conf['services']['app']); write(base/'compose-private.json',conf)
    run(dc+['up','-d','--no-deps','--wait','--wait-timeout','120','app'])
    result=summary(healthy('getcodex-sub2api-app',a['image']))
elif action=='persist':
    c=healthy('getcodex-sub2api-app',a['image']); flags(read(base/'compose-private.json')['services']['app'])
    state=read(release/'state-before.json'); state.update({'image':a['image'],'commit':a['commit'],'manifestPath':str(deploy/'releases'/('upgrade-'+revision)/'manifest.json'),'quotaUpgradeAt':a['checkedAt'],'quotaUpgradeDirectory':str(release),'bootConfigVerifiedAt':a['checkedAt']})
    state.pop('bootVerifiedAt',None)
    write(base/'state.json',state)
    shutil.copyfile(deploy/'releases'/('upgrade-'+revision)/'manifest.json',deploy/'releases/manifest.json'); os.chmod(deploy/'releases/manifest.json',0o600)
    shutil.copyfile(release/'retained-assets-next.json',deploy/'releases/retained-assets.json'); os.chmod(deploy/'releases/retained-assets.json',0o600)
    result={'persistedImage':c['Image'],'standbyBackgroundRefresh':False,'continuousSynchronization':False}
elif action=='restore-current':
    conf=read(release/'compose-before.json'); flags(conf['services']['app']); assert conf['services']['app']['image']==a['previousImage']
    write(base/'compose-private.json',conf); run(dc+['up','-d','--no-deps','--wait','--wait-timeout','120','app'])
    result=summary(healthy('getcodex-sub2api-app',a['previousImage']))
elif action=='restore-records':
    for source,dest in [('state-before.json',base/'state.json'),('manifest-before.json',deploy/'releases/manifest.json')]: shutil.copyfile(release/source,dest); os.chmod(dest,0o600)
    p=release/'retained-assets-before.json'; target=deploy/'releases/retained-assets.json'
    if p.exists(): shutil.copyfile(p,target); os.chmod(target,0o600)
    else: target.unlink(missing_ok=True)
    result={'originalRecordsRestored':True}
elif action=='original-config': result={'config':(release/'Caddyfile.before').read_text()}
elif action=='cleanup':
    result=cleanup()
    upload=Path(a['upload']); assert re.fullmatch(r'/home/ubuntu/sub2api-upgrade-[a-f0-9]{12}',str(upload))
    if upload.exists(): assert upload.is_dir() and not upload.is_symlink(); shutil.rmtree(upload)
    result['ownedUploadRemoved']=True
elif action=='journal': write(release/'state.json',a['state']); result={'saved':True}
elif action=='status':
    conf=read(base/'compose-private.json'); state=active_state(); manifest=read(deploy/'releases/manifest.json'); flags(conf['services']['app'])
    result={'app':summary(inspect('getcodex-sub2api-app')),'caddy':summary(caddy_check()),'persistedImage':conf['services']['app']['image'],'stateImage':state['image'],'manifestImage':manifest['imageId'],'bootId':Path('/proc/sys/kernel/random/boot_id').read_text().strip(),'systemdEnabled':run(['systemctl','is-enabled','getcodex-sub2api.service']).strip()==b'enabled','systemdActive':run(['systemctl','is-active','getcodex-sub2api.service']).strip()==b'active','standbyBackgroundRefresh':False,'continuousSynchronization':state['continuousSynchronization']}
else: raise ValueError('Unknown remote action')
print(json.dumps(result))
`

function command(binary, args, input, timeout = 180_000, raw = false) {
  const r = spawnSync(binary, args, { input, encoding: raw ? undefined : 'utf8', timeout, maxBuffer: 8 << 20 })
  if (r.error || r.status !== 0) {
    const diagnostic = join(privateRoot, `getcodex-upgrade-failure-${randomBytes(6).toString('hex')}.json`)
    writeFileSync(diagnostic, JSON.stringify({ operation: binary, status: r.status, error: r.error?.code,
      stdout: String(r.stdout || '').slice(-16384), stderr: String(r.stderr || '').slice(-16384) }), { flag: 'wx', mode: 0o600 })
    throw new Error(`${binary} operation failed; bounded sensitive diagnostics saved privately: ${diagnostic}`)
  }
  return raw ? r.stdout : r.stdout.trim()
}
function remote(action, state = {}, extra = {}) {
  const safe = { action, revision: state.revision, image: state.image, commit: state.commit,
    candidate: state.candidate, candidateVolume: state.candidateVolume, previousId: state.previousId,
    previousImage: state.previousImage, caddyId: state.caddyId, caddyStartedAt: state.caddyStartedAt, upload: state.upload, ...extra }
  return JSON.parse(command('ssh', [...sshOptions, host, 'sudo -n python3 -c ' + quote(remoteProgram)], JSON.stringify(safe)))
}
async function save(directory, state) {
  const path = join(directory, 'state.json')
  await writeFile(path + '.pending', JSON.stringify(state, null, 2) + '\n', { mode: 0o600 })
  await rename(path + '.pending', path)
  remote('journal', state, { state })
}
async function hashFile(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
async function streamBackup(directory, name, shell, maxBytes) {
  const target = join(directory, name), temporary = target + '.partial'
  const hash = createHash('sha256'); let bytes = 0
  const child = spawn('ssh', [...sshOptions, host, shell], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-16384) })
  const finished = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', code => code === 0 ? resolve() : reject(new Error('HK backup failed; details suppressed')))
  })
  const timer = setTimeout(() => child.kill('SIGTERM'), 180_000)
  try {
    await Promise.all([finished, pipeline(child.stdout, new Transform({ transform(chunk, _encoding, callback) {
      bytes += chunk.length
      if (bytes > maxBytes) return callback(new Error('HK backup exceeded its size budget'))
      hash.update(chunk); callback(null, chunk)
    } }), createWriteStream(temporary, { flags: 'wx', mode: 0o600 }))])
    assert(bytes > 0); await rename(temporary, target)
    return { name, bytes, sha256: hash.digest('hex') }
  } catch {
    const diagnostic = join(directory, 'failure-' + name + '.json')
    await writeFile(diagnostic, JSON.stringify({ archive: name, bytes, stderr }), { mode: 0o600 })
    throw new Error('HK backup failed; bounded sensitive diagnostics saved privately: ' + diagnostic)
  } finally { clearTimeout(timer); if (child.exitCode === null) child.kill('SIGTERM') }
}
async function backup(directory, state) {
  const target = join(directory, 'backup'); await mkdir(target, { mode: 0o700 })
  const started = now(), archives = []
  archives.push(await streamBackup(target, 'postgres.dump', 'sudo -n docker exec getcodex-sub2api-postgres sh -c ' + quote('PGPASSWORD="$POSTGRES_PASSWORD" exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner --no-acl --lock-wait-timeout=3s'), 256 << 20))
  archives.push(await streamBackup(target, 'redis.rdb', 'sudo -n docker exec getcodex-sub2api-redis redis-cli --rdb -', 64 << 20))
  archives.push(await streamBackup(target, 'app-data.tar.gz', 'sudo -n docker exec getcodex-sub2api-app tar -czf - --exclude=./logs --exclude=./backups -C /app/data .', 256 << 20))
  archives.push(await streamBackup(target, 'configuration-private.tar.gz', 'sudo -n tar -czf - -C / etc/sub2api/compose-private.json etc/sub2api/state.json opt/sub2api/Caddyfile opt/sub2api/releases/manifest.json etc/systemd/system/getcodex-sub2api.service', 4 << 20))
  const report = { started, finished: now(), archives, oldImageId: state.previousImage, oldContainerId: state.previousId,
    kind: 'live-consistent-postgres-dump-and-separate-redis-and-app-snapshots', crossStoreAtomicSnapshot: false, restorePerformed: false }
  await writeFile(join(target, 'backup-manifest.json'), JSON.stringify(report, null, 2), { mode: 0o600 })
  for (const file of archives) assert.equal((await stat(join(target, file.name))).mode & 0o777, 0o600)
  return { directory: target, ...report }
}
async function connectTunnel(port, attempt) {
  assert([18584, 18585].includes(port))
  const server = createServer(); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const localPort = server.address().port; await new Promise(resolve => server.close(resolve))
  const child = spawn('ssh', forwardArgs(localPort, port), { stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-16384) })
  let failed = false; child.once('error', () => { failed = true })
  try {
    const base = `http://127.0.0.1:${localPort}`, deadline = Date.now() + 15_000
    while (true) {
      assert(!failed && child.exitCode === null, 'Bounded HK tunnel failed')
      try { const r = await fetch(base + '/health', { signal: AbortSignal.timeout(1000) }); if (r.ok) break } catch { /* Tunnel startup. */ }
      assert(Date.now() < deadline, 'HK tunnel readiness deadline exceeded'); await delay(200)
    }
    return { base, close: async () => { child.kill('SIGTERM') } }
  } catch (error) {
    const diagnostic = join(privateRoot, `getcodex-tunnel-failure-${randomBytes(6).toString('hex')}.json`)
    const result = await recordFailedTunnel(child, { remotePort: port, localPort, connectionAttempt: attempt, exitCode: child.exitCode,
      signalCode: child.signalCode, failure: error.message, stderr }, diagnostic)
    throw new Error(result.diagnosticSaved ? `${error.message}; private tunnel diagnostic: ${diagnostic}` : `${error.message}; private tunnel diagnostic could not be saved`)
  }
}
export async function tunnel(port, work) {
  return retryConnection(attempt => connectTunnel(port, attempt), work)
}
export async function readBoundedBody(response, maxBytes = 8 << 20) {
  const chunks = []; let bytes = 0
  assert(response.body, 'Expected a response body')
  for await (const chunk of response.body) {
    bytes += chunk.byteLength
    assert(bytes <= maxBytes, 'Asset response exceeded its byte budget')
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks, bytes)
}
export async function assetGraph(base) {
  const url = new URL(base)
  assert(url.hostname === '127.0.0.1' || (url.hostname === 'getcodex.pro' && url.protocol === 'https:'))
  const require = createRequire(join(root, 'frontend/package.json')), ts = require('typescript')
  async function request(path) {
    const r = await fetch(base + path, { headers: { Connection: 'close' }, signal: AbortSignal.timeout(10_000), redirect: 'error' })
    assert.equal(r.status, 200); assert(!r.headers.get('content-type')?.includes('text/html') || path === '/login')
    return readBoundedBody(r)
  }
  const paths = new Set(), files = new Map(); let bytes = 0
  function add(value, parent = '/') {
    if (!/^(?:\/assets\/|assets\/|\.\.?\/)[a-zA-Z0-9_.\/-]+\.(?:js|css)$/.test(value)) return
    const path = new URL(value.startsWith('assets/') ? '/' + value : value, 'http://assets.invalid' + parent).pathname
    if (!assetPattern.test(path)) return
    paths.add(path); assert(paths.size <= 1000)
  }
  const html = (await request('/login')).toString()
  for (const match of html.matchAll(/(?:src|href)=["']([^"']+)["']/g)) add(match[1])
  for (const path of paths) {
    const body = await request(path); bytes += body.length; assert(bytes < maxAssetBytes)
    files.set(path, { body, bytes: body.length, sha256: digest(body) })
    if (path.endsWith('.js')) {
      const source = ts.createSourceFile(path, body.toString(), ts.ScriptTarget.Latest, false, ts.ScriptKind.JS)
      assert.equal(source.parseDiagnostics.length, 0)
      const visit = node => { if (ts.isStringLiteralLike(node)) add(node.text, path); ts.forEachChild(node, visit) }; visit(source)
    }
  }
  assert(files.size > 50 && [...files.keys()].some(path => path.endsWith('.css')), 'Embedded lazy asset graph is incomplete')
  return files
}
async function health(base, state, slot) {
  const r = await fetch(base + '/health', { headers: { Connection: 'close' }, signal: AbortSignal.timeout(10_000), redirect: 'error' })
  assert.equal(r.status, 200); assert.equal((await r.json()).status, 'ok')
  if (slot) { assert.equal(r.headers.get('x-sub2api-slot'), slot); assert.equal(r.headers.get('x-sub2api-release'), state.revision) }
}
async function probe(directory, state, stage, port, publicEntry = false) {
  const admin = remote('admin-probe', state, { port, recovery: stage === 'rollback-bridge' })
  const run = async base => {
    await health(base, state, publicEntry ? (stage === 'candidate-public' ? 'hk-candidate' : 'hk-current') : null)
    const graph = await assetGraph(base)
    const chunk = [...graph.entries()].find(([path]) => /\/QuotaOverviewView-[a-zA-Z0-9_-]+\.js$/.test(path))
    assert(chunk && chunk[1].body.includes(Buffer.from('quota-overview')), 'Exact quota-overview lazy chunk is missing')
    if (state.candidateProof) {
      assert.equal(chunk[0], state.candidateProof.quotaChunkPath)
      assert.equal(chunk[1].sha256, state.candidateProof.quotaChunkSha256, 'Candidate and serving quota chunks differ')
    }
    const gateway = await liveGateway(base + '/v1', publicEntry ? (stage === 'candidate-public' ? 'hk-candidate' : 'hk-current') : null, { timeoutMs: 60_000 })
    const report = { stage, checkedAt: now(), image: state.image, commit: state.commit, ...admin, quotaChunk: true,
      quotaChunkPath: chunk[0], quotaChunkSha256: chunk[1].sha256, embeddedAssets: graph.size, gateway }
    requireProbe(report, state, stage)
    await writeFile(join(directory, stage + '-verification.json'), JSON.stringify(report, null, 2), { mode: 0o600 })
    return report
  }
  return publicEntry ? run('https://getcodex.pro') : tunnel(port, run)
}
async function reload(directory, state, target) {
  const config = routing(target, state.revision, Object.keys(state.assets))
  await writeFile(join(directory, target === 'app:8080' ? 'Caddyfile.current' : 'Caddyfile.candidate'), config, { mode: 0o600 })
  const result = remote('reload', state, { config })
  await health('https://getcodex.pro', state, target === 'app:8080' ? 'hk-current' : 'hk-candidate')
  return result
}
async function verifyRetainedAssets(state) {
  for (const [path, meta] of Object.entries(state.assets)) {
    const r = await fetch('https://getcodex.pro' + path, { headers: { Connection: 'close' }, signal: AbortSignal.timeout(10_000), redirect: 'error' })
    assert.equal(r.status, 200); assert.equal(r.headers.get('x-sub2api-slot'), 'hk-retained-assets')
    const body = await readBoundedBody(r); assert.equal(body.length, meta.bytes); assert.equal(digest(body), meta.sha256)
  }
  return { identical: true, checked: Object.keys(state.assets).length }
}
async function rollback(directory, state) {
  // If canonical app was changed, a verified candidate remains the serving
  // bridge while restoring the old image. No database/Redis restore is involved.
  if (state.currentChanged) {
    remote('candidate-start', state)
    await probe(directory, state, 'rollback-bridge', 18585)
    await reload(directory, state, state.candidate + ':8080')
    remote('restore-current', state)
  }
  const original = remote('original-config', state).config
  remote('reload', state, { config: original })
  await health('https://getcodex.pro', state, null)
  remote('admin-probe', state, { port: 18584, image: state.previousImage })
  const gateway = await liveGateway('https://getcodex.pro/v1', null, { timeoutMs: 60_000 })
  remote('restore-records', state)
  state.phase = 'rolled-back'; state.rollbackAt = now(); state.rollbackGateway = gateway
  await save(directory, state)
  state.cleanup = remote('cleanup', state); await save(directory, state)
  return state
}

export async function main(argv = process.argv.slice(2)) {
  process.umask(0o077)
  const [action, argument] = argv
  assert(['prepare', 'resume-prepare', 'activate', 'rollback', 'status', 'verify-boot'].includes(action))
  assert.equal(argv.length, 2, 'Use ACTION MANIFEST for prepare, or ACTION PRIVATE_UPGRADE_DIRECTORY')
  await mkdir(privateRoot, { recursive: true, mode: 0o700 }); await chmod(privateRoot, 0o700)
  let directory, state, locked = false, localLock
  const lockPath = join(privateRoot, '.getcodex-upgrade.lock'), lockToken = randomBytes(16).toString('hex')
  try {
    if (action !== 'status' && action !== 'verify-boot') {
      localLock = await open(lockPath, 'wx', 0o600); await localLock.writeFile(JSON.stringify({ pid: process.pid, action, token: lockToken, startedAt: now() }))
      remote('lock', {}, { token: lockToken, startedAt: now() }); locked = true
    }
    if (action === 'prepare') {
      const manifestPath = resolve(argument), manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
      const revision = validateRelease(manifest, manifestPath), observed = remote('inventory', { revision })
      assert.equal(manifest.version, observed.version); assert.notEqual(manifest.imageId, observed.app.image)
      // Shared-DB cutover requires no migration or Ent schema differences.
      command('git', ['diff', '--exit-code', observed.previousCommit, manifest.commit, '--', 'backend/migrations', 'backend/ent/schema'])
      const sums = (await readFile(join(dirname(manifestPath), 'SHA256SUMS'), 'utf8')).split('\n')
      const hashes = {}
      for (const name of ['image.tar', 'manifest.json']) {
        const line = sums.find(line => line.endsWith('  ' + name)); assert(line && /^[a-f0-9]{64}  /.test(line))
        hashes[name] = await hashFile(join(dirname(manifestPath), name)); assert.equal(hashes[name], line.slice(0, 64))
      }
      const savedManifest = JSON.parse(command('tar', ['-xOf', join(dirname(manifestPath), 'image.tar'), 'manifest.json']))
      assert.equal(savedManifest.length, 1)
      const config = command('tar', ['-xOf', join(dirname(manifestPath), 'image.tar'), savedManifest[0].Config], undefined, 60_000, true)
      assert.equal('sha256:' + digest(config), manifest.imageConfigDigest)
      const imageConfig = JSON.parse(config); assert.equal(imageConfig.config.Labels['org.opencontainers.image.revision'], manifest.commit)
      if (observed.priorAttempt) requireRetry(observed.priorAttempt, { revision, image: manifest.imageId, commit: manifest.commit, previousImage: observed.app.image })
      directory = await mkdtemp(join(privateRoot, 'getcodex-upgrade-'))
      state = { phase: 'preparing', revision, version: manifest.version, commit: manifest.commit, image: manifest.imageId,
        manifestPath, imageConfigDigest: manifest.imageConfigDigest, imageTarSha256: hashes['image.tar'], manifestSha256: hashes['manifest.json'],
        previousImage: observed.app.image, previousId: observed.app.id, previousCommit: observed.previousCommit,
        caddyId: observed.caddy.id, caddyStartedAt: observed.caddy.startedAt, previousBootId: observed.bootId,
        candidate: 'getcodex-sub2api-quota-candidate-' + revision, candidateVolume: 'getcodex-sub2api-quota-candidate-' + revision + '-data',
        upload: '/home/ubuntu/sub2api-upgrade-' + randomBytes(6).toString('hex'), preparedAt: now(), currentChanged: false,
        standbyBackgroundRefresh: false, continuousSynchronization: false }
      state.initialization = remote('init', state); await save(directory, state)
      state.backup = await backup(directory, state); await save(directory, state)
      const oldFiles = await tunnel(18584, assetGraph), newAssets = {}, files = join(directory, 'assets')
      await mkdir(files, { mode: 0o700 })
      for (const [path, file] of oldFiles) {
        newAssets[path] = { bytes: file.bytes, sha256: file.sha256 }
        const target = join(files, path.slice(1)); await mkdir(dirname(target), { recursive: true, mode: 0o700 })
        await writeFile(target, file.body, { mode: 0o600 })
      }
      state.assets = { ...observed.retainedAssets }
      for (const [path, meta] of Object.entries(newAssets)) {
        if (state.assets[path]) assert.equal(state.assets[path].sha256, meta.sha256)
        state.assets[path] = meta
      }
      assert(Object.values(state.assets).reduce((total, v) => total + v.bytes, 0) < maxAssetBytes)
      command('ssh', [...sshOptions, host, 'mkdir -m 700 ' + quote(state.upload)])
      command('scp', ['-q', ...sshOptions, join(dirname(manifestPath), 'image.tar'), manifestPath, host + ':' + state.upload + '/'], undefined, 300_000)
      state.imageQualification = remote('stage', state, { upload: state.upload, imageTarSha256: state.imageTarSha256, manifestSha256: state.manifestSha256 })
      command('scp', ['-q', ...sshOptions, '-r', files, host + ':' + state.upload + '/'], undefined, 180_000)
      remote('assets', state, { upload: state.upload, newAssets, assets: state.assets })
      state.candidateContainer = remote('candidate-start', state); state.phase = 'candidate-started'; await save(directory, state)
      state.candidateProof = await probe(directory, state, 'candidate', 18585)
      state.phase = 'prepared'; await save(directory, state)
    } else {
      directory = resolve(argument)
      assert.match(directory, /^\/Users\/clawbotbot\/Projects\/sub2api-upgrade-private\/getcodex-upgrade-[a-zA-Z0-9]+$/)
      state = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'))
      assert.match(state.revision, /^[a-f0-9]{12}$/); assert.equal(state.commit.slice(0, 12), state.revision)
      assert.match(state.image, /^sha256:[a-f0-9]{64}$/)
      if (action === 'resume-prepare') {
        const manifest = JSON.parse(await readFile(state.manifestPath, 'utf8'))
        assert.equal(state.backup.directory, join(directory, 'backup'))
        const report = JSON.parse(await readFile(join(state.backup.directory, 'backup-manifest.json'), 'utf8'))
        requireResume(state, manifest, report)
        assert.equal(await hashFile(state.manifestPath), state.manifestSha256)
        assert.equal(await hashFile(join(dirname(state.manifestPath), 'image.tar')), state.imageTarSha256)
        for (const file of report.archives) {
          const path = join(state.backup.directory, file.name)
          const metadata = await stat(path); assert.equal(metadata.mode & 0o777, 0o600); assert.equal(metadata.size, file.bytes)
          assert.equal(await hashFile(path), file.sha256)
        }
        const observed = remote('resume-check', state, { manifestSha256: state.manifestSha256,
          imageConfigDigest: state.imageConfigDigest, assets: state.assets })
        const publicHealth = await fetch('https://getcodex.pro/health', { headers: { Connection: 'close' }, signal: AbortSignal.timeout(10_000), redirect: 'error' })
        assert.equal(publicHealth.status, 200); assert.equal((await publicHealth.json()).status, 'ok')
        const priorMarker = observed.originalConfig.match(/header X-Sub2API-Release ([a-f0-9]{12})/)
        assert.equal(publicHealth.headers.get('x-sub2api-release'), priorMarker?.[1] || null, 'Public route changed before resume')
        state.candidateProof = await probe(directory, state, 'candidate', 18585)
        state.phase = 'prepared'; state.resumedAt = now(); await save(directory, state)
      } else if (action === 'activate') {
        assert.equal(state.phase, 'prepared'); requireProbe(state.candidateProof, state, 'candidate')
        assert(Date.now() - Date.parse(state.backup.finished) < 30 * 60_000, 'Take a fresh protected HK backup before activation')
        const observed = remote('status', state)
        assert.equal(observed.app.id, state.previousId); assert.equal(observed.app.image, state.previousImage)
        assert(observed.app.healthy && observed.systemdEnabled && observed.systemdActive)
        let activationStep = 'candidate-proof'
        try {
          // Refresh real proof immediately before the first public-route write.
          state.candidateProof = await probe(directory, state, 'candidate', 18585); await save(directory, state)
          state.phase = 'switching-to-candidate'; await save(directory, state)
          activationStep = 'candidate-route'
          state.candidateReload = await reload(directory, state, state.candidate + ':8080')
          activationStep = 'candidate-public-proof'
          state.candidateEntryProof = await probe(directory, state, 'candidate-public', 18585, true)
          activationStep = 'retained-assets-before-current'
          state.retainedAssets = await verifyRetainedAssets(state); state.phase = 'candidate-serving'; await save(directory, state)
          state.currentChanged = true; state.phase = 'rebuilding-current'; await save(directory, state)
          activationStep = 'rebuild-current'
          state.currentContainer = remote('update-current', state)
          activationStep = 'current-proof'
          state.currentProof = await probe(directory, state, 'current', 18584); await save(directory, state)
          activationStep = 'current-route'
          state.currentReload = await reload(directory, state, 'app:8080')
          activationStep = 'current-public-proof'
          state.publicProof = await probe(directory, state, 'current-public', 18584, true)
          activationStep = 'retained-assets-after-current'
          state.retainedAssets = await verifyRetainedAssets(state)
          activationStep = 'persist-current'
          state.persistence = remote('persist', state, { checkedAt: now() }); state.phase = 'active'; state.activatedAt = now(); await save(directory, state)
          activationStep = 'cleanup-candidate'
          state.cleanup = remote('cleanup', state); await save(directory, state)
        } catch (error) {
          await recoverActivationFailure(directory, state, activationStep, error)
        }
      } else if (action === 'rollback') await rollback(directory, state)
      else {
        const observed = remote('status', state)
        if (action === 'verify-boot') {
          assert.equal(state.phase, 'active')
          for (const id of [observed.app.image, observed.persistedImage, observed.stateImage, observed.manifestImage]) assert.equal(id, state.image)
          assert(observed.app.healthy && observed.systemdEnabled && observed.systemdActive)
          await health('https://getcodex.pro', state, 'hk-current')
          const gateway = await liveGateway('https://getcodex.pro/v1', 'hk-current', { timeoutMs: 60_000 })
          const report = { checkedAt: now(), image: state.image, configurationAndLiveServicesVerified: true, rebootPerformed: false, observed, gateway }
          await writeFile(join(directory, 'boot-config-verification.json'), JSON.stringify(report, null, 2), { mode: 0o600 })
          return report
        }
        return { directory, phase: state.phase, image: state.image, commit: state.commit, observed }
      }
    }
    return { directory, phase: state.phase, image: state.image, commit: state.commit, backup: state.backup?.directory,
      candidateVerified: state.candidateProof?.gateway?.completed === true, publicVerified: state.publicProof?.gateway?.completed === true, cleanup: state.cleanup }
  } finally {
    try { if (locked) remote('unlock', {}, { token: lockToken }) }
    finally { if (localLock) { await localLock.close(); await unlink(lockPath) } }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => {
    console.error(error.message); process.exitCode = 1
  })
}
