import { createApp } from 'vue'
import { createPinia } from 'pinia'
import i18n, { initI18n } from '../src/i18n'
import { initSkin } from '../src/composables/useSkin'
import ChartSkinPreview from './ChartSkinPreview.vue'
import '../src/style.css'
import '../src/styles/neubrutalism-skin.css'
import '../src/styles/neubrutalism-components.css'

initSkin()
await initI18n()
createApp(ChartSkinPreview).use(createPinia()).use(i18n).mount('#app')
