import assert from 'node:assert/strict'

export const backupArchiveSpecs = Object.freeze({
  'postgres.dump': { maxBytes: 256 << 20, method: 'logical-consistent-pg_dump' },
  'app-data.tar.gz': { maxBytes: 256 << 20, method: 'running-container-tar' },
  'redis.rdb': { maxBytes: 64 << 20, method: 'redis-cli-rdb-snapshot' }
})

export const backupArchiveNames = Object.freeze(Object.keys(backupArchiveSpecs))
export const protectedBackupFileNames = Object.freeze(['.env', 'compose-private.json', 'state.json', 'recovery-private.json'])
const sha256Pattern = /^[a-f0-9]{64}$/
const absolutePathPattern = /^\/(?:[^/\0]+\/)*[^/\0]+$/

function verify(condition, message) {
  assert(condition, message)
}

export function assertProtectedFileMetadata(files) {
  verify(Array.isArray(files) && files.length === protectedBackupFileNames.length, 'Protected backup file inventory changed')
  const names = new Set()
  for (const file of files) {
    verify(file !== null && typeof file === 'object' && !Array.isArray(file), 'Protected backup file metadata is invalid')
    verify(protectedBackupFileNames.includes(file.name) && !names.has(file.name), 'Protected backup file name changed')
    names.add(file.name)
    verify(typeof file.source === 'string' && absolutePathPattern.test(file.source), 'Protected backup source path is invalid')
    verify(Number.isSafeInteger(file.bytes) && file.bytes > 0 && file.bytes <= (1 << 20), 'Protected backup file size is invalid')
    verify(sha256Pattern.test(file.sha256 || ''), 'Protected backup file checksum is invalid')
    verify(file.sourceMode === '0600' && Number.isSafeInteger(file.sourceUid) && file.sourceUid >= 0, 'Protected backup source mode/owner is invalid')
  }
  verify(protectedBackupFileNames.every(name => names.has(name)), 'Protected backup files are incomplete')
}

function volumeMount(mount, role) {
  verify(mount !== null && typeof mount === 'object' && !Array.isArray(mount), `${role} volume metadata is invalid`)
  verify(mount.type === 'volume' && typeof mount.name === 'string' && mount.name.length > 0, `${role} must be backed by a named volume`)
  verify(typeof mount.destination === 'string' && mount.destination.startsWith('/'), `${role} volume destination is invalid`)
  return mount
}

export function assertVolumeCoverage(record) {
  const coverage = record?.volumeCoverage
  verify(Array.isArray(coverage) && coverage.length === 3, 'Volume coverage must contain exactly app, PostgreSQL and Redis')
  const byRole = new Map()
  for (const item of coverage) {
    verify(item !== null && typeof item === 'object' && !Array.isArray(item), 'Volume coverage entry is invalid')
    verify(['application', 'postgresql', 'redis'].includes(item.role) && !byRole.has(item.role), 'Volume coverage role is invalid')
    byRole.set(item.role, item)
    volumeMount(item.mount, item.role)
    verify(typeof item.container === 'string' && item.container.length > 0, 'Volume coverage container is invalid')
    verify(backupArchiveNames.includes(item.artifact), 'Volume coverage artifact is invalid')
  }
  const app = byRole.get('application')
  verify(app.container === 'sub2api-current-app' && app.mount.destination === '/app/data' && app.artifact === 'app-data.tar.gz', 'Application volume coverage changed')
  const postgres = byRole.get('postgresql')
  verify(postgres.container === 'sub2api-postgres' && postgres.artifact === 'postgres.dump', 'PostgreSQL logical coverage changed')
  verify(typeof postgres.database === 'string' && postgres.database.length > 0, 'PostgreSQL database identity is missing')
  verify(typeof postgres.serverVersion === 'string' && postgres.serverVersion.length > 0, 'PostgreSQL server version is missing')
  verify(typeof postgres.actualDataDirectory === 'string' && postgres.actualDataDirectory.startsWith('/'), 'Actual PostgreSQL data directory is missing')
  verify(postgres.actualDataDirectory === postgres.mount.destination || postgres.actualDataDirectory.startsWith(postgres.mount.destination.replace(/\/$/, '') + '/'), 'Actual PostgreSQL data directory is not covered by its recorded volume')
  verify(Number.isSafeInteger(postgres.migrationsCount) && postgres.migrationsCount >= 0, 'PostgreSQL migration count is invalid')
  verify(Array.isArray(postgres.supportMounts) && postgres.supportMounts.every(mount => mount !== null && typeof mount === 'object' &&
    mount.type === 'volume' && typeof mount.name === 'string' && mount.name.length > 0 && typeof mount.destination === 'string' && mount.destination.startsWith('/')), 'PostgreSQL supporting volume inventory is invalid')
  const redis = byRole.get('redis')
  verify(redis.container === 'sub2api-redis' && redis.mount.destination === '/data' && redis.artifact === 'redis.rdb', 'Redis volume coverage changed')
  return { roles: [...byRole.keys()].sort(), actualPgDataDirectory: postgres.actualDataDirectory,
    pgDataVolume: postgres.mount.name, pgDataVolumeDestination: postgres.mount.destination,
    database: postgres.database }
}

export function assertLivePostgresCoverage(record, liveMetadata, mounts) {
  const coverage = record?.volumeCoverage?.find(item => item.role === 'postgresql')
  verify(coverage, 'PostgreSQL coverage is missing')
  verify(liveMetadata !== null && typeof liveMetadata === 'object', 'Live PostgreSQL metadata is invalid')
  verify(liveMetadata.database === coverage.database, 'Backup database differs from the live database')
  verify(liveMetadata.dataDirectory === coverage.actualDataDirectory, 'Live PostgreSQL data directory changed')
  verify(liveMetadata.serverVersion === coverage.serverVersion, 'Live PostgreSQL server version changed')
  verify(liveMetadata.migrationsCount === coverage.migrationsCount, 'Live PostgreSQL migration count changed')
  const matches = (mounts || []).filter(mount => mount.Type === 'volume' &&
    (liveMetadata.dataDirectory === mount.Destination || liveMetadata.dataDirectory.startsWith(mount.Destination.replace(/\/$/, '') + '/')))
    .sort((left, right) => right.Destination.length - left.Destination.length)
  verify(matches.length > 0, 'Actual PostgreSQL data directory is not on a live volume')
  const actual = matches[0]
  verify(actual.Name === coverage.mount.name && actual.Destination === coverage.mount.destination, 'Live PostgreSQL data volume differs from the backup record')
  return { database: coverage.database, dataDirectory: coverage.actualDataDirectory, volume: actual.Name }
}
