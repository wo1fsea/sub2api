import { beforeEach, describe, expect, it, vi } from 'vitest'

const { post } = vi.hoisted(() => ({ post: vi.fn() }))
vi.mock('@/api/client', () => ({ apiClient: { post } }))
import { getBatchUsage } from '@/api/admin/accounts'

describe('admin account batch quota API', () => {
  beforeEach(() => {
    post.mockReset()
    post.mockResolvedValue({ data: { usage: {}, errors: {} } })
  })

  it('keeps existing force and default behavior when request options are omitted', async () => {
    await expect(getBatchUsage([1, 2])).resolves.toEqual({ usage: {}, errors: {} })
    expect(post).toHaveBeenLastCalledWith('/admin/accounts/usage/batch', { account_ids: [1, 2], force: false }, undefined)
    await getBatchUsage([1], true)
    expect(post).toHaveBeenLastCalledWith('/admin/accounts/usage/batch', { account_ids: [1], force: true }, undefined)
  })

  it('forwards the caller timeout and cancellation signal to the request', async () => {
    const controller = new AbortController()
    await getBatchUsage([7], true, { timeout: 45_000, signal: controller.signal })
    expect(post).toHaveBeenCalledWith('/admin/accounts/usage/batch', { account_ids: [7], force: true }, { timeout: 45_000, signal: controller.signal })
  })
})
