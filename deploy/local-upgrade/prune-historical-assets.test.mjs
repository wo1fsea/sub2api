import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { planPrune } from './prune-historical-assets.mjs'
const bytes = Buffer.from('fixture asset'), hash = createHash('sha256').update(bytes).digest('hex')
const item = i => ({ path: `/assets/chunk-${String(i).padStart(8, '0')}.js`, bytes: bytes.length, sha256: hash })

test('pruning retires only old unreferenced assets, protects the complete current graph and all recent files', () => {
  const history = Array.from({ length: 200 }, (_, i) => item(i))
  const graph = new Map(history.slice(0, 60).map(i => [i.path, bytes]))
  const mtimes = Object.fromEntries(history.map((i, n) => [i.path, n < 180 ? 1 : 100]))
  const plan = planPrune(history, graph, mtimes, 50)
  assert.equal(plan.removed.length, 120)
  assert.equal(plan.retained.length, 80)
  assert(plan.removed.every(i => !graph.has(i.path) && mtimes[i.path] < 50))
  assert.equal(plan.worstMerged.count, 1080)
  assert(plan.worstMerged.bytes < 96 << 20)
  const conflict = new Map(graph); conflict.set(history[0].path, Buffer.from('wrong'))
  assert.throws(() => planPrune(history, conflict, mtimes, 50), /conflicts/)
  assert.throws(() => planPrune(history, new Map(), mtimes, 50), /Incomplete/)
})

test('pruning fails closed if protecting current/recent resources cannot fit the unchanged merge budget', () => {
  const history = Array.from({ length: 900 }, (_, i) => item(i))
  const graph = new Map(history.slice(0, 60).map(i => [i.path, bytes]))
  const mtimes = Object.fromEntries(history.map((i, n) => [i.path, n === 899 ? 1 : 100]))
  assert.throws(() => planPrune(history, graph, mtimes, 50), /cannot guarantee/)
})
