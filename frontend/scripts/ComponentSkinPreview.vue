<script setup lang="ts">
import { ref } from 'vue'
import { driver } from 'driver.js'
import AnnouncementPopup from '../src/components/common/AnnouncementPopup.vue'
import LoginAgreementPrompt from '../src/components/auth/LoginAgreementPrompt.vue'
import TotpLoginModal from '../src/components/auth/TotpLoginModal.vue'
import HelpTooltip from '../src/components/common/HelpTooltip.vue'
import Toast from '../src/components/common/Toast.vue'
import { useAppStore } from '../src/stores/app'
import { applySiteAppearance, useSkin } from '../src/composables/useSkin'
import { resolveBrandLogo } from '../src/utils/branding'
import RelayPulseMatrix from '../src/features/channel-monitor-v2/RelayPulseMatrix.vue'
import type { MonitorHealth, MonitorMetric } from '../src/api/channelMonitorV2'

const app = useAppStore()
const { appearance } = useSkin()
const open = ref('')
const announcement = { title: '上线公告 / Announcement', content: '## 清晰的灰度层级\n正文与 **重点**，少量荧光色用于操作。\n\n| 字段 | 数值 |\n| --- | --- |\n| 请求 | 42 |', created_at: '2026-10-07T08:00:00Z' }
const matrixMetric: MonitorMetric = {
  success_requests: 99, error_requests: 1, request_count: 100, token_count: 1000,
  rpm: 100, tpm: 1000, error_rate: .01, cache_rate: .6,
  cache_rate_numerator: 600, cache_rate_denominator: 1000,
  ttft: { sample_count: 100, p50_ms: 200, p95_ms: 500, avg_ms: 250 },
  duration: { sample_count: 100, p50_ms: 900, p95_ms: 1500, avg_ms: 1000 }
}
const matrixHealth: MonitorHealth = { overall: 'healthy', error_rate: 'healthy', ttft: 'healthy', cache: 'healthy', score: 100, minimum_sample: 20 }
const matrixCoverage = {
  requested_start: '2026-10-07T00:00:00Z', requested_end: '2026-10-07T00:12:00Z',
  coverage_start: '2026-10-07T00:00:00Z', data_through: '2026-10-07T00:12:00Z',
  computed_at: '2026-10-07T00:12:00Z', aggregation_lag_seconds: 0, coverage_complete: true, bucket_seconds: 60
}
const matrixRows = [{ platform: 'openai', group_id: 1, group_name: '斜线灰度', model: 'gpt-6-astra', metrics: matrixMetric, health: matrixHealth,
  buckets: Array.from({ length: 11 }, (_, index) => ({ bucket_start: `2026-10-07T00:${String(index).padStart(2, '0')}:00Z`, metrics: matrixMetric, health: { ...matrixHealth, score: index * 10 } })) }]
function tour() {
  driver({ popoverClass: 'theme-tour-popover', showProgress: true, steps: [{ element: '#preview-mark', popover: { title: '欢迎使用 Sub2API', description: '这是一段较长的首次登录引导说明，检查文字清晰度和操作按钮。' } }, { element: '#preview-controls', popover: { title: '站点主题', description: '管理员统一管理主题。' } }] }).drive()
}
</script>
<template>
  <main class="mx-auto max-w-4xl space-y-6 p-6">
    <div id="preview-mark" class="flex items-center gap-4"><img :src="resolveBrandLogo('')" alt="Sub2API" class="skin-brand-logo h-16 w-16" /><h1 class="text-2xl font-bold">组件覆盖预览</h1></div>
    <div id="preview-controls" class="flex flex-wrap gap-3">
      <button v-for="mode in ['light', 'dark'] as const" :key="mode" class="btn btn-secondary" @click="applySiteAppearance({ ...appearance, mode })">{{ mode }}</button>
      <button class="btn btn-secondary" @click="applySiteAppearance({ ...appearance, skin: appearance.skin === 'original' ? 'neubrutalism' : 'original' })">切换外观</button>
      <button class="btn btn-secondary" @click="tour">引导</button>
      <button class="btn btn-secondary" @click="open = 'announcement'">公告</button>
      <button class="btn btn-secondary" @click="open = 'agreement'">协议</button>
      <button class="btn btn-secondary" @click="open = 'totp'">二次验证</button>
      <button class="btn btn-secondary" @click="app.showToast('success', '主题设置已应用于所有用户')">通知</button>
      <HelpTooltip content="悬浮说明：清晰文字、细边框和硬阴影。" trigger="click"><template #trigger><button class="btn btn-secondary">提示</button></template></HelpTooltip>
    </div>
    <RelayPulseMatrix :rows="matrixRows" :coverage="matrixCoverage" health-mode="overall" />
    <AnnouncementPopup v-if="open === 'announcement'" :announcement="announcement" preview @close="open = ''" />
    <LoginAgreementPrompt :accepted="false" :documents="[{ id: 'terms', title: '服务条款' }, { id: 'privacy', title: '隐私政策' }]" mode="modal" :visible="open === 'agreement'" @open="open = 'agreement'" @accept="open = ''" @reject="open = ''" />
    <TotpLoginModal v-if="open === 'totp'" temp-token="synthetic" user-email-masked="p***@example.invalid" @cancel="open = ''" @success="open = ''" />
    <Toast />
  </main>
</template>
