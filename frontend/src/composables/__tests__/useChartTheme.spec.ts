import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'
import { mount } from '@vue/test-utils'
import { useChartTheme } from '../useChartTheme'
import { setSkin } from '../useSkin'

const Probe = defineComponent({
  setup: useChartTheme,
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
  beforeEach(() => {
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
})
