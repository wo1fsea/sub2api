import { readonly, ref } from 'vue'

export type Skin = 'original' | 'clash'
export const SKIN_STORAGE_KEY = 'sub2api.skin'
const currentSkin = ref<Skin>('clash')

function normalizeSkin(value: string | null): Skin {
  if (value === null || value === 'clash') return 'clash'
  return 'original'
}

function applySkin(skin: Skin) {
  currentSkin.value = skin
  document.documentElement.dataset.skin = skin
}

export function setSkin(skin: Skin) {
  applySkin(normalizeSkin(skin))
  try {
    localStorage.setItem(SKIN_STORAGE_KEY, currentSkin.value)
  } catch {
    // The active skin still works when browser storage is unavailable.
  }
}

function syncSkin(event: StorageEvent) {
  if (event.storageArea && event.storageArea !== localStorage) return
  if (event.key === SKIN_STORAGE_KEY || event.key === null) {
    applySkin(normalizeSkin(event.newValue))
  }
}

export function initSkin() {
  let savedSkin: string | null = null
  try {
    savedSkin = localStorage.getItem(SKIN_STORAGE_KEY)
  } catch {
    // Use the default skin without blocking bootstrap.
  }
  applySkin(normalizeSkin(savedSkin))
  window.removeEventListener('storage', syncSkin)
  window.addEventListener('storage', syncSkin)
}

export function useSkin() {
  return { skin: readonly(currentSkin), setSkin }
}
