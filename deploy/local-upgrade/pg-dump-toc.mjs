import assert from 'node:assert/strict'

function check(condition, message) { if (!condition) throw new Error(message) }

export function postgresDumpListToc(result) {
  // --list reads only an archive's directory and may close stdin while Docker
  // is still receiving its data blocks. Do not extend this exception to any
  // command that restores data or mutates a container.
  check(result.status === 0 && !result.signal && (!result.error || result.error.code === 'EPIPE'), 'Backup PostgreSQL directory check failed; private details suppressed')
  const toc = result.stdout
  check(typeof toc === 'string' && toc.endsWith('\n') && /^;\s+Archive created at /m.test(toc) && /^;\s+Format: CUSTOM\s*$/m.test(toc), 'Backup PostgreSQL archive directory is incomplete')
  const declared = /^;\s+TOC Entries:\s+(\d+)\s*$/m.exec(toc)
  const section = toc.split(/^;\s+Selected TOC Entries:\s*$/m)
  check(declared && Number(declared[1]) > 0 && section.length === 2, 'Backup PostgreSQL archive directory is incomplete')
  const entries = section[1].split('\n').filter(line => line.trim() && !line.startsWith(';'))
  check(entries.length > 0 && entries.length <= Number(declared[1]) && entries.every(line => /^\d+; \d+ \d+ .+/.test(line)), 'Backup PostgreSQL archive directory is incomplete')
  check(entries.some(line => /\bTABLE public schema_migrations\b/.test(line)), 'Backup PostgreSQL archive is not readable')
  return toc.trim()
}

export function parsePostgresDumpListing(result, expectedDatabase) {
  const toc = postgresDumpListToc(result)
  const database = /^;\s+dbname:\s+(.+?)\s*$/m.exec(toc)?.[1]
  const declared = /^;\s+TOC Entries:\s+(\d+)\s*$/m.exec(toc)?.[1]
  const selected = toc.split(/^;\s+Selected TOC Entries:\s*$/m)[1]
  const entries = selected ? selected.split('\n').filter(line => /^\d+; \d+ \d+ /.test(line)) : []
  check(database === expectedDatabase, 'PostgreSQL dump target differs from the live database')
  check(Number(declared) > 0 && entries.length > 0 && entries.length <= Number(declared), 'PostgreSQL dump table of contents is incomplete')
  check(entries.some(line => /\bTABLE public schema_migrations\b/.test(line)), 'PostgreSQL dump does not contain the live migration table')
  return { database, tocEntries: entries.length, format: 'CUSTOM', schemaMigrations: true }
}
