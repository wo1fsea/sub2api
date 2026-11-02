import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

export const firstUpgradeMode = 'first-upgrade-0.2.13-to-0.2.19'
export const sameVersionMode = 'same-version-0.2.19-revision'
export const expectedFirstUpgradeMigrations = Object.freeze([
  '242_drop_platform_check_constraints.sql',
  '242_group_i18n.sql',
  '243_gemini_cached_contents.sql',
  '244_gemini_cached_contents_channel_usage.sql',
  '245_gemini_cached_contents_mutation_lease.sql',
  '246_enable_gemini_image_generation_groups.sql',
  '247_scoped_admin_api_keys.sql',
  '248_group_image_count_billing.sql'
])
const checksumPattern = /^[a-f0-9]{64}$/
const filenamePattern = /^[0-9]{3}[a-z]?_[a-zA-Z0-9_.-]+\.sql$/

export function selectRehearsalMode(oldVersion, candidateVersion) {
  if (oldVersion === '0.2.13' && candidateVersion === '0.2.19') {
    return { mode: firstUpgradeMode, oldVersion, candidateVersion,
      expectedMigrationNames: [...expectedFirstUpgradeMigrations], expectedNewMigrations: expectedFirstUpgradeMigrations.length }
  }
  if (oldVersion === '0.2.19' && candidateVersion === '0.2.19') {
    return { mode: sameVersionMode, oldVersion, candidateVersion, expectedMigrationNames: [], expectedNewMigrations: 0 }
  }
  throw new Error('This rehearsal supports only 0.2.13 to 0.2.19 or 0.2.19 to 0.2.19')
}

export function normalizeMigrationRows(rows) {
  assert(Array.isArray(rows), 'Migration rows must be an array')
  const byName = new Map()
  for (const row of rows) {
    assert(row !== null && typeof row === 'object' && !Array.isArray(row), 'Migration row is invalid')
    assert(typeof row.filename === 'string' && filenamePattern.test(row.filename), 'Migration filename is invalid')
    assert(checksumPattern.test(row.checksum || ''), 'Migration checksum is invalid')
    assert(!byName.has(row.filename), 'Duplicate migration filename')
    byName.set(row.filename, { filename: row.filename, checksum: row.checksum })
  }
  return [...byName.values()].sort((left, right) => left.filename.localeCompare(right.filename))
}

export function assertNoMigrationChanges(before, after, label = 'Migration set') {
  const normalizedBefore = normalizeMigrationRows(before)
  const normalizedAfter = normalizeMigrationRows(after)
  assert.deepEqual(normalizedAfter, normalizedBefore, `${label} changed`)
  return normalizedBefore
}

export function assertMigrationRowsMatchSource(rows, sourceChecksums, { allowMissing = [] } = {}) {
  const normalized = normalizeMigrationRows(rows)
  const source = sourceChecksums instanceof Map ? sourceChecksums : new Map(Object.entries(sourceChecksums || {}))
  assert(source.size > 0, 'Source migration inventory is empty')
  for (const [name, checksum] of source) {
    assert(typeof name === 'string' && filenamePattern.test(name), `Source migration filename is invalid: ${name}`)
    assert(checksumPattern.test(checksum || ''), `Source migration checksum is invalid: ${name}`)
  }
  const rowMap = new Map()
  for (const row of normalized) {
    assert(source.has(row.filename), `Database migration is absent from the release source: ${row.filename}`)
    assert.equal(row.checksum, source.get(row.filename), `Database migration checksum differs from release source: ${row.filename}`)
    rowMap.set(row.filename, row.checksum)
  }
  const missing = [...source.keys()].filter(name => !rowMap.has(name)).sort()
  assert.deepEqual(missing, [...allowMissing].sort(), 'Database migration coverage differs from the release source')
  for (const name of missing) assert(checksumPattern.test(source.get(name) || ''), `Source migration checksum is invalid: ${name}`)
  return { rows: normalized.length, sourceFiles: source.size, missing }
}

function expectedChecksumMap(names, checksums) {
  const entries = checksums instanceof Map ? [...checksums.entries()] : Object.entries(checksums || {})
  const map = new Map(entries)
  assert.deepEqual([...map.keys()].sort(), [...names].sort(), 'Expected migration checksum inventory changed')
  for (const name of names) assert(checksumPattern.test(map.get(name) || ''), `Expected migration checksum is invalid: ${name}`)
  return map
}

export function validateMigrationTransition({ mode, before, after, expectedChecksums }) {
  const normalizedBefore = normalizeMigrationRows(before)
  const normalizedAfter = normalizeMigrationRows(after)
  if (mode === sameVersionMode) {
    assert.deepEqual(normalizedAfter, normalizedBefore, 'Same-version rehearsal changed the migration set or checksums')
    return { mode, alreadyMigrated: true, newMigrations: [], beforeCount: normalizedBefore.length, afterCount: normalizedAfter.length }
  }
  assert(mode === firstUpgradeMode, 'Unsupported rehearsal migration mode')
  const expectedNames = [...expectedFirstUpgradeMigrations]
  const expected = expectedChecksumMap(expectedNames, expectedChecksums)
  const beforeMap = new Map(normalizedBefore.map(row => [row.filename, row.checksum]))
  const afterMap = new Map(normalizedAfter.map(row => [row.filename, row.checksum]))
  const alreadyPresent = expectedNames.filter(name => beforeMap.has(name))
  if (alreadyPresent.length > 0) {
    assert.deepEqual(alreadyPresent, expectedNames, 'Target migrations are only partially present before rehearsal')
    for (const name of expectedNames) assert.equal(beforeMap.get(name), expected.get(name), `Existing target migration checksum changed: ${name}`)
    assert.deepEqual(normalizedAfter, normalizedBefore, 'Already-migrated rehearsal changed the migration set or checksums')
    return { mode, alreadyMigrated: true, newMigrations: [], beforeCount: normalizedBefore.length, afterCount: normalizedAfter.length }
  }
  for (const row of normalizedBefore) assert.equal(afterMap.get(row.filename), row.checksum, `Existing migration changed: ${row.filename}`)
  const newNames = normalizedAfter.filter(row => !beforeMap.has(row.filename)).map(row => row.filename)
  assert.deepEqual(newNames, expectedNames, 'Unexpected or missing first-upgrade migration set')
  for (const name of expectedNames) assert.equal(afterMap.get(name), expected.get(name), `Migration checksum changed: ${name}`)
  assert.equal(normalizedAfter.length, normalizedBefore.length + expectedNames.length, 'Unexpected first-upgrade migration count')
  return { mode, alreadyMigrated: false, newMigrations: newNames, beforeCount: normalizedBefore.length, afterCount: normalizedAfter.length }
}

export function validateSameVersionPreserved({ beforeMigrations, afterMigrations, restartMigrations,
  beforeBusiness, afterBusiness, beforeConfiguration, afterConfiguration }) {
  assertNoMigrationChanges(beforeMigrations, afterMigrations, 'Same-version migration state')
  assertNoMigrationChanges(afterMigrations, restartMigrations, 'Restart migration state')
  assert.deepEqual(afterBusiness, beforeBusiness, 'Same-version business projections changed')
  assert.deepEqual(afterConfiguration, beforeConfiguration, 'Same-version configuration state changed')
  return { migrationsStable: true, businessStable: true, configurationStable: true, restartStable: true }
}

export function persistedConfigurationState(snapshot) {
  assert(snapshot !== null && typeof snapshot === 'object' && !Array.isArray(snapshot), 'Configuration snapshot is invalid')
  const { adminSettingsApi, ...persisted } = snapshot
  assert(adminSettingsApi === undefined || (adminSettingsApi !== null && typeof adminSettingsApi === 'object'), 'Admin settings API observation is invalid')
  return persisted
}

export function assertPersistedConfigurationEqual(before, after, message = 'Same-version persisted configuration state changed') {
  assert.deepEqual(persistedConfigurationState(after), persistedConfigurationState(before), message)
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}
const stableSha256 = value => createHash('sha256').update(stableJson(value)).digest('hex')

export function assertExpectedFactoryPlatformQuotaProjection(before, after) {
  assert(before !== null && typeof before === 'object' && !Array.isArray(before), 'Admin settings API before snapshot is invalid')
  assert(after !== null && typeof after === 'object' && !Array.isArray(after), 'Admin settings API after snapshot is invalid')
  const beforeTopKeys = Object.keys(before).sort(), afterTopKeys = Object.keys(after).sort()
  assert.deepEqual(afterTopKeys, beforeTopKeys, 'Admin settings API top-level key set changed')
  for (const key of beforeTopKeys) {
    if (key === 'default_platform_quotas') continue
    assert(stableJson(after[key]) === stableJson(before[key]), `Admin settings API changed an existing field: ${key}`)
  }
  const beforeBlock = before.default_platform_quotas, afterBlock = after.default_platform_quotas
  assert(beforeBlock !== null && beforeBlock !== undefined && typeof beforeBlock === 'object' && !Array.isArray(beforeBlock), 'Admin settings API default_platform_quotas before state is invalid')
  assert(afterBlock !== null && afterBlock !== undefined && typeof afterBlock === 'object' && !Array.isArray(afterBlock), 'Admin settings API default_platform_quotas after state is invalid')
  const beforePlatforms = Object.keys(beforeBlock).sort(), afterPlatforms = Object.keys(afterBlock).sort()
  const beforeSet = new Set(beforePlatforms), afterSet = new Set(afterPlatforms)
  const removedPlatforms = beforePlatforms.filter(platform => !afterSet.has(platform))
  const addedPlatforms = afterPlatforms.filter(platform => !beforeSet.has(platform))
  assert.deepEqual(removedPlatforms, [], 'Admin settings API removed an existing platform quota')
  for (const platform of beforePlatforms) {
    if (platform === 'factory') continue
    assert(stableJson(afterBlock[platform]) === stableJson(beforeBlock[platform]), `Admin settings API changed an existing platform quota: ${platform}`)
  }
  let factoryAdded = false
  if (beforeSet.has('factory')) {
    assert.deepEqual(addedPlatforms, [], 'Admin settings API added an unexpected platform quota')
    assert(stableJson(afterBlock.factory) === stableJson(beforeBlock.factory), 'Admin settings API changed the existing factory platform quota')
  } else {
    assert.deepEqual(addedPlatforms, ['factory'], 'Admin settings API must add only factory platform quota')
    const factory = afterBlock.factory
    assert(factory !== null && typeof factory === 'object' && !Array.isArray(factory), 'Admin settings API factory quota shape is invalid')
    assert.deepEqual(Object.keys(factory).sort(), ['daily', 'monthly', 'weekly'], 'Admin settings API factory quota keys changed')
    assert(factory.daily === null && factory.weekly === null && factory.monthly === null, 'Admin settings API factory quota must be null/unlimited')
    factoryAdded = true
  }
  return {
    expectedOnlyFactoryZeroQuotaAddition: factoryAdded,
    changedPaths: factoryAdded ? ['default_platform_quotas.factory'] : [],
    addedPlatforms,
    addedFactoryFields: factoryAdded ? ['daily', 'monthly', 'weekly'] : [],
    removedPlatforms,
    existingTopLevelValuesEqual: true,
    existingPlatformQuotaValuesEqual: true,
    beforeSha256: stableSha256(before),
    afterSha256: stableSha256(after)
  }
}
