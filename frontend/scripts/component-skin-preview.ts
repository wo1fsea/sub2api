import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { createRouter, createWebHistory } from 'vue-router'
import i18n, { initI18n } from '../src/i18n'
import { initSkin } from '../src/composables/useSkin'
import ComponentSkinPreview from './ComponentSkinPreview.vue'
import '../src/style.css'
import '../src/styles/neubrutalism-skin.css'
import '../src/styles/neubrutalism-components.css'
import 'driver.js/dist/driver.css'
import '../src/styles/onboarding.css'

initSkin()
await initI18n()
const router = createRouter({ history: createWebHistory(), routes: [{ path: '/:pathMatch(.*)*', component: ComponentSkinPreview }, { path: '/legal/:documentId', name: 'LegalDocument', component: ComponentSkinPreview }] })
createApp(ComponentSkinPreview).use(createPinia()).use(i18n).use(router).mount('#app')
