export const FACTORY_PUBLIC_MODEL_PREFIX = 'factory/' as const

export const FACTORY_REGIONS = ['us', 'eu'] as const
export type FactoryRegion = (typeof FACTORY_REGIONS)[number]

export const FACTORY_REGION_ENDPOINTS: Record<FactoryRegion, string> = {
  us: 'https://api.factory.ai',
  eu: 'https://api.eu.factory.ai'
}

export type FactoryModelProtocol = 'messages' | 'responses' | 'chat_completions'

/**
 * Claude-only Factory catalog, including Fable. Keep this aligned with the
 * backend finite registry; non-Claude models, Fast Mode and auto are excluded.
 */
export const FACTORY_MODELS = [
  { id: 'claude-fable-5.1', label: 'Fable 5.1', protocol: 'messages' },
  { id: 'claude-fable-5', label: 'Fable 5', protocol: 'messages' },
  { id: 'claude-opus-5-5', label: 'Opus 5.5', protocol: 'messages' },
  { id: 'claude-opus-5', label: 'Opus 5', protocol: 'messages' },
  { id: 'claude-opus-4-8', label: 'Opus 4.8', protocol: 'messages' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', protocol: 'messages' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5', protocol: 'messages' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', protocol: 'messages' },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5', protocol: 'messages' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', protocol: 'messages' },
] as const

export type FactoryModel = (typeof FACTORY_MODELS)[number]
export type FactoryNativeModelId = FactoryModel['id']

export function factoryPublicModelId(nativeId: string): string {
  return `${FACTORY_PUBLIC_MODEL_PREFIX}${nativeId}`
}

export const FACTORY_PUBLIC_MODEL_IDS: string[] = FACTORY_MODELS.map(model => factoryPublicModelId(model.id))

export const FACTORY_MODEL_PRESET_MAPPINGS = FACTORY_MODELS.map(model => ({
  label: model.label,
  from: factoryPublicModelId(model.id),
  to: model.id,
  color: 'bg-cyan-100 text-cyan-700 hover:bg-cyan-200 dark:bg-cyan-900/30 dark:text-cyan-400'
}))

/** Normalize persisted region values; unknown values safely fall back to `us`. */
export function normalizeFactoryRegion(value: unknown): FactoryRegion {
  return value === 'eu' ? 'eu' : 'us'
}

export function normalizeFactoryOrgId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Build the exact Factory credentials object. Do not add generic base URL,
 * protocol, OAuth or provider-routing fields here: the backend rejects them.
 *
 * A blank API key is omitted so the backend preserves the existing secret.
 * Other Factory fields use partial-update semantics, so an empty
 * factory_org_id or model_mapping is serialized explicitly to clear a value.
 */
export function buildFactoryCredentials(input: {
  apiKey?: string | null
  region: unknown
  factoryOrgId?: string | null
  modelMapping?: Record<string, string> | null
}): Record<string, unknown> {
  const credentials: Record<string, unknown> = {
    region: normalizeFactoryRegion(input.region)
  }
  const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : ''
  if (apiKey) credentials.api_key = apiKey
  credentials.factory_org_id = normalizeFactoryOrgId(input.factoryOrgId)
  credentials.model_mapping =
    input.modelMapping && Object.keys(input.modelMapping).length > 0
      ? { ...input.modelMapping }
      : {}
  return credentials
}
