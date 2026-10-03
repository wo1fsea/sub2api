import assert from 'node:assert/strict'

export function refreshConfig(template, candidate, previous) {
  for (const upstream of [candidate, previous]) assert.match(upstream, /^[a-zA-Z0-9-]+:8080$/)
  assert(!template.includes('backend previous_assets'), 'This plan applies to the first refresh of the current ingress')
  const lines = template.split('\n')
  const blue = lines.findIndex(line => line.trim().startsWith('server blue '))
  assert(blue >= 0 && lines.filter(line => line.trim().startsWith('server blue ')).length === 1)
  const suffix = lines[blue].slice(lines[blue].indexOf(' check '))
  assert(suffix.startsWith(' check resolvers docker '))
  lines[blue] = `    server blue ${candidate}${suffix}`
  const legacy = lines.indexOf('    use_backend legacy_assets if asset_read legacy_asset')
  assert(legacy >= 0)
  lines.splice(legacy, 0,
    '    acl previous_asset path,map_str(/var/lib/sub2api-ingress/old-assets.map) -m str previous_assets',
    '    use_backend previous_assets if asset_read previous_asset')
  return `${lines.join('\n')}\nbackend previous_assets\n    http-response set-header X-Sub2API-Slot previous-assets\n    server previous ${previous} check resolvers docker init-addr last,libc,none\n`
}

export function refreshAssets(existing, latest) {
  const paths = new Map()
  for (const [text, target] of [[existing, null], [latest, 'previous_assets']]) {
    for (const line of text.trim().split('\n').filter(Boolean)) {
      const [path, backend] = line.split(' ')
      assert.match(path, /^\/assets\/[a-zA-Z0-9_./-]+\.(js|css)$/)
      assert.equal(backend, 'legacy_assets')
      paths.set(path, target || backend)
    }
  }
  assert(paths.size > 150 && paths.size < 1000)
  return [...paths].sort(([a], [b]) => a.localeCompare(b)).map(([path, backend]) => `${path} ${backend}\n`).join('')
}
