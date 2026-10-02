<template>
  <button
    type="button"
    class="skin-switcher flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-gray-200 bg-white text-gray-700 transition-colors hover:bg-gray-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500 dark:border-dark-700 dark:bg-dark-800 dark:text-gray-200 dark:hover:bg-dark-700"
    :aria-label="t('common.clashSkin')"
    :aria-pressed="skin === 'clash'"
    :title="skin === 'clash' ? t('common.useOriginalSkin') : t('common.useClashSkin')"
    @click="setSkin(skin === 'clash' ? 'original' : 'clash')"
  >
    <Icon name="sparkles" size="sm" />
  </button>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import Icon from '@/components/icons/Icon.vue'
import { useSkin } from '@/composables/useSkin'

const { t } = useI18n()
const { skin, setSkin } = useSkin()
</script>
