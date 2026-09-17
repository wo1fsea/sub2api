# Cursor integration: code-stage review

## Scope

Local branch: `feature/cursor-upstream-pool`.
Merge parents: main `efe9aab1e4ec89a42ba45e8dac20e882c5409a6a` and vendor Cursor PR #6289 `db6e5884f980384384de932dacbac28d36b4d6bd`.
No additional PR #7121 integration was performed. This is a local integration checkpoint, **not production or live OAuth/E2E acceptance**.

## Review and corrections

- Preserved declared MCP tool-call frames after sending the upstream external-handoff acknowledgement. The downstream caller now receives the call ID/name and can execute the tool; unknown tools still receive rejection. Existing history replay pairs tool results by call ID.
- Stream consumers now report frame-read and callback failures instead of silently succeeding. Added regression coverage for partial headers, missing/partial payloads, and consumer failure.
- Review reproduced a remaining bug: `errors.Is(err, io.EOF)` accepted a wrapped EOF for a completely missing payload. The byte-5 truncation regression failed before changing the check to exact `io.EOF`, then passed.
- Updated pinned-model route test constructor arguments for the Cursor service dependency.
- Resolved the ChannelMonitor test conflict using current main behavior (10 providers); its resolved contents equal main and need no net diff.
- Completed the GroupsView test API mock for model-allowlist candidates and removed a trailing whitespace issue.
- Added-line credential/eval/shell/deserialization scan found only the harmless endpoint constant `EndpointToken = "/oauth/token"`. This narrow scan is not a comprehensive security audit.

## Executed verification

All commands below passed unless explicitly noted. Commands ran only in this worktree; test timeouts were bounded.

### Backend (from `backend/`)

```sh
go test -timeout 60s ./internal/pkg/cursor -skip '^TestE2E'
go test -race -timeout 60s ./internal/pkg/cursor -skip '^TestE2E'
go test -timeout 60s ./internal/service ./internal/handler ./internal/handler/admin ./internal/server/routes ./internal/server/middleware -run 'Cursor|GatewayRoutes|GatewayModels|AvailableModels|GroupHandler.*Platform|Endpoint|CORS|UpstreamModels'
go test -timeout 60s -tags unit ./internal/service ./internal/handler ./internal/handler/admin ./internal/server/routes ./internal/server/middleware -run 'Cursor|GatewayRoutes|GatewayModels|AvailableModels|GroupHandler.*Platform|Endpoint|CORS|UpstreamModels'
go test -timeout 60s -tags unit ./migrations
go build ./cmd/server
go build -tags embed ./cmd/server
```

Both focused backend selections passed in all five packages. Migration tests are source/contract checks, not application against a running database. Cursor tests use synthetic protocol frames, mock transports, and local test servers; service tests named `e2e` do not establish real upstream compatibility. Real Cursor `TestE2E*` tests were explicitly excluded, without reading credentials.

### Frontend (from `frontend/`)

Using `corepack pnpm@10.11.0`:

- Focused Vitest selection: **9 files, 110 tests passed**: CreateAccountModal.cursor, EditAccountModal.cursor, ModelWhitelistSelector, credentialsBuilder, PlatformTypeBadge.grok, useModelWhitelist, platforms, ChannelMonitorView.grok, GroupsView.codexManifest.
- After correcting its missing mock, GroupsView.codexManifest was rerun separately: **1 test passed**, without the earlier API-mock stderr errors.
- `typecheck` and `lint:check`: passed again after the final test edit.
- `run check:i18n`: **3 tests passed**.
- `exec vue-tsc -b` and `exec vite build`: passed; Vite built 1046 modules and generated local `backend/internal/web/dist` assets.
- The package `build` script initially failed because its nested bare `pnpm` was absent from PATH. The exact build stages above were subsequently invoked through Corepack and all passed. No package-manager configuration was changed.
- Nonfatal build warnings: stale Browserslist data, mixed dynamic/static imports, and chunks over 500 kB.

## Remaining limits / follow-up

- No real login, OAuth refresh, live model discovery, real tool round trip, deployed billing/failover or production acceptance was attempted. No Docker app was started, no production checkout or secret store was accessed, and no push/GitHub write was performed.
- No full backend/frontend suite, database integration suite, load test, or exhaustive independent security review. No additional reviewer agent was started, as requested. Baseline stash testing was deliberately avoided during the in-progress merge.
- Protocol hardening remains: clean frame-boundary EOF is still accepted without a terminal event; compressed-frame decompression has no separate expanded-size cap; upstream reply writes and some gateway SSE writes ignore write errors. The callback-error regression does not prove every production writer returns errors. These inherited paths need a dedicated hardening pass before production acceptance.
- Forced/named `tool_choice` is not enforced; object forms currently normalize to automatic tool choice. Provider-hosted tools are filtered out rather than executed. Treat these as compatibility limitations, not full OpenAI tool semantics.
- The imported npm lockfile root dependencies match `package.json`; npm installation/reproducibility was not tested (verification used the existing pnpm dependencies).

The focused code-stage checks are green. The local merge is suitable as a review checkpoint, not a claim of complete upstream compatibility or deployment readiness.
