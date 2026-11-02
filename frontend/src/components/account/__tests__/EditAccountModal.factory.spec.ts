import { defineComponent } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BUILTIN_PLATFORM_CATALOG, resetPlatformCatalog, setPlatformCatalog } from '@/constants/platformCatalog'

const { updateAccountMock } = vi.hoisted(() => ({ updateAccountMock: vi.fn() }))

vi.mock('@/stores/app', () => ({ useAppStore: () => ({ showError: vi.fn(), showSuccess: vi.fn(), showWarning: vi.fn(), showInfo: vi.fn() }) }))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ isSimpleMode: true }) }))
vi.mock('@/api/admin', () => ({
  adminAPI: {
    accounts: { update: updateAccountMock, checkMixedChannelRisk: vi.fn().mockResolvedValue({ has_risk: false }) },
    settings: {
      getWebSearchEmulationConfig: vi.fn().mockResolvedValue({ enabled: false, providers: [] }),
      getSettings: vi.fn().mockResolvedValue({})
    },
    tlsFingerprintProfiles: { list: vi.fn().mockResolvedValue([]) }
  }
}))
vi.mock('@/api/admin/accounts', () => ({ getAntigravityDefaultModelMapping: vi.fn().mockResolvedValue({}) }))
vi.mock('vue-i18n', async () => {
  const actual = await vi.importActual<typeof import('vue-i18n')>('vue-i18n')
  return { ...actual, useI18n: () => ({ t: (key: string) => key }) }
})

import EditAccountModal from '../EditAccountModal.vue'

const BaseDialogStub = defineComponent({
  name: 'BaseDialog',
  props: { show: { type: Boolean, default: false } },
  template: '<div v-if="show"><slot /><slot name="footer" /></div>'
})

function buildFactoryAccount() {
  return {
    id: 21,
    name: 'Factory key',
    notes: '',
    platform: 'factory',
    type: 'apikey',
    credentials: {
      region: 'eu',
      factory_org_id: 'org-old',
      model_mapping: { 'factory/claude-opus-5-5': 'claude-opus-5-5' }
    },
    credentials_status: { has_api_key: true },
    extra: {},
    proxy_id: null,
    concurrency: 1,
    priority: 1,
    rate_multiplier: 1,
    status: 'active',
    group_ids: [],
    expires_at: null,
    auto_pause_on_expired: false
  } as any
}

function mountModal(account = buildFactoryAccount()) {
  return mount(EditAccountModal, {
    props: { show: true, account, proxies: [], groups: [] },
    global: {
      stubs: {
        BaseDialog: BaseDialogStub,
        Select: true,
        Icon: true,
        PlatformIcon: true,
        ProxySelector: true,
        ProxyAdBanner: true,
        GroupSelector: true,
        ModelWhitelistSelector: true,
        QuotaLimitCard: true,
        GrokBaseUrlPresets: true,
        CnBaseUrlPresets: true,
        OpenCodeGoProtocolRulesEditor: true,
        HeaderOverrideEditor: true,
        UpstreamRequestIdHeaderField: true
      }
    }
  })
}

beforeEach(() => {
  const factorySpec = {
    id: 'factory',
    display_name: 'Factory',
    gateway: 'openai' as const,
    cn_provider: false,
    multi_protocol: {
      default_mode: 'standard',
      routing: 'by_model' as const,
      modes: [{ mode: 'standard', base_urls: { chat_completions: 'https://api.factory.ai', anthropic: 'https://api.factory.ai', responses: 'https://api.factory.ai' } }]
    }
  }
  setPlatformCatalog({
    ...BUILTIN_PLATFORM_CATALOG,
    platforms: [...BUILTIN_PLATFORM_CATALOG.platforms.filter((item) => item.id !== 'factory'), factorySpec]
  })
  updateAccountMock.mockReset().mockResolvedValue(buildFactoryAccount())
})

afterEach(() => resetPlatformCatalog())

describe('EditAccountModal Factory payload', () => {
  it('preserves region, Factory org and mapping while omitting a blank redacted key', async () => {
    const wrapper = mountModal()
    await flushPromises()

    expect(wrapper.find('[data-testid="factory-credentials"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="factory-region"]').element.value).toBe('eu')
    expect(wrapper.get<HTMLInputElement>('[data-testid="factory-org-id"]').element.value).toBe('org-old')
    expect(wrapper.get<HTMLInputElement>('[data-testid="factory-api-key"]').element.value).toBe('')
    expect(wrapper.find('[data-testid="api-key-base-url"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="edit-generic-account-mode"]').exists()).toBe(false)

    await wrapper.get('input[data-tour="edit-account-form-name"]').setValue('Factory key edited')
    await wrapper.get('form#edit-account-form').trigger('submit.prevent')
    await flushPromises()

    const payload = updateAccountMock.mock.calls[0]?.[1]
    expect(payload.credentials).toEqual({
      region: 'eu',
      factory_org_id: 'org-old',
      model_mapping: { 'factory/claude-opus-5-5': 'claude-opus-5-5' }
    })
    expect(payload.credentials).not.toHaveProperty('api_key')
    expect(payload.credentials).not.toHaveProperty('base_url')
    expect(payload.upstream_billing_probe_enabled).toBe(false)
    wrapper.unmount()
  })

  it('clears the Factory org and changes region without sending forbidden controls', async () => {
    const wrapper = mountModal()
    await flushPromises()

    await wrapper.get('[data-testid="factory-org-id"]').setValue('')
    await wrapper.get('[data-testid="factory-region"]').setValue('us')
    await wrapper.get('[data-testid="factory-remove-model-mapping"]').trigger('click')
    await wrapper.get('form#edit-account-form').trigger('submit.prevent')
    await flushPromises()

    const credentials = updateAccountMock.mock.calls[0]?.[1]?.credentials
    expect(credentials).toEqual({
      region: 'us',
      factory_org_id: '',
      model_mapping: {}
    })
    for (const forbidden of ['api_key', 'base_url', 'api_base_urls', 'api_protocol', 'protocol_rules', 'access_token', 'refresh_token']) {
      expect(credentials).not.toHaveProperty(forbidden)
    }
    wrapper.unmount()
  })

  it('hides unsupported billing sync controls and keeps the multiplier unlocked', async () => {
    const account = buildFactoryAccount()
    account.extra = {
      upstream_billing_probe_enabled: true,
      upstream_billing_rate_sync_enabled: true
    }
    const wrapper = mountModal(account)
    await flushPromises()

    expect(wrapper.find('[data-testid="upstream-billing-rate-sync"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="upstream-billing-auto-probe"]').exists()).toBe(false)
    expect(wrapper.get<HTMLInputElement>('[data-testid="account-rate-multiplier"]').element.disabled).toBe(false)

    await wrapper.get('form#edit-account-form').trigger('submit.prevent')
    await flushPromises()
    const payload = updateAccountMock.mock.calls[0]?.[1]
    expect(payload.upstream_billing_probe_enabled).toBe(false)
    expect(payload.upstream_billing_rate_sync_enabled).toBe(false)
    expect(payload).toHaveProperty('rate_multiplier')
    wrapper.unmount()
  })
})
