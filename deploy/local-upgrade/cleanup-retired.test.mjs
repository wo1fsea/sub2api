import assert from 'node:assert/strict'
import { test } from 'node:test'
import { removeLegacyCompose } from './cleanup-retired.mjs'

test('retirement removes only the old application and its own volume', () => {
  const source = 'services:\n  sub2api:\n    image: old\n    environment:\n      JWT_SECRET: fixture\n  postgres:\n    image: postgres\n  redis:\n    image: redis\nnetworks:\n  shared:\nvolumes:\n  app-data:\n    driver: local\n  postgres-data:\n  redis-data:\n'
  const expected = 'services:\n  postgres:\n    image: postgres\n  redis:\n    image: redis\nnetworks:\n  shared:\nvolumes:\n  postgres-data:\n  redis-data:\n'
  assert.equal(removeLegacyCompose(source), expected)
  assert.equal(removeLegacyCompose(expected), expected)
})

test('an unexpected dependency layout is rejected', () => {
  assert.throws(() => removeLegacyCompose('services:\n  sub2api:\nvolumes:\n  app-data:\n'), /shared dependencies/)
})
