# Factory Upstream Operator Guide

Factory (Droid) accounts are an API-key-only upstream for this fork. The
integration reuses the existing OpenAI gateway family for inbound routing,
conversion, scheduling, billing, and error handling, but sends Factory traffic
through a dedicated bounded adapter. There is no generic vendor fallback for a
Factory account.

This guide is written from the protocol contract in `NOTES.md` and community
reference evidence. Factory's Droid API is not a stable public API. The
implementation is intentionally fail-closed: model, region, protocol, host, and
credential shapes not recognized locally are rejected before an outbound
request is built. A passing mock test does not establish that an account is
entitled to a model, that Factory will serve it, or that live inference works.

## Create or edit an account

Use **Accounts → Create Account** (or edit an existing account) with:

| Field | Required | Value / meaning |
| --- | --- | --- |
| Platform | Yes | `factory` |
| Account type | Yes | API key (`apikey`); OAuth/cookie account types are not supported |
| API key | On create | Factory API key matching `fk-[A-Za-z0-9_-]+`. It is sent as a bearer token and is never refreshed. On edit, leave the key blank or omit it to retain the existing secret; the UI/API must not overwrite it with an empty value. |
| Region | Yes | `us` (default) or `eu`. This selects only the official host: `https://api.factory.ai` or `https://api.eu.factory.ai`. |
| Factory org ID | No | The Factory active organization ID (`factory_org_id`) matching `[A-Za-z0-9_-]+`, not a WorkOS organization ID. Omit it for the normal key-only account. When set, it is sent as `X-Factory-Org-Id`; the adapter never guesses or discovers an org for a key. |
| Model mapping | No | Existing admin model-mapping syntax, `alias -> exact native or public factory registry ID`. Public aliases may map to any supported finite-registry target; the effective target is validated and its protocol/provider comes from the registry. |

On edit, omitted fields preserve their current values. Omitting
`factory_org_id` or `model_mapping` keeps the existing org/mapping; explicitly
sending `factory_org_id: ""` clears the org and `model_mapping: {}` clears the
mapping. The UI uses those explicit empty values for deliberate clears. An
omitted or blank `api_key` preserves the existing secret.

Do not add a base URL, protocol mode, endpoint override, OAuth refresh token,
or custom headers to Factory credentials. Those fields are rejected for
Factory accounts. The API key is secret: read APIs redact it, and operators
should treat any surfaced key as compromised and rotate it in Factory.

Place the account in a native Factory group or in an explicitly routed
composite group. Factory accounts are not interchangeable with OpenAI accounts:
the `factory` platform selects the dedicated adapter and the finite Factory
registry.

## Connection test: authentication-only whoami

The account connection test is an authentication probe, not an inference
test. It calls the fixed `GET /api/cli/whoami` endpoint on the selected
official region host with:

- `Authorization: Bearer <fk-key>`
- `X-Factory-Whoami-Extended: true`
- `X-Factory-Org-Id: <configured org>` only when the account explicitly sets
  one

The probe uses a bounded timeout, does not follow redirects to arbitrary hosts,
does not use a vendor fallback, and does not expose the full response document
or the key in errors. The adapter uses only bounded whoami metadata. The
operator does not need to supply or record an email address or user ID for the
account test.

Region interpretation follows the observed whoami shape:

- An `inferenceRegion` value of `global` maps to the US region; `eu` maps to
  the EU region. Legacy `region: "us"` / `"eu"` remains a fallback when
  `inferenceRegion` is absent. Contradictory region fields are rejected
  instead of guessed.
- `isEnterprise: true` is unsupported. A non-enterprise account may report the
  official hint `premBaseHostV2: "https://prem.factory.ai"`; this is normal
  account metadata, not an enterprise host and not a routing destination. Any
  other custom prem host is unsupported.
- The adapter never follows a host named by whoami. Inference continues to use
  only the selected official `api.factory.ai` or `api.eu.factory.ai` host.

What a successful probe means:

- Factory accepted the key (or the key with the explicitly configured org).
- The configured region and org are usable for the probe.
- An operator gets actionable metadata to distinguish a bad key, an
  inaccessible org, and an unsupported enterprise host/region.

What it does **not** mean:

- It does not prove model entitlement, available credits, routing
  compatibility, or successful inference.
- It does not enable generic `/models` discovery or model synchronization.
- It does not authorize following a whoami-provided host. Only the selected
  official US/EU host is used. On-prem/enterprise hosts are unsupported and
  must produce an actionable error rather than silently claiming inference
  readiness.

## Droid inference route matrix

Only the following three outbound inference routes are supported. The inbound
protocol may differ and is converted by the existing gateway; the final
Factory request must use the exact route selected by the finite registry.

| Registry protocol | Factory inference route | Droid wire shape | Model examples |
| --- | --- | --- | --- |
| `anthropic` | `POST /api/llm/a/v1/messages` | Anthropic Messages | Claude entries and MiniMax M2.7 |
| `responses` | `POST /api/llm/o/v1/responses` | OpenAI Responses | GPT and Grok entries |
| `chat_completions` | `POST /api/llm/o/v1/chat/completions` | OpenAI Chat Completions | GLM, Kimi, DeepSeek, Qwen, MiniMax M3, and Mistral entries |

The route prefix is fixed by the protocol: Anthropic uses `/api/llm/a/v1`;
Responses and Chat Completions use `/api/llm/o/v1`. The final adapter fixes the
regional authority, path, provider metadata, model, and authentication after
shared gateway transformations. Caller-supplied destination, protocol, auth,
org, provider-routing, or header overrides are removed rather than honored.

Every outbound request carries the Factory API key as
`Authorization: Bearer ...`, Droid client/version and user-agent markers, the
registry's provider selection, routing source, and generated session/message
identifiers. Anthropic-wire requests carry the observed placeholder
`X-Api-Key` alongside bearer auth; OpenAI-provider requests carry the observed
`OpenAI-Platform` marker. The exact constants, including the pinned client
version, live in
[`backend/internal/pkg/factory/registry.go`](../backend/internal/pkg/factory/registry.go).

The adapter adds only the minimal idempotent Droid system preamble and does not
broadly rewrite caller content. Existing gateway conversions are still
responsible for preserving representable tool, image, usage, streaming, and
reasoning semantics. Mock acceptance covers selected same-protocol and
cross-protocol tool/usage cases; it does not claim that every possible
cross-protocol construct is supported.

## Public model naming, groups, and composite routing

Public Factory model names use the namespace:

```text
factory/<native-factory-model-id>
```

For example, `factory/gpt-5.5` identifies the native registry entry
`gpt-5.5`, while the registry supplies the authoritative protocol
(`responses`) and provider metadata. Public aliases may map to any supported
native registry ID; the important invariant is that the effective native
target validates against the finite registry and the wire protocol/provider
comes from that registry rather than from the alias spelling. Unknown native
targets fail locally rather than being guessed or tried on a generic endpoint.

The authoritative bounded model list and each entry's protocol, provider,
context/output metadata, reasoning efforts, and image support are in
[`backend/internal/pkg/factory/registry.go`](../backend/internal/pkg/factory/registry.go).
This guide intentionally does not duplicate that table, which must remain in
sync with the implementation and its generator/parity tests.

A native Factory group should expose canonical Factory names through its model
allowlist/mapping and must not fall back to every model when the mapping is
absent or empty. For a composite group, use an explicit route so that
`factory` is selected only when intended:

| Field | Example |
| --- | --- |
| `public_model` | `factory/gpt-5.5` |
| `match_type` | `exact` |
| `target_platform` | `factory` |
| `upstream_model` | `gpt-5.5` |
| `endpoint` | `responses` |
| `priority` | `10` |
| `enabled` | `true` |

The public model remains the client-facing name and reporting identity; the
route resolves the concrete Factory account and native upstream model. For
Chat Completions entries use the matching endpoint and protocol supplied by the
registry; do not infer the route from the model's vendor-looking prefix.
Configure channel pricing and allowlists for the concrete `factory` entries.
Factory credit multipliers are not USD prices and must not be imported as
pricing.

## Explicitly unsupported

The following fail closed. They are not silently downgraded, remapped, or sent
to another provider:

- **WorkOS/device login and token refresh.** Factory accounts require an
  `fk-` API key. OAuth, cookie auth, device flow, refresh concurrency, and
  WorkOS organization discovery are deferred.
- **Gemini generate.** The distinct `/api/llm/g/v1/generate` adapter is not
  implemented in this scope. Gemini IDs, including gated Gemini entries, are
  excluded from the registry and rejected locally.
- **Fast Mode and fast intent.** Fast variant IDs, `auto`, gated high-cost
  opt-ins, `speed: "fast"`, Responses `service_tier: "priority"`, and the
  `anthropic-beta: fast-mode-2026-02-01` token are not supported. Original
  intent is rejected even when a cross-protocol conversion would otherwise
  drop the field; it is never silently served at standard speed or billed as a
  different route.
- **On-prem/enterprise hosts and arbitrary hosts.** Only the two official
  regional hosts are permitted. `premBaseHostV2`, enterprise/custom base URLs,
  redirects, caller-supplied endpoints, and SSRF-style host changes are not
  followed.
- **Generic discovery/fallback.** `/models` synchronization, unknown-model
  protocol guessing, provider fallback, and unlisted response subpaths such as
  compaction, WebSocket/live, or vendor-specific endpoints are outside the
  supported inference contract unless explicitly implemented and tested.

## Mock-only verification

Acceptance evidence for this integration is mock/transport-level by default.
Do not put a live Factory key, database, Redis, container, or production host
in the test environment. Unit-tagged tests use local fakes/recording
transports and must assert zero outbound calls for rejected cases.

Current repository-level checks:

```sh
cd backend
go test -tags=unit ./...

cd ../frontend
corepack pnpm@9.15.9 install --frozen-lockfile
corepack pnpm@9.15.9 run typecheck
corepack pnpm@9.15.9 run lint:check
corepack pnpm@9.15.9 exec vitest run
```

Focused Factory backend commands:

```sh
cd backend
go test -tags=unit ./internal/service ./internal/pkg/factory ./internal/handler/dto ./internal/domain
```

No live inference, model discovery, migration, Docker/Compose, or production
service is required for these checks. A test run must record the exact commit,
commands, and results; mocks passing while implementation files are still
changing is not final acceptance.

## Authorized live smoke (key-gated local diagnostic)

`TestFactoryLiveSmoke` is skipped unless `FACTORY_LIVE_KEY_FILE` is set. It is
a deliberately gated local-fork diagnostic, not part of default mock
acceptance. An authorized run has already been completed; do not make new live
calls without a newly authorized key. It uses in-memory `service.Account`
values and a real `net/http` implementation of the `HTTPUpstream` interface;
it runs the adapter/gateway code directly and does not use a database,
listening server, container, Compose stack, migration, production environment,
or environment mutation.

The test:

1. Requires the key file to be mode `0600` and reads the key only from that
   file. The key is never a command argument and is never logged.
2. Runs the local fork's auth-only whoami probe twice: once without an org
   header and once with the explicitly configured org.
3. Runs exactly one small Chat Completions inference for
   `factory/deepseek-v4.1-flash` with `max_tokens: 32` and
   `reasoning_effort: "none"` through the real `ForwardAsChatCompletions` path.
4. Asserts two whoami calls and exactly one inference call, no secret in the
   client response or `x-request-id`, and reports only status/usage counts. A
   failed inference is reported; the test never retries or tries another model.

Prepare the key outside shell history and command arguments, for example with
an owner-only editor or a secure password-manager write. Then run:

```sh
chmod 600 /tmp/factory-live-key
cd backend
FACTORY_LIVE_KEY_FILE=/tmp/factory-live-key \
FACTORY_LIVE_REGION=us \
FACTORY_LIVE_ORG_ID='<factory-active-org-id>' \
go test -tags=unit ./internal/service -run '^TestFactoryLiveSmoke$' -count=1 -v
rm -f /tmp/factory-live-key
```

Set `FACTORY_LIVE_REGION=eu` for an EU account. `FACTORY_LIVE_ORG_ID` is
required for the with-org auth-only probe. The inference model is fixed so a
single live attempt is reproducible; do not wrap the command in a retry loop.

An authorized local fork diagnostic was completed once on 2026-11-02 after the
parser fix: two auth-only whoami probes (no org and the explicit org) passed,
followed by exactly one `factory/deepseek-v4.1-flash` Chat Completions
inference with `max_tokens: 32` and `reasoning_effort: "none"`. The inference
returned HTTP 200 with `input_tokens=23` and `output_tokens=2`. The key file was
removed afterward, so the gated test now skips. This is one successful live
diagnostic observation, not a guarantee of model entitlement or future
availability.

## Staged upgrade and rollback recommendation

Build and retain a separately tagged fork image for a staged test. Do **not**
auto-deploy it. Before any upgrade:

1. Compare the fork's full baseline migration chain with production `0.2.19`
   in an isolated database/Redis copy. This Factory feature is intended to add
   no table or column, but baseline migrations still require review; do not run
   migrations against production from this build lane.
2. Back up the database and rehearse rollback on the isolated copy. Keep the
   previous image and configuration available and verify that rollback does
   not leave accounts or routes the old binary cannot understand.
3. Stage with isolated database/Redis and test credentials. Run mock/transport
   checks. Live inference is optional, is not required for mock acceptance,
   and is not run by this build lane; it must not touch production data or
   hosts. Staged deployment itself remains a separate approval.
4. Verify whoami, region/org behavior, native group reachability, explicit
   composite routes, unsupported-model/route failures, and secret redaction.
5. Before rolling an old binary back onto an environment that has active
   Factory accounts or routes, disable or remove Factory routing/accounts
   first. Never leave an old binary receiving Factory traffic it cannot route
   safely.

No deployment, production service, migration, or remote host change is
authorized by this guide or by the Factory test suite.

## Reference evidence and attribution

Protocol observations come from the MIT-licensed community plugin package at
commit `48d0cecaf808ddfc001a945c58e955ced99b2d29`:

- <https://github.com/magpie-community/plugins/tree/48d0cecaf808ddfc001a945c58e955ced99b2d29/packages/factory>
- <https://github.com/magpie-community/plugins/blob/48d0cecaf808ddfc001a945c58e955ced99b2d29/packages/factory/index.mjs>

The reference is community evidence, not a Factory entitlement guarantee or a
stable API contract. If a substantial portion of reference code is adapted or
copied, retain the MIT copyright/license notice in the relevant source and
documentation. Do not copy the reference plugin's broad content rewriting,
prompt-evasion, tool wrapping, or arbitrary-host behavior into this adapter.
