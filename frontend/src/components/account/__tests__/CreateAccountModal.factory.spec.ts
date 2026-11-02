import { defineComponent } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BUILTIN_PLATFORM_CATALOG, resetPlatformCatalog, setPlatformCatalog, supportsUpstreamModelSync } from '@/constants/platformCatalog'
import { FACTORY_PUBLIC_MODEL_IDS } from '../factory'
import { getModelsByPlatform } from '@/composables/useModelWhitelist'

const { createAccountMock, syncUpstreamModelsMock } = vi.hoisted(() => ({
  createAccountMock: vi.fn(),
  syncUpstreamModelsMock: vi.fn()
}))

vi.mock('@/stores/app', () => ({ useAppStore: () => ({ showError: vi.fn(), showSuccess: vi.fn(), showWarning: vi.fn(), showInfo: vi.fn() }) }))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ isSimpleMode: true }) }))
vi.mock('@/api/admin', () => ({
  adminAPI: {
    accounts: {
      create: createAccountMock,
      syncUpstreamModels: syncUpstreamModelsMock,
      checkMixedChannelRisk: vi.fn().mockResolvedValue({ has_risk: false })
    },
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

import CreateAccountModal from '../CreateAccountModal.vue'

const BaseDialogStub = defineComponent({
  name: 'BaseDialog',
  props: { show: { type: Boolean, default: false } },
  template: '<div v-if="show"><slot /><slot name="footer" /></div>'
})

const QuotaLimitCardStub = defineComponent({
  name: 'QuotaLimitCard',
  emits: [
    'update:totalLimit', 'update:dailyLimit', 'update:weeklyLimit',
    'update:dailyResetMode', 'update:dailyResetHour', 'update:weeklyResetMode',
    'update:weeklyResetDay', 'update:weeklyResetHour', 'update:resetTimezone',
    'update:quotaNotifyDailyEnabled', 'update:quotaNotifyDailyThreshold',
    'update:quotaNotifyDailyThresholdType', 'update:quotaNotifyWeeklyEnabled',
    'update:quotaNotifyWeeklyThreshold', 'update:quotaNotifyWeeklyThresholdType',
    'update:quotaNotifyTotalEnabled', 'update:quotaNotifyTotalThreshold',
    'update:quotaNotifyTotalThresholdType'
  ],
  methods: {
    applyQuota() {
      this.$emit('update:totalLimit', 100)
      this.$emit('update:dailyLimit', 20)
      this.$emit('update:weeklyLimit', 50)
      this.$emit('update:dailyResetMode', 'fixed')
      this.$emit('update:dailyResetHour', 3)
      this.$emit('update:weeklyResetMode', 'fixed')
      this.$emit('update:weeklyResetDay', 2)
      this.$emit('update:weeklyResetHour', 4)
      this.$emit('update:resetTimezone', 'Asia/Shanghai')
      this.$emit('update:quotaNotifyDailyEnabled', true)
      this.$emit('update:quotaNotifyDailyThreshold', 80)
      this.$emit('update:quotaNotifyDailyThresholdType', 'percentage')
      this.$emit('update:quotaNotifyWeeklyEnabled', true)
      this.$emit('update:quotaNotifyWeeklyThreshold', 70)
      this.$emit('update:quotaNotifyWeeklyThresholdType', 'fixed')
      this.$emit('update:quotaNotifyTotalEnabled', true)
      this.$emit('update:quotaNotifyTotalThreshold', 60)
      this.$emit('update:quotaNotifyTotalThresholdType', 'percentage')
    }
  },
  template: '<button data-testid="factory-quota" @click="applyQuota">quota</button>'
})

const factoryProfile = {
  default_mode: 'standard',
  routing: 'by_model' as const,
  modes: [{ mode: 'standard', base_urls: { chat_completions: 'https://api.factory.ai', anthropic: 'https://api.factory.ai', responses: 'https://api.factory.ai' } }]
}

function mountModal() {
  return mount(CreateAccountModal, {
    props: { show: true, proxies: [], groups: [] },
    global: {
      stubs: {
        BaseDialog: BaseDialogStub,
        OAuthAuthorizationFlow: true,
        ConfirmDialog: true,
        Select: true,
        Icon: true,
        PlatformIcon: true,
        ProxySelector: true,
        ProxyAdBanner: true,
        GroupSelector: true,
        ModelWhitelistSelector: true,
        QuotaLimitCard: QuotaLimitCardStub,
        GrokBaseUrlPresets: true,
        CnBaseUrlPresets: true,
        OpenCodeGoProtocolRulesEditor: true,
        HeaderOverrideEditor: true
      }
    }
  })
}

beforeEach(() => {
  createAccountMock.mockReset().mockResolvedValue({ id: 11, platform: 'factory', type: 'apikey' })
  syncUpstreamModelsMock.mockReset().mockResolvedValue({ models: [], warnings: [] })
  setPlatformCatalog({
    ...BUILTIN_PLATFORM_CATALOG,
    platforms: [
      ...BUILTIN_PLATFORM_CATALOG.platforms.filter((item) => item.id !== 'factory'),
      { id: 'factory', display_name: 'Factory', gateway: 'openai', cn_provider: false, multi_protocol: factoryProfile }
    ]
  })
})

afterEach(() => resetPlatformCatalog())

describe('Factory model catalog', () => {
  it('exposes public native IDs and excludes Gemini, Fast and auto', () => {
    expect(FACTORY_PUBLIC_MODEL_IDS).toContain('factory/claude-opus-5-5')
    expect(FACTORY_PUBLIC_MODEL_IDS).toContain('factory/gpt-6.1-sol')
    expect(FACTORY_PUBLIC_MODEL_IDS).toContain('factory/glm-5.3')
    expect(FACTORY_PUBLIC_MODEL_IDS.some((id) => id.endsWith('-fast'))).toBe(false)
    expect(FACTORY_PUBLIC_MODEL_IDS).not.toContain('factory/auto')
    expect(FACTORY_PUBLIC_MODEL_IDS).not.toContain('factory/gemini-4-argon')
    expect(getModelsByPlatform('factory')).toEqual(FACTORY_PUBLIC_MODEL_IDS)
    expect(supportsUpstreamModelSync('factory')).toBe(false)
  })
})

describe('CreateAccountModal Factory payload', () => {
  it('defaults region to us and omits an empty optional Factory org', async () => {
    const wrapper = mountModal()
    await wrapper.get('[data-testid="platform-button-factory"]').trigger('click')
    await flushPromises()
    await wrapper.get('input[data-tour="account-form-name"]').setValue('Factory default')
    await wrapper.get('form#create-account-form input[type="password"]').setValue('fk-default')
    await wrapper.get('form#create-account-form').trigger('submit.prevent')
    await flushPromises()

    expect(createAccountMock.mock.calls[0]?.[0]?.credentials).toEqual({
      api_key: 'fk-default',
      region: 'us',
      factory_org_id: '',
      model_mapping: {}
    })
    wrapper.unmount()
  })

  it('creates fixed credentials with EU region, Factory org and explicit public mapping', async () => {
    const wrapper = mountModal()
    await wrapper.get('[data-testid="platform-button-factory"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="factory-account-type"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="factory-credentials"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="factory-region"]').element.value).toBe('us')
    expect(wrapper.find('[data-testid="api-key-base-url"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="cn-adaptive-base-url-chat_completions"]').exists()).toBe(false)

    await wrapper.get('input[data-tour="account-form-name"]').setValue('Factory key')
    await wrapper.get('form#create-account-form input[type="password"]').setValue('fk-test')
    await wrapper.get('[data-testid="factory-region"]').setValue('eu')
    await wrapper.get('[data-testid="factory-org-id"]').setValue(' org-factory-123 ')
    const preset = wrapper.findAll('button').find((button) => button.text().includes('Opus 5.5'))
    expect(preset).toBeDefined()
    await preset?.trigger('click')

    await wrapper.get('form#create-account-form').trigger('submit.prevent')
    await flushPromises()

    const payload = createAccountMock.mock.calls[0]?.[0]
    expect(payload.platform).toBe('factory')
    expect(payload.type).toBe('apikey')
    expect(payload.credentials).toEqual({
      api_key: 'fk-test',
      region: 'eu',
      factory_org_id: 'org-factory-123',
      model_mapping: { 'factory/claude-opus-5-5': 'claude-opus-5-5' }
    })
    expect(payload.upstream_billing_probe_enabled).toBe(false)
    expect(syncUpstreamModelsMock).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})

describe('CreateAccountModal Factory quota payload', () => {
  it('serializes all visible quota limits, reset and notify fields into extra', async () => {
    const wrapper = mountModal()
    await wrapper.get('[data-testid="platform-button-factory"]').trigger('click')
    await flushPromises()
    await wrapper.get('input[data-tour="account-form-name"]').setValue('Factory quota')
    await wrapper.get('form#create-account-form input[type="password"]').setValue('fk-quota')
    await wrapper.get('[data-testid="factory-quota"]').trigger('click')
    await wrapper.get('form#create-account-form').trigger('submit.prevent')
    await flushPromises()

    const payload = createAccountMock.mock.calls[0]?.[0]
    expect(payload.credentials).toEqual({
      api_key: 'fk-quota',
      region: 'us',
      factory_org_id: '',
      model_mapping: {}
    })
    expect(payload.extra).toEqual({
      quota_limit: 100,
      quota_daily_limit: 20,
      quota_weekly_limit: 50,
      quota_daily_reset_mode: 'fixed',
      quota_daily_reset_hour: 3,
      quota_weekly_reset_mode: 'fixed',
      quota_weekly_reset_day: 2,
      quota_weekly_reset_hour: 4,
      quota_reset_timezone: 'Asia/Shanghai',
      quota_notify_daily_enabled: true,
      quota_notify_daily_threshold: 80,
      quota_notify_daily_threshold_type: 'percentage',
      quota_notify_weekly_enabled: true,
      quota_notify_weekly_threshold: 70,
      quota_notify_weekly_threshold_type: 'fixed',
      quota_notify_total_enabled: true,
      quota_notify_total_threshold: 60,
      quota_notify_total_threshold_type: 'percentage'
    })
    expect(payload.upstream_billing_probe_enabled).toBe(false)
    wrapper.unmount()
  })
})

describe('CreateAccountModal Factory platform switch', () => {
  it('clears stale temp-unschedulable state and never serializes it for Factory', async () => {
    const wrapper = mountModal()
    const openAI = wrapper.findAll('button').find((button) => button.text().trim() === 'OpenAI')
    expect(openAI).toBeDefined()
    await openAI?.trigger('click')
    await flushPromises()
    const apiKey = wrapper.findAll('button').find((button) => button.text().includes('API Key'))
    expect(apiKey).toBeDefined()
    await apiKey?.trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="temp-unsched-section"]').exists()).toBe(true)
    await wrapper.get('[data-testid="temp-unsched-toggle"]').trigger('click')
    expect(wrapper.get('[data-testid="temp-unsched-toggle"]').attributes('aria-pressed')).toBe('true')

    await wrapper.get('[data-testid="platform-button-factory"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="temp-unsched-section"]').exists()).toBe(false)

    await openAI?.trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="temp-unsched-toggle"]').attributes('aria-pressed')).toBe('false')

    await wrapper.get('[data-testid="platform-button-factory"]').trigger('click')
    await flushPromises()
    await wrapper.get('input[data-tour="account-form-name"]').setValue('Factory switch')
    await wrapper.get('form#create-account-form input[type="password"]').setValue('fk-switch')
    await wrapper.get('form#create-account-form').trigger('submit.prevent')
    await flushPromises()

    const payload = createAccountMock.mock.calls[0]?.[0]
    expect(payload.credentials).toEqual({
      api_key: 'fk-switch',
      region: 'us',
      factory_org_id: '',
      model_mapping: {}
    })
    expect(payload.credentials).not.toHaveProperty('temp_unschedulable_enabled')
    expect(payload.credentials).not.toHaveProperty('temp_unschedulable_rules')
    wrapper.unmount()
  })
})
