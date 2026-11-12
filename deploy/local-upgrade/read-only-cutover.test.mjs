import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import test from 'node:test'
import { request, readOnlySQL } from './upgrade-current.mjs'

test('actual cutover transport sends only credential-free GETs, with no redirects', async t => {
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options })
    return new Response('{"status":"ok"}', { status: 200 })
  })
  for (const path of ['/health', '/login', '/assets/index-AbCd1234.js']) {
    await request('http://127.0.0.1:18583', path)
  }
  assert.equal(calls.length, 3)
  for (const { options } of calls) {
    assert.equal(options.method, 'GET')
    assert.equal(options.redirect, 'error')
    assert.equal(options.credentials, 'omit')
    assert.deepEqual(options.headers, { Connection: 'close' })
    assert.equal(options.body, undefined)
  }
  for (const path of ['/api/v1/auth/login', '/api/v1/auth/me', '/v1/responses', '/api/v1/admin/usage',
    '/api/v1/admin/accounts/usage/batch', '//elsewhere/health', '/health?write=1', '/assets/../api/v1/auth/login']) {
    await assert.rejects(request('http://127.0.0.1:18583', path))
  }
  for (const options of [{ method: 'POST' }, { body: {} }, { token: 'fixture' }, { headers: { Authorization: 'fixture' } }, { redirect: 'follow' }]) {
    await assert.rejects(request('http://127.0.0.1:18583', '/health', options))
  }
  await assert.rejects(request('http://example.invalid', '/health'))
  assert.equal(calls.length, 3, 'Rejected writes must never reach the network')
})

test('live SQL checks use a bounded read-only transaction and reject mutation/transaction escapes', () => {
  assert.equal(readOnlySQL('SELECT count(*) FROM schema_migrations;'),
    "BEGIN READ ONLY; SET LOCAL statement_timeout='5s'; SELECT count(*) FROM schema_migrations; ROLLBACK;")
  for (const sql of ['UPDATE users SET last_login_at=now()', 'INSERT INTO usage_logs DEFAULT VALUES',
    'DELETE FROM schema_migrations', 'CREATE TABLE x (id int)', 'COMMIT',
    'SELECT 1; COMMIT; UPDATE users SET last_active_at=now()', 'SELECT 1; SET TRANSACTION READ WRITE']) {
    assert.throws(() => readOnlySQL(sql))
  }
})

test('actual prepare/activate/rollback source has no login/inference transport and all SQL is guarded', async () => {
  const source = await readFile(new URL('./upgrade-current.mjs', import.meta.url), 'utf8')
  const require = createRequire(new URL('../../frontend/package.json', import.meta.url))
  const ts = require('typescript')
  const ast = ts.createSourceFile('upgrade-current.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  assert.equal(ast.parseDiagnostics.length, 0)
  const functions = new Map(ast.statements.filter(ts.isFunctionDeclaration).map(node => [node.name.text, node]))
  for (const forbidden of ['session', 'verifyTerra', 'verifyQuota', 'verifyShared', 'api']) assert(!functions.has(forbidden))
  let networkCalls = 0, sqlCalls = 0
  const walk = node => {
    if (ts.isImportDeclaration(node)) assert(!node.moduleSpecifier.text.includes('live-gateway'))
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(ast)
      assert(!['session', 'liveGateway', 'verifyTerra', 'validateTerraUsage'].includes(callee), `Forbidden live call: ${callee}`)
      if (callee === 'fetch') {
        networkCalls++
        let owner = node.parent
        while (owner && !ts.isFunctionDeclaration(owner)) owner = owner.parent
        assert.equal(owner?.name.text, 'request', 'No bypass around the constrained live transport')
      }
      if (callee === 'docker' && node.arguments[0]?.getText(ast).includes('exec psql')) {
        sqlCalls++
        assert(ts.isCallExpression(node.arguments[1]))
        assert.equal(node.arguments[1].expression.getText(ast), 'readOnlySQL')
      }
    }
    ts.forEachChild(node, walk)
  }
  walk(ast)
  assert.equal(networkCalls, 1)
  assert.equal(sqlCalls, 3)
  assert(functions.get('prepare').getText(ast).includes('verifyBackup('))
  assert(functions.get('activate').getText(ast).includes('verifyBackup('))
  assert(functions.get('activate').getText(ast).includes('verifyEnvironment('))
})

test('production packaging retains full sequential type checking before Vite without a concurrent duplicate', async () => {
  const [dockerfile, vite, pkg] = await Promise.all([
    readFile(new URL('../../Dockerfile', import.meta.url), 'utf8'),
    readFile(new URL('../../frontend/vite.config.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../frontend/package.json', import.meta.url), 'utf8')
  ])
  assert.match(dockerfile, /vue-tsc\/bin\/vue-tsc\.js -b && \\\n\s+NODE_OPTIONS=.*vite\/bin\/vite\.js build/)
  assert.match(JSON.parse(pkg).scripts.build, /vue-tsc -b && vite build/)
  assert.match(vite, /vueTsc: true/)
  assert.match(vite, /enableBuild: false/)
})
