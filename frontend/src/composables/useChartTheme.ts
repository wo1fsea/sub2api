import { computed, ref } from 'vue'
import { useMutationObserver } from '@vueuse/core'
import { useSkin } from './useSkin'

const hatches = [
  { size: 6, width: 1, reverse: false },
  { size: 10, width: 1, reverse: false },
  { size: 6, width: 1, reverse: true },
  { size: 10, width: 1, reverse: true },
  { size: 8, width: 2, reverse: false },
  { size: 12, width: 2, reverse: false },
  { size: 8, width: 2, reverse: true },
  { size: 12, width: 2, reverse: true },
  { size: 14, width: 1, reverse: false },
  { size: 14, width: 1, reverse: true },
  { size: 16, width: 3, reverse: false },
  { size: 16, width: 3, reverse: true }
]

// Two palettes per document, shared across chart mounts and theme round trips.
// Failed canvas allocations are not cached, so a later chart can recover.
const patternCache = new WeakMap<Document, Map<boolean, Array<CanvasPattern | string>>>()
const lineDashes = [[], [7, 4], [2, 3], [10, 3, 2, 3]]

export function useChartTheme() {
  const { skin } = useSkin()
  const isDark = ref(document.documentElement.classList.contains('dark'))
  useMutationObserver(document.documentElement, () => {
    isDark.value = document.documentElement.classList.contains('dark')
  }, { attributes: true, attributeFilter: ['class'] })
  const distributionColors = computed(() => isDark.value
    ? ['#dddddd', '#aaaaaa', '#777777', '#bdbdbd', '#919191', '#666666', '#d0d0d0', '#a3a3a3', '#838383', '#c6c6c6', '#989898', '#707070']
    : ['#555555', '#999999', '#737373', '#b8b8b8', '#616161', '#a6a6a6', '#848484', '#464646', '#c4c4c4', '#919191', '#686868', '#adadad'])
  const chartInk = computed(() => isDark.value ? '#f4f4f4' : '#181818')
  const chartMuted = computed(() => isDark.value ? '#bcbcbc' : '#4a4a4a')
  const chartSurface = computed(() => isDark.value ? '#222222' : '#fdfdfd')
  const chartGrid = computed(() => isDark.value ? '#444444' : '#deded8')
  const distributionFills = computed(() => {
    const cached = patternCache.get(document)?.get(isDark.value)
    if (cached) return cached
    let complete = true
    const fills = hatches.map(({ size, width, reverse }, index) => {
      const tile = document.createElement('canvas')
      tile.width = tile.height = size
      const context = tile.getContext('2d')
      if (!context) {
        complete = false
        return distributionColors.value[index]
      }
      context.fillStyle = chartSurface.value
      context.fillRect(0, 0, size, size)
      context.strokeStyle = chartMuted.value
      context.lineWidth = width
      context.beginPath()
      // Include neighboring diagonals so repeating tile edges join without gaps.
      for (let offset = -size; offset <= size; offset += size) {
        context.moveTo(offset, reverse ? 0 : size)
        context.lineTo(offset + size, reverse ? size : 0)
      }
      context.stroke()
      const pattern = context.createPattern(tile, 'repeat')
      if (!pattern) complete = false
      return pattern || distributionColors.value[index]
    })
    if (complete) {
      const palettes = patternCache.get(document) || new Map()
      palettes.set(isDark.value, fills)
      patternCache.set(document, palettes)
    }
    return fills
  })
  const distributionSwatches = computed(() => hatches.map(({ size, width, reverse }) => ({
    backgroundColor: chartSurface.value,
    backgroundImage: `repeating-linear-gradient(${reverse ? 45 : 135}deg, ${chartMuted.value} 0 ${width / Math.SQRT2}px, transparent ${width / Math.SQRT2}px ${size / Math.SQRT2}px)`
  })))
  // Override appearance only; preserve points, axes, labels and data semantics.
  const lineStyle = (index: number) => skin.value === 'neubrutalism' ? {
    borderColor: index % 2 ? chartMuted.value : chartInk.value,
    backgroundColor: index % 2 ? chartMuted.value : chartInk.value,
    pointBackgroundColor: index % 2 ? chartMuted.value : chartInk.value,
    borderDash: lineDashes[index % lineDashes.length],
    fill: false as const
  } : {}
  const lineLegend = computed(() => skin.value === 'neubrutalism' ? {
    usePointStyle: false, boxWidth: 22, boxHeight: 2
  } : {})
  const tooltipTheme = computed(() => skin.value === 'neubrutalism' ? {
    backgroundColor: chartSurface.value, titleColor: chartInk.value,
    bodyColor: chartMuted.value, borderColor: chartInk.value, borderWidth: 1,
    cornerRadius: 0
  } : {})
  return { skin, isDark, distributionColors, distributionFills, distributionSwatches,
    chartInk, chartMuted, chartSurface, chartGrid, lineStyle, lineLegend, tooltipTheme }
}
