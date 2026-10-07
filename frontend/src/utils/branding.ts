import { sanitizeUrl } from '@/utils/url'
import brandMark from '@/assets/brand-mark.svg?raw'
import { useSkin } from '@/composables/useSkin'

export function resolveBrandLogo(logoUrl: string): string {
  const customLogo = sanitizeUrl(logoUrl, { allowRelative: true, allowDataUrl: true })
  if (customLogo) return customLogo
  const { appearance } = useSkin()
  const dark = appearance.value.mode === 'dark'
  const svg = brandMark
    .replace(/__INK__/g, dark ? '#f4f4f4' : '#171715')
    .replace(/__SURFACE__/g, dark ? '#222222' : '#f7f6f0')
    .replace(/__ACCENT__/g, appearance.value.accent_color)
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

export function updateFavicon(logoUrl: string): void {
  const sanitizedLogoUrl = resolveBrandLogo(logoUrl)

  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
  if (!link) {
    link = document.createElement('link')
    link.rel = 'icon'
    document.head.appendChild(link)
  }

  link.type = sanitizedLogoUrl.endsWith('.svg') || sanitizedLogoUrl.startsWith('data:image/svg+xml') ? 'image/svg+xml' : 'image/x-icon'
  link.href = sanitizedLogoUrl
}
