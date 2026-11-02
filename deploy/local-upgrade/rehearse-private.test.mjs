import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  assertMigrationRowsMatchSource, assertNoMigrationChanges, expectedFirstUpgradeMigrations, firstUpgradeMode, normalizeMigrationRows, sameVersionMode,
  selectRehearsalMode, validateMigrationTransition, validateSameVersionPreserved
} from './rehearse-private-validation.mjs'

const baseMigration = { filename: '241_groups.sql', checksum: '1'.repeat(64) }
const sameMigrations = [
  baseMigration,
  { filename: '242_drop_platform_check_constraints.sql', checksum: '2'.repeat(64) },
  { filename: '299_factory_platform.sql', checksum: '3'.repeat(64) }
]
const firstChecksums = Object.fromEntries(expectedFirstUpgradeMigrations.map((name, index) =>
  [name, (index + 1).toString(16).padStart(64, '0')]))
const firstMigrations = expectedFirstUpgradeMigrations.map(name => ({ filename: name, checksum: firstChecksums[name] }))

test('rehearsal allows only the two explicit version paths', () => {
  assert.equal(selectRehearsalMode('0.2.13', '0.2.19').mode, firstUpgradeMode)
  assert.equal(selectRehearsalMode('0.2.13', '0.2.19').expectedNewMigrations, 8)
  assert.equal(selectRehearsalMode('0.2.19', '0.2.19').mode, sameVersionMode)
  assert.equal(selectRehearsalMode('0.2.19', '0.2.19').expectedNewMigrations, 0)
  for (const [oldVersion, candidateVersion] of [['0.2.13', '0.2.13'], ['0.2.19', '0.2.20'], ['0.2.18', '0.2.19'], ['0.2.4', '0.2.19']]) {
    assert.throws(() => selectRehearsalMode(oldVersion, candidateVersion), /only 0.2.13 to 0.2.19 or 0.2.19 to 0.2.19/)
  }
})

test('same-version rehearsal requires exact zero migration and checksum changes', () => {
  const result = validateMigrationTransition({ mode: sameVersionMode, before: sameMigrations, after: structuredClone(sameMigrations) })
  assert.deepEqual(result.newMigrations, [])
  assert.equal(result.beforeCount, sameMigrations.length)
  for (const replacement of [
    sameMigrations.map((row, index) => index === 1 ? { ...row, checksum: 'f'.repeat(64) } : row),
    sameMigrations.slice(0, -1),
    [...sameMigrations, { filename: '300_extra.sql', checksum: 'e'.repeat(64) }]
  ]) assert.throws(() => validateMigrationTransition({ mode: sameVersionMode, before: sameMigrations, after: replacement }), /changed/)
})

test('first-upgrade path retains the exact eight-file migration and checksum allowlist', () => {
  assert.equal(firstMigrations.length, 8)
  const result = validateMigrationTransition({ mode: firstUpgradeMode, before: [baseMigration], after: [baseMigration, ...firstMigrations], expectedChecksums: firstChecksums })
  assert.equal(result.newMigrations.length, 8)
  assert.deepEqual(result.newMigrations, expectedFirstUpgradeMigrations)
  assert.throws(() => validateMigrationTransition({ mode: firstUpgradeMode, before: [baseMigration],
    after: [baseMigration, ...firstMigrations.slice(0, -1)], expectedChecksums: firstChecksums }), /Unexpected or missing/)
  assert.throws(() => validateMigrationTransition({ mode: firstUpgradeMode, before: [baseMigration],
    after: [baseMigration, ...firstMigrations.map((row, index) => index === 2 ? { ...row, checksum: 'f'.repeat(64) } : row)], expectedChecksums: firstChecksums }), /checksum changed/)
})

test('already-migrated first-upgrade data still requires exact target checksums and no changes', () => {
  const before = [baseMigration, ...firstMigrations]
  const result = validateMigrationTransition({ mode: firstUpgradeMode, before, after: structuredClone(before), expectedChecksums: firstChecksums })
  assert.equal(result.alreadyMigrated, true)
  assert.deepEqual(result.newMigrations, [])
  assert.throws(() => validateMigrationTransition({ mode: firstUpgradeMode,
    before, after: before.map((row, index) => index === 1 ? { ...row, checksum: 'f'.repeat(64) } : row), expectedChecksums: firstChecksums }), /changed/)
})

test('same-version business and configuration state must stay byte-identical through restart', () => {
  const beforeBusiness = { groups: { rows: 3, digest: 'a'.repeat(32) }, scoped_admin_api_keys: { rows: 2, digest: 'b'.repeat(32) } }
  const beforeConfiguration = { schema: 'c'.repeat(32), settings: 'd'.repeat(64), pgData: '/var/lib/postgresql/data' }
  const result = validateSameVersionPreserved({ beforeMigrations: sameMigrations,
    afterMigrations: structuredClone(sameMigrations), restartMigrations: structuredClone(sameMigrations),
    beforeBusiness, afterBusiness: structuredClone(beforeBusiness),
    beforeConfiguration, afterConfiguration: structuredClone(beforeConfiguration) })
  assert.deepEqual(result, { migrationsStable: true, businessStable: true, configurationStable: true, restartStable: true })
  assert.throws(() => validateSameVersionPreserved({ beforeMigrations: sameMigrations,
    afterMigrations: structuredClone(sameMigrations), restartMigrations: structuredClone(sameMigrations),
    beforeBusiness, afterBusiness: { ...beforeBusiness, groups: { rows: 3, digest: 'z'.repeat(32) } },
    beforeConfiguration, afterConfiguration: structuredClone(beforeConfiguration) }), /business projections changed/)
  assert.throws(() => validateSameVersionPreserved({ beforeMigrations: sameMigrations,
    afterMigrations: structuredClone(sameMigrations), restartMigrations: structuredClone(sameMigrations),
    beforeBusiness, afterBusiness: structuredClone(beforeBusiness),
    beforeConfiguration, afterConfiguration: { ...beforeConfiguration, settings: 'z'.repeat(64) } }), /configuration state changed/)
})

test('restart idempotence rejects any migration row change after restart', () => {
  assert.doesNotThrow(() => assertNoMigrationChanges(sameMigrations, structuredClone(sameMigrations), 'Restart'))
  assert.throws(() => assertNoMigrationChanges(sameMigrations, sameMigrations.slice(1), 'Restart'), /Restart changed/)
})

test('same-version rehearsal requires all 299 migration rows to match the release source exactly', () => {
  const source = Object.fromEntries(sameMigrations.map(row => [row.filename, row.checksum]))
  source['300_unrelated.sql'] = '4'.repeat(64)
  const result = assertMigrationRowsMatchSource(sameMigrations, source, { allowMissing: ['300_unrelated.sql'] })
  assert.deepEqual(result.missing, ['300_unrelated.sql'])
  assert.throws(() => assertMigrationRowsMatchSource(sameMigrations, { ...source, '301_extra.sql': '5'.repeat(64) }, { allowMissing: ['300_unrelated.sql'] }),
    /coverage differs/)
  assert.throws(() => assertMigrationRowsMatchSource(sameMigrations.map((row, index) => index === 0 ? { ...row, checksum: 'f'.repeat(64) } : row), source,
    { allowMissing: ['300_unrelated.sql'] }), /checksum differs/)
  assert.throws(() => assertMigrationRowsMatchSource(sameMigrations, { ...source, '301_extra.sql': '6'.repeat(64) }, { allowMissing: ['300_unrelated.sql'] }),
    /coverage differs/)
})

test('real 299 release-source migration filenames and checksums normalize and match exactly', async () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  const directory = join(root, 'backend/migrations')
  const sourceNames = (await readdir(directory)).filter(name => name.endsWith('.sql')).sort()
  assert.equal(sourceNames.length, 299)
  const rows = [], source = new Map()
  for (const filename of sourceNames) {
    const checksum = createHash('sha256').update((await readFile(join(directory, filename), 'utf8')).trim()).digest('hex')
    rows.push({ filename, checksum })
    source.set(filename, checksum)
  }
  const normalized = normalizeMigrationRows(rows)
  assert.equal(normalized.length, 299)
  assert.deepEqual(normalized.map(row => row.filename), sourceNames)
  const coverage = assertMigrationRowsMatchSource(rows, source)
  assert.deepEqual(coverage, { rows: 299, sourceFiles: 299, missing: [] })
  const extra = [...rows, { filename: '300_extra.sql', checksum: 'e'.repeat(64) }]
  const missing = rows.slice(0, -1)
  const tampered = structuredClone(rows); tampered[0].checksum = 'f'.repeat(64)
  assert.throws(() => assertMigrationRowsMatchSource(extra, source), /absent from the release source|coverage differs/)
  assert.throws(() => assertMigrationRowsMatchSource(missing, source), /coverage differs/)
  assert.throws(() => assertMigrationRowsMatchSource(tampered, source), /checksum differs/)
  const extraSource = new Map(source); extraSource.set('300_extra.sql', 'e'.repeat(64))
  const missingSource = new Map(source); missingSource.delete(sourceNames[0])
  assert.throws(() => assertMigrationRowsMatchSource(rows, extraSource), /coverage differs/)
  assert.throws(() => assertMigrationRowsMatchSource(rows, missingSource), /absent from the release source|coverage differs/)
  for (const unsafe of ['../006b_evil.sql', '006b_dir/evil.sql', '006b_evil.SQL', '006b_evil.txt', '006b\\evil.sql']) {
    assert.throws(() => normalizeMigrationRows([{ filename: unsafe, checksum: 'a'.repeat(64) }]), /Migration filename is invalid/)
  }
})
