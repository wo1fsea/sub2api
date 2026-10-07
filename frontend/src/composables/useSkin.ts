import { computed, readonly, ref } from 'vue'
import type { SiteAppearance } from '@/types'

export type Skin = SiteAppearance['skin']
export const DEFAULT_SITE_APPEARANCE: SiteAppearance = {
  skin: 'neubrutalism', mode: 'light', accent_color: '#d4ff3f'
}
const currentAppearance = ref<SiteAppearance>({ ...DEFAULT_SITE_APPEARANCE })
const currentSkin = computed(() => currentAppearance.value.skin)
const isDark = computed(() => currentAppearance.value.mode === 'dark')

export function normalizeSiteAppearance(value?: Partial<SiteAppearance> | null): SiteAppearance {
  return {
    skin: value?.skin === 'original' ? 'original' : 'neubrutalism',
    mode: value?.mode === 'dark' ? 'dark' : 'light',
    accent_color: /^#[\da-f]{6}$/i.test(value?.accent_color || '')
      ? value!.accent_color! : DEFAULT_SITE_APPEARANCE.accent_color
  }
}

// Choose readable text even when an administrator selects a dark accent.
export function accentInk(color: string): string {
  const channels = [1, 3, 5].map(offset => parseInt(color.slice(offset, offset + 2), 16) / 255)
  const [r, g, b] = channels.map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
  const luminance = r * 0.2126 + g * 0.7152 + b * 0.0722
  return luminance > 0.179 ? '#000000' : '#ffffff'
}

// Server settings are authoritative; local preferences cannot persist another theme.
export function applySiteAppearance(value?: Partial<SiteAppearance> | null): void {
  const appearance = normalizeSiteAppearance(value)
  currentAppearance.value = appearance
  const root = document.documentElement
  root.dataset.skin = appearance.skin
  root.classList.toggle('dark', appearance.mode === 'dark')
  root.style.setProperty('--site-accent-color', appearance.accent_color)
  root.style.setProperty('--site-accent-ink', accentInk(appearance.accent_color))
}

export function initSkin(): void {
  applySiteAppearance(window.__APP_CONFIG__?.site_appearance)
}

export function useSkin() {
  return { skin: readonly(currentSkin), isDark: readonly(isDark), appearance: readonly(currentAppearance) }
}
