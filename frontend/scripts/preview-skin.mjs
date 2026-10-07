import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ options: { port: { type: 'string', default: '18381' }, role: { type: 'string', default: 'admin' } } })
const port = Number(values.port)
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid preview port')
const root = fileURLToPath(new URL('../', import.meta.url))
const timestamp = '2026-10-02T08:00:00Z'
let webSearchFixture = { enabled: false, providers: [] }
const user = {
  id: 1, username: 'Preview Admin', email: 'preview@example.invalid', role: values.role === 'user' ? 'user' : 'admin',
  balance: 128.5, frozen_balance: 0, concurrency: 4, status: 'active', allowed_groups: [],
  balance_notify_enabled: false, balance_notify_threshold: null, balance_notify_extra_emails: [],
  subscriptions: [], created_at: timestamp, updated_at: timestamp, run_mode: 'standard'
}
const settings = {
  site_appearance: { skin: 'neubrutalism', mode: 'light', accent_color: '#d4ff3f' },
  site_name: 'Sub2API', site_logo: '', site_subtitle: 'AI API Gateway', api_base_url: '',
  contact_info: '', doc_url: '', home_content: '', compact_home_enabled: true,
  registration_enabled: false, email_verify_enabled: false, password_reset_enabled: false,
  registration_email_suffix_whitelist: [], turnstile_enabled: false, turnstile_site_key: '',
  promo_code_enabled: false, invitation_code_enabled: false, force_email_on_third_party_signup: false,
  payment_enabled: false, risk_control_enabled: false, subscription_enabled: false,
  channel_monitor_enabled: false, available_channels_enabled: false, model_plaza_enabled: false,
  plugin_management_enabled: false, affiliate_enabled: false, service_quota_enabled: false,
  linuxdo_oauth_enabled: false, wechat_oauth_enabled: false, oidc_oauth_enabled: false,
  github_oauth_enabled: false, google_oauth_enabled: false, backend_mode_enabled: false,
  custom_menu_items: [], custom_endpoints: [], table_default_page_size: 20,
  table_page_size_options: [20, 50, 100], ops_monitoring_enabled: false,
  ops_realtime_monitoring_enabled: false, version: 'skin-preview'
}
const stats = {
  total_users: 24, today_new_users: 2, active_users: 18, hourly_active_users: 8,
  stats_updated_at: timestamp, stats_stale: false, total_api_keys: 36, active_api_keys: 32,
  total_accounts: 12, normal_accounts: 11, error_accounts: 1, ratelimit_accounts: 0, overload_accounts: 0,
  total_requests: 82416, total_input_tokens: 3600000, total_output_tokens: 1900000,
  total_cache_creation_tokens: 280000, total_cache_read_tokens: 1200000, total_tokens: 6980000,
  total_cost: 426.8, total_actual_cost: 296.4, total_account_cost: 148.2,
  today_requests: 1842, today_input_tokens: 180000, today_output_tokens: 94000,
  today_cache_creation_tokens: 18000, today_cache_read_tokens: 60000, today_tokens: 352000,
  today_cost: 18.4, today_actual_cost: 12.8, today_account_cost: 6.4,
  average_duration_ms: 1260, uptime: 86400, rpm: 24, tpm: 4800
}
const emptyPage = { items: [], total: 0, page: 1, page_size: 20, pages: 1 }
const previewUsers = [
  user,
  { ...user, id: 2, username: 'Preview User', email: 'user@example.invalid', role: 'user', balance: 42.6 },
  { ...user, id: 3, username: 'Disabled User', email: 'disabled@example.invalid', role: 'user', status: 'disabled', balance: 0 }
].map(item => ({ ...item, notes: 'Synthetic preview record' }))
const sampleUsage = (date, factor) => ({
  date, requests: 150 * factor, input_tokens: 12000 * factor, output_tokens: 8000 * factor,
  cache_creation_tokens: 1200 * factor, cache_read_tokens: 2400 * factor,
  total_tokens: 23600 * factor, cost: factor, actual_cost: factor * 0.7
})
const fixtures = new Map([
  ['/setup/status', { needs_setup: false, step: 'complete' }],
  ['/api/v1/settings/public', settings],
  ['/api/v1/auth/me', user],
  ['/api/v1/admin/settings', settings],
  ['/api/v1/admin/payment/config', { enabled: false }],
  ['/api/v1/admin/system/version', { version: 'skin-preview' }],
  ['/api/v1/admin/system/check-updates', { current_version: 'skin-preview', latest_version: 'skin-preview', has_update: false }],
  ['/api/v1/admin/compliance', { required: false, version: 'preview' }],
  ['/api/v1/admin/dashboard/snapshot-v2', {
    stats,
    trend: [sampleUsage('2026-10-01', 6), sampleUsage('2026-10-02', 8)],
    models: ['claude-sonnet-4-6', 'gpt-5.4', 'gemini-3-pro', 'deepseek-v3']
      .map((model, index) => ({ model, ...sampleUsage('2026-10-02', 8 - index * 2), account_cost: 4.2 - index })),
    groups: []
  }],
  ['/api/v1/admin/dashboard/users-trend', {
    trend: previewUsers.flatMap((item, index) => [1, 2].map(day => ({
      date: `2026-10-0${day}`, user_id: item.id, username: item.username, email: item.email,
      requests: 10 * day, tokens: (4 - index) * day * 1000, cost: day, actual_cost: day * 0.7
    }))),
    users: previewUsers
  }],
  ['/api/v1/admin/dashboard/users-ranking', {
    ranking: previewUsers.map((item, index) => ({
      user_id: item.id, username: item.username, email: item.email,
      actual_cost: 3 - index, requests: (3 - index) * 100, tokens: (3 - index) * 1000
    })), total_actual_cost: 6, total_requests: 600, total_tokens: 6000
  }],
  ['/api/v1/announcements', []],
  ['/api/v1/keys', emptyPage],
  ['/api/v1/subscriptions/active', []],
  ['/api/v1/subscriptions/progress', []],
  ['/api/v1/admin/users', { ...emptyPage, items: previewUsers, total: previewUsers.length }],
  ['/api/v1/admin/groups', emptyPage],
  ['/api/v1/admin/accounts', emptyPage],
  ['/api/v1/admin/proxies', emptyPage]
])
fixtures.set('/api/v1/admin/dashboard/user-breakdown', { users: [] })
fixtures.set('/api/v1/admin/accounts/1/stats', {
  account_id: 1, account_name: 'Synthetic account', days: 30,
  summary: { total_cost: 12, total_user_cost: 18, total_standard_cost: 24, total_requests: 600, total_tokens: 240000,
    avg_daily_cost: .4, avg_daily_user_cost: .6, avg_daily_requests: 20, avg_daily_tokens: 8000, avg_duration_ms: 1200,
    actual_days_used: 30, days: 30,
    highest_cost_day: { date: '2026-10-02', label: '10/02', cost: 5, user_cost: 7, requests: 200 },
    highest_request_day: { date: '2026-10-02', label: '10/02', cost: 5, user_cost: 7, requests: 200 } },
  history: [1, 2, 3, 4, 5, 6].map(day => ({ label: `10/0${day}`, date: `2026-10-0${day}`, ...sampleUsage(`2026-10-0${day}`, day), user_cost: day })),
  models: [], endpoints: [], upstream_endpoints: [], endpoint_paths: []
})

const previewPlugin = {
  name: 'isolated-skin-preview',
  enforce: 'pre',
  configResolved(config) {
    // Never forward a preview request to a configured development or production backend.
    config.server.proxy = {}
  },
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const path = new URL(req.url, `http://127.0.0.1:${port}`).pathname
      if (path === '/__skin/charts' || path === '/__skin/components') {
        const entry = path.endsWith('components') ? 'component-skin-preview' : 'chart-skin-preview'
        server.transformIndexHtml(path, `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>样式预览</title></head><body><div id="app"></div><script type="module" src="/scripts/${entry}.ts"></script></body></html>`)
          .then(html => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html) })
          .catch(error => { res.statusCode = 500; res.end('Preview could not render'); console.error(error.message) })
        return
      }
      if (!/^\/(api|v1|setup)(\/|$)/.test(path)) return next()
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.setHeader('Cache-Control', 'no-store')
      const previewRole = req.headers.authorization === 'Bearer synthetic-user-preview' ? 'user' : user.role
      if (path.startsWith('/api/v1/admin/') && previewRole !== 'admin') {
        res.statusCode = 403
        res.end(JSON.stringify({ code: 403, message: 'Administrator required' }))
        return
      }
      if (path === '/api/v1/admin/settings/web-search-emulation' && ['GET', 'PUT'].includes(req.method) && previewRole === 'admin') {
        if (req.method === 'GET') { res.end(JSON.stringify({ code: 0, data: webSearchFixture })); return }
        let body = ''
        req.on('data', chunk => { body += chunk; if (body.length > 262144) req.destroy() })
        req.on('end', () => {
          try { webSearchFixture = JSON.parse(body); res.end(JSON.stringify({ code: 0, data: webSearchFixture })) }
          catch { res.statusCode = 400; res.end(JSON.stringify({ code: 400 })) }
        })
        return
      }
      // Only this in-memory fixture can change; production forwarding stays disabled.
      if (req.method === 'PUT' && path === '/api/v1/admin/settings' && user.role === 'admin') {
        let body = ''
        req.on('data', chunk => { body += chunk; if (body.length > 262144) req.destroy() })
        req.on('end', () => {
          try {
            const appearance = JSON.parse(body).site_appearance
            if (!['original', 'neubrutalism'].includes(appearance?.skin) || !['light', 'dark'].includes(appearance?.mode) || !/^#[\da-f]{6}$/i.test(appearance?.accent_color)) throw new Error('Invalid appearance')
            settings.site_appearance = appearance
            res.end(JSON.stringify({ code: 0, data: settings }))
          } catch { res.statusCode = 400; res.end(JSON.stringify({ code: 400, message: 'Invalid synthetic appearance' })) }
        })
        return
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.statusCode = 405
        res.end(JSON.stringify({ code: 405, message: 'Read-only synthetic preview', data: null }))
        return
      }
      const data = path === '/api/v1/auth/me' && previewRole === 'user' ? { ...user, role: 'user' } : fixtures.get(path)
      res.statusCode = data === undefined ? 404 : 200
      res.end(JSON.stringify({ code: data === undefined ? 404 : 0,
        message: data === undefined ? 'No preview fixture for this endpoint' : 'Synthetic preview', data: data ?? null }))
    })
  },
  transformIndexHtml: {
    order: 'post',
    handler(html) {
      const script = `<script>window.__APP_CONFIG__=${JSON.stringify(settings)};
        if(location.pathname==='/login'){localStorage.removeItem('auth_token');localStorage.removeItem('auth_user');}
        else{const u=${JSON.stringify(user)};if(new URLSearchParams(location.search).get('role')==='user')u.role='user';localStorage.setItem('auth_token',u.role==='user'?'synthetic-user-preview':'synthetic-preview-only');localStorage.setItem('auth_user',JSON.stringify(u));}
        localStorage.setItem('ops_monitoring_enabled_cached','false');
        localStorage.setItem('admin_guide_1_admin_v4_interactive','true');
        if(!localStorage.getItem('sub2api_locale'))localStorage.setItem('sub2api_locale','zh');</script>`
      return html.replace('</head>', `${script}<style>body{padding-top:30px}.sidebar{top:30px!important}.skin-app-header{top:30px!important}</style></head>`).replace('<body>',
        '<body><div style="height:30px;padding:6px 16px;background:#171813;color:#fffefa;font:12px/1.5 system-ui;position:fixed;top:0;left:0;right:0;z-index:60">本地演示 / Synthetic data / 主题设置仅存于演示内存</div>')
    }
  }
}

process.env.VITE_DEV_PROXY_TARGET = `http://127.0.0.1:${port}`
const server = await createServer({ root, plugins: [previewPlugin], server: {
  host: '127.0.0.1', port, strictPort: true
} })
await server.listen()
console.log(`Isolated skin preview (appearance writes are in memory only): http://127.0.0.1:${port}/admin/dashboard`)
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => { await server.close(); process.exit(0) })
}
