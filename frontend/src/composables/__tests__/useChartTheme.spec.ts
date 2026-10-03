import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'
import { mount } from '@vue/test-utils'
let useChartTheme: typeof import('../useChartTheme').useChartTheme
let setSkin: typeof import('../useSkin').setSkin

const Probe = defineComponent({
  setup: () => useChartTheme(),
  template: '<div>{{ skin }}|{{ isDark }}|{{ distributionColors.join(",") }}</div>'
})

function expectGrayscale(colors: string[]) {
  expect(colors).toHaveLength(12)
  expect(new Set(colors).size).toBe(12)
  for (const color of colors) {
    expect(color.slice(1, 3)).toBe(color.slice(3, 5))
    expect(color.slice(3, 5)).toBe(color.slice(5, 7))
  }
}

describe('shared chart theme', () => {
  beforeEach(async () => {
    vi.resetModules()
    ;({ useChartTheme } = await import('../useChartTheme'))
    ;({ setSkin } = await import('../useSkin'))
    document.documentElement.classList.remove('dark')
    setSkin('neubrutalism')
  })
  afterEach(() => {
    vi.restoreAllMocks()
    document.documentElement.classList.remove('dark')
    setSkin('original')
  })

  it('uses distinct neutral shades and reacts to both dark-mode directions', async () => {
    const wrapper = mount(Probe)
    try {
      const lightColors = [...wrapper.vm.distributionColors]
      expectGrayscale(lightColors)
      document.documentElement.classList.add('dark')
      await vi.waitFor(() => expect(wrapper.vm.isDark).toBe(true))
      expectGrayscale(wrapper.vm.distributionColors)
      expect(wrapper.vm.distributionColors).not.toEqual(lightColors)
      document.documentElement.classList.remove('dark')
      await vi.waitFor(() => expect(wrapper.vm.isDark).toBe(false))
      expect(wrapper.vm.distributionColors).toEqual(lightColors)
    } finally {
      wrapper.unmount()
    }
  })

  it('updates the skin without changing dark mode', async () => {
    document.documentElement.classList.add('dark')
    const wrapper = mount(Probe)
    try {
      expect(wrapper.vm.isDark).toBe(true)
      setSkin('original')
      await wrapper.vm.$nextTick()
      expect(wrapper.vm.skin).toBe('original')
      expect(wrapper.vm.isDark).toBe(true)
      setSkin('neubrutalism')
      await wrapper.vm.$nextTick()
      expect(wrapper.vm.skin).toBe('neubrutalism')
    } finally {
      wrapper.unmount()
    }
  })

  it('draws repeating diagonal fills and refreshes the pattern contrast in dark mode', async () => {
    const contexts: Array<{ fillStyle: string; strokeStyle: string; lineWidth: number; moveTo: ReturnType<typeof vi.fn>; lineTo: ReturnType<typeof vi.fn> }> = []
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => {
      const context = {
        fillStyle: '', strokeStyle: '', lineWidth: 0,
        fillRect: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(),
        createPattern: vi.fn(() => ({ hatch: contexts.length }))
      }
      contexts.push(context)
      return context as unknown as CanvasRenderingContext2D
    })
    const wrapper = mount(Probe)
    try {
      const lightPatterns = wrapper.vm.distributionFills
      expect(lightPatterns).toHaveLength(12)
      expect(contexts[0].fillStyle).toBe('#fdfdfd')
      expect(contexts[0].strokeStyle).toBe('#4a4a4a')
      expect(contexts[0].moveTo).toHaveBeenCalledWith(0, 6)
      expect(contexts[0].lineTo).toHaveBeenCalledWith(6, 0)
      expect(contexts[2].moveTo).toHaveBeenCalledWith(0, 0)
      expect(contexts[2].lineTo).toHaveBeenCalledWith(6, 6)
      expect(wrapper.vm.distributionSwatches[0].backgroundImage).toContain('135deg')
      expect(wrapper.vm.distributionSwatches[2].backgroundImage).toContain('45deg')
      document.documentElement.classList.add('dark')
      await vi.waitFor(() => expect(wrapper.vm.isDark).toBe(true))
      expect(wrapper.vm.distributionFills).not.toBe(lightPatterns)
      expect(contexts[12].fillStyle).toBe('#222222')
      expect(contexts[12].strokeStyle).toBe('#bcbcbc')
      const second = mount(Probe)
      expect(second.vm.distributionFills).toBe(wrapper.vm.distributionFills)
      expect(contexts).toHaveLength(24)
      document.documentElement.classList.remove('dark')
      await vi.waitFor(() => expect(wrapper.vm.isDark).toBe(false))
      expect(wrapper.vm.distributionFills).toBe(lightPatterns)
      expect(second.vm.distributionFills).toBe(lightPatterns)
      expect(contexts).toHaveLength(24)
      wrapper.unmount()
      const remounted = mount(Probe)
      expect(remounted.vm.distributionFills).toBe(lightPatterns)
      expect(contexts).toHaveLength(24)
      second.unmount()
      remounted.unmount()
    } finally {
      wrapper.unmount()
    }
  })

  it('falls back to neutral fills if a canvas context is unavailable', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    const wrapper = mount(Probe)
    expect(wrapper.vm.distributionFills).toEqual(wrapper.vm.distributionColors)
    wrapper.unmount()
  })

  it('does not cache a failed pattern allocation and lets a later chart recover', () => {
    const context = { fillRect: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(),
      createPattern: vi.fn().mockReturnValue(null) }
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D)
    const first = mount(Probe)
    expect(first.vm.distributionFills).toEqual(first.vm.distributionColors)
    context.createPattern.mockReturnValue({ hatch: true })
    const second = mount(Probe)
    expect(second.vm.distributionFills.every(value => typeof value !== 'string')).toBe(true)
    first.unmount()
    second.unmount()
  })

  it('keeps neutral trend styles and tooltip contrast reactive, with an original fallback', async () => {
    const wrapper = mount(Probe)
    expect(wrapper.vm.lineStyle(0)).toMatchObject({ borderColor: '#181818', fill: false, borderDash: [] })
    expect(wrapper.vm.lineStyle(1).borderDash).toEqual([7, 4])
    document.documentElement.classList.add('dark')
    await vi.waitFor(() => expect(wrapper.vm.isDark).toBe(true))
    expect(wrapper.vm.lineStyle(0).borderColor).toBe('#f4f4f4')
    expect(wrapper.vm.tooltipTheme).toMatchObject({ backgroundColor: '#222222', bodyColor: '#bcbcbc' })
    setSkin('original')
    expect(wrapper.vm.lineStyle(0)).toEqual({})
    expect(wrapper.vm.tooltipTheme).toEqual({})
    wrapper.unmount()
  })
})
