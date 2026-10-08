package service

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func decodedQuotaResponse(t *testing.T, raw string) *ClaudeUsageResponse {
	t.Helper()
	var response ClaudeUsageResponse
	require.NoError(t, json.Unmarshal([]byte(raw), &response))
	return &response
}

func quotaWindowByKey(t *testing.T, windows []AccountQuotaWindow, key string) AccountQuotaWindow {
	t.Helper()
	for _, window := range windows {
		if window.Key == key {
			return window
		}
	}
	t.Fatalf("missing quota window %q: %+v", key, windows)
	return AccountQuotaWindow{}
}

func TestAccountQuotaSnapshot_ActiveMissingIsNotZero(t *testing.T) {
	response := decodedQuotaResponse(t, `{
		"five_hour": {"utilization": 0},
		"seven_day": {"resets_at": "2030-10-08T10:00:00Z"},
		"seven_day_sonnet": {"utilization": 64, "resets_at": "2030-10-09T10:00:00Z"},
		"seven_day_overage_included": null
	}`)
	sampledAt := time.Now().Add(-time.Minute)
	windows := buildAnthropicActiveQuotaWindows(response, &sampledAt)
	require.Len(t, windows, 3)
	fiveHour := quotaWindowByKey(t, windows, "five_hour")
	require.NotNil(t, fiveHour.Utilization)
	require.Zero(t, *fiveHour.Utilization)
	require.Equal(t, sampledAt, *fiveHour.SampledAt)
	require.Nil(t, quotaWindowByKey(t, windows, "seven_day").Utilization)
	sonnet := quotaWindowByKey(t, windows, "seven_day_sonnet")
	require.Equal(t, "model", sonnet.Scope)
	require.Equal(t, "Sonnet", sonnet.Model)
	require.Equal(t, 64.0, *sonnet.Utilization)
	require.Empty(t, buildAnthropicActiveQuotaWindows(decodedQuotaResponse(t, `{}`), &sampledAt))
}

func TestAccountQuotaSnapshot_PassiveMissingExpiredAndEstimates(t *testing.T) {
	svc := &AccountUsageService{}
	empty := &Account{Platform: PlatformAnthropic, Type: AccountTypeSetupToken}
	require.Zero(t, svc.estimateSetupTokenUsage(empty).FiveHour.Utilization)
	require.Empty(t, buildAnthropicPassiveQuotaWindows(empty), "legacy idle zero is not a quota observation")
	resetAt := time.Now().Add(-time.Minute)
	sampledAt := resetAt.Add(-time.Hour).UTC()
	account := &Account{
		SessionWindowEnd: &resetAt,
		Extra: map[string]any{
			"session_window_utilization":      0.96,
			"session_window_sampled_at":       sampledAt.Format(time.RFC3339Nano),
			"session_window_source":           "response_headers",
			"passive_usage_7d_oi_utilization": 0.0,
		},
	}
	require.Zero(t, svc.estimateSetupTokenUsage(account).FiveHour.Utilization)
	windows := buildAnthropicPassiveQuotaWindows(account)
	fiveHour := quotaWindowByKey(t, windows, "five_hour")
	require.Equal(t, 96.0, *fiveHour.Utilization)
	require.Equal(t, resetAt, *fiveHour.ResetsAt)
	require.Equal(t, sampledAt, *fiveHour.SampledAt)
	fable := quotaWindowByKey(t, windows, "seven_day_fable")
	require.NotNil(t, fable.Utilization)
	require.Zero(t, *fable.Utilization)
	require.Nil(t, fable.SampledAt, "another window's timestamp cannot supply freshness")
	require.Equal(t, "model", fable.Scope)
	require.Equal(t, "Fable", fable.Model)
	account.Extra = nil
	account.SessionWindowStatus = "allowed"
	estimated := quotaWindowByKey(t, buildAnthropicPassiveQuotaWindows(account), "five_hour")
	require.Nil(t, estimated.Utilization)
	require.Equal(t, "estimated", estimated.Source)
	account.SessionWindowStatus = "rejected"
	estimated = quotaWindowByKey(t, buildAnthropicPassiveQuotaWindows(account), "five_hour")
	require.Equal(t, 100.0, *estimated.Utilization)
	require.Nil(t, estimated.SampledAt)
}

func TestAccountQuotaSnapshot_OpenAIPreservesReadingAndActualDuration(t *testing.T) {
	stamp := time.Now().Add(-time.Hour).UTC()
	resetAt := stamp.Add(time.Minute)
	extra := map[string]any{
		"codex_5h_used_percent":   96.0,
		"codex_5h_reset_at":       resetAt.Format(time.RFC3339Nano),
		"codex_5h_window_minutes": 420,
		"codex_5h_sampled_at":     stamp.Format(time.RFC3339Nano),
		"codex_5h_source":         "response_headers",
		"codex_7d_used_percent":   0.0,
		"codex_7d_window_minutes": 20160,
	}
	windows := buildOpenAIQuotaWindows(extra)
	fiveHour := quotaWindowByKey(t, windows, "five_hour")
	require.Equal(t, 96.0, *fiveHour.Utilization)
	require.Equal(t, 420, fiveHour.WindowMinutes)
	require.Equal(t, resetAt, *fiveHour.ResetsAt)
	sevenDay := quotaWindowByKey(t, windows, "seven_day")
	require.Zero(t, *sevenDay.Utilization)
	require.Equal(t, 20160, sevenDay.WindowMinutes)
	require.Nil(t, sevenDay.SampledAt)
	require.Empty(t, buildOpenAIQuotaWindows(map[string]any{"codex_5h_used_percent": "bad"}))
	require.Nil(t, quotaWindowByKey(t, buildOpenAIQuotaWindows(map[string]any{
		"codex_5h_used_percent": 25.0, "codex_5h_reset_after_seconds": 3600,
	}), "five_hour").ResetsAt, "relative reset must not be anchored to the current request")
}

func TestAccountQuotaSnapshot_LocalCostsDoNotInventOpenAIQuota(t *testing.T) {
	svc := &AccountUsageService{usageLogRepo: &usageBatchLogRepoStub{}, cache: NewUsageCache()}
	account := &Account{ID: 7358, Platform: PlatformOpenAI, Type: AccountTypeOAuth}
	svc.cache.openAIProbeCache.Store(account.ID, time.Now())
	usage, err := svc.GetUsageForAccount(t.Context(), account)
	require.NoError(t, err)
	require.NotNil(t, usage.FiveHour.WindowStats)
	require.Empty(t, usage.QuotaWindows)
}

func TestAccountQuotaSnapshot_PartialCodexSampleKeepsOtherWindowTime(t *testing.T) {
	oldAt := time.Now().Add(-time.Hour).UTC()
	newAt := oldAt.Add(30 * time.Minute)
	extra := map[string]any{
		"codex_7d_used_percent": 88.0,
		"codex_7d_sampled_at":   oldAt.Format(time.RFC3339Nano),
	}
	utilization := 5.0
	minutes := 300
	updates := buildCodexUsageExtraUpdates(&OpenAICodexUsageSnapshot{
		PrimaryUsedPercent: &utilization, PrimaryWindowMinutes: &minutes,
		UpdatedAt: newAt.Format(time.RFC3339Nano),
	}, time.Now())
	require.NotContains(t, updates, "codex_7d_sampled_at")
	for key, value := range updates {
		extra[key] = value
	}
	windows := buildOpenAIQuotaWindows(extra)
	require.True(t, quotaWindowByKey(t, windows, "five_hour").SampledAt.Equal(newAt))
	require.True(t, quotaWindowByKey(t, windows, "seven_day").SampledAt.Equal(oldAt))
	resetOnly := map[string]any{"codex_5h_reset_at": newAt.Format(time.RFC3339Nano)}
	recordCodexQuotaWindowSamples(resetOnly, newAt, "response_headers")
	require.NotContains(t, resetOnly, "codex_5h_sampled_at")
}

func TestAccountQuotaSnapshot_PartialAnthropicHeadersKeepOtherWindowTime(t *testing.T) {
	repo := &sessionWindowMockRepo{}
	svc := &RateLimitService{accountRepo: repo}
	oldAt := time.Now().Add(-time.Hour).UTC()
	account := &Account{ID: 1, Extra: map[string]any{
		"passive_usage_7d_utilization": 0.87,
		"passive_usage_7d_sampled_at":  oldAt.Format(time.RFC3339Nano),
	}}
	headers := make(http.Header)
	headers.Set("anthropic-ratelimit-unified-5h-utilization", "0")
	svc.samplePassiveUsageFromHeaders(t.Context(), account, headers)
	require.Len(t, repo.updateExtraCalls, 1)
	updates := repo.updateExtraCalls[0].Updates
	require.NotContains(t, updates, "passive_usage_7d_sampled_at")
	for key, value := range updates {
		account.Extra[key] = value
	}
	windows := buildAnthropicPassiveQuotaWindows(account)
	require.Zero(t, *quotaWindowByKey(t, windows, "five_hour").Utilization)
	require.Equal(t, "response_headers", quotaWindowByKey(t, windows, "five_hour").Source)
	require.True(t, quotaWindowByKey(t, windows, "seven_day").SampledAt.Equal(oldAt))
	resetOnly := make(http.Header)
	resetOnly.Set("anthropic-ratelimit-unified-7d-reset", "1949220000")
	svc.samplePassiveUsageFromHeaders(t.Context(), account, resetOnly)
	require.NotContains(t, repo.updateExtraCalls[1].Updates, "passive_usage_7d_sampled_at")
}

type quotaSnapshotFetcher struct {
	calls    atomic.Int64
	response *ClaudeUsageResponse
	err      error
}

func (f *quotaSnapshotFetcher) FetchUsage(context.Context, string, string) (*ClaudeUsageResponse, error) {
	f.calls.Add(1)
	return f.response, f.err
}

func (f *quotaSnapshotFetcher) FetchUsageWithOptions(ctx context.Context, _ *ClaudeUsageFetchOptions) (*ClaudeUsageResponse, error) {
	return f.FetchUsage(ctx, "", "")
}

type quotaSnapshotRepo struct {
	stubOpenAIAccountRepo
	mu            sync.Mutex
	updates       []map[string]any
	clearCalls    int
	setErrorCalls int
	updateErr     error
}

func (r *quotaSnapshotRepo) UpdateExtra(_ context.Context, _ int64, updates map[string]any) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	copied := make(map[string]any, len(updates))
	for key, value := range updates {
		copied[key] = value
	}
	r.updates = append(r.updates, copied)
	return r.updateErr
}

func (r *quotaSnapshotRepo) UpdateSessionWindowEnd(context.Context, int64, time.Time) error {
	return nil
}

func (r *quotaSnapshotRepo) ClearError(context.Context, int64) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.clearCalls++
	return nil
}

func (r *quotaSnapshotRepo) SetError(context.Context, int64, string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.setErrorCalls++
	return nil
}

func TestAccountQuotaSnapshot_AnthropicCacheRetainsSampleTime(t *testing.T) {
	sampledAt := time.Now().Add(-time.Minute).UTC()
	response := decodedQuotaResponse(t, `{"five_hour":{"utilization":12}}`)
	repo := &quotaSnapshotRepo{}
	svc := &AccountUsageService{accountRepo: repo, cache: NewUsageCache()}
	account := &Account{ID: 1, Platform: PlatformAnthropic, Type: AccountTypeOAuth, Status: StatusError, ErrorMessage: "invalid_client"}
	svc.cache.apiCache.Store(account.ID, &apiUsageCache{response: response, timestamp: sampledAt, sampledAt: sampledAt})
	for range 2 {
		usage, err := svc.GetUsageForAccount(t.Context(), account)
		require.NoError(t, err)
		require.Equal(t, sampledAt, *quotaWindowByKey(t, usage.QuotaWindows, "five_hour").SampledAt)
	}
	require.Empty(t, repo.updates, "cache hits must not overwrite newer passive data or advance timestamps")
	require.Zero(t, repo.clearCalls)
	require.Equal(t, StatusError, account.Status)
}

func TestAccountQuotaSnapshot_AnthropicFailureKeepsPriorSuccessAndNegativeCache(t *testing.T) {
	sampledAt := time.Now().Add(-time.Hour).UTC()
	fetcher := &quotaSnapshotFetcher{err: errors.New("upstream quota unavailable")}
	repo := &quotaSnapshotRepo{}
	svc := &AccountUsageService{accountRepo: repo, usageFetcher: fetcher, cache: NewUsageCache()}
	account := &Account{ID: 1, Platform: PlatformAnthropic, Type: AccountTypeOAuth, Credentials: map[string]any{"access_token": "unit-test-token"}}
	svc.cache.apiCache.Store(account.ID, &apiUsageCache{
		response: decodedQuotaResponse(t, `{"five_hour":{"utilization":92}}`), timestamp: sampledAt, sampledAt: sampledAt,
	})
	for range 2 {
		usage, err := svc.GetUsageForAccount(t.Context(), account, true)
		require.NoError(t, err)
		require.Equal(t, "upstream quota unavailable", usage.QuotaSnapshotError)
		window := quotaWindowByKey(t, usage.QuotaWindows, "five_hour")
		require.Equal(t, 92.0, *window.Utilization)
		require.Equal(t, sampledAt, *window.SampledAt)
	}
	require.Equal(t, int64(1), fetcher.calls.Load())
	require.Empty(t, repo.updates, "a failed refresh must not overwrite persisted data")
}

func TestAccountQuotaSnapshot_AnthropicFailureFallsBackToPersistedHeaders(t *testing.T) {
	sampledAt := time.Now().Add(-time.Hour).UTC()
	fetcher := &quotaSnapshotFetcher{err: errors.New("quota request failed")}
	svc := &AccountUsageService{usageFetcher: fetcher, cache: NewUsageCache()}
	account := &Account{ID: 1, Platform: PlatformAnthropic, Type: AccountTypeOAuth,
		Credentials: map[string]any{"access_token": "unit-test-token"}, Extra: map[string]any{
			"session_window_utilization": 0.98,
			"session_window_sampled_at":  sampledAt.Format(time.RFC3339Nano),
			"session_window_source":      "response_headers",
		}}
	usage, err := svc.GetUsageForAccount(t.Context(), account, true)
	require.NoError(t, err)
	require.Equal(t, "quota request failed", usage.QuotaSnapshotError)
	window := quotaWindowByKey(t, usage.QuotaWindows, "five_hour")
	require.Equal(t, 98.0, *window.Utilization)
	require.Equal(t, sampledAt, *window.SampledAt)
	account.Extra = nil
	_, err = svc.GetUsageForAccount(t.Context(), account, true)
	require.EqualError(t, err, "quota request failed", "no prior observation remains unknown")
	require.Equal(t, int64(1), fetcher.calls.Load())
}

func TestAccountQuotaSnapshot_ForceBatchRefreshesOAuthOnlyWithCooldown(t *testing.T) {
	fetcher := &quotaSnapshotFetcher{response: decodedQuotaResponse(t, `{"five_hour":{"utilization":24}}`)}
	repo := &quotaSnapshotRepo{stubOpenAIAccountRepo: stubOpenAIAccountRepo{accounts: []Account{
		{ID: 1, Platform: PlatformAnthropic, Type: AccountTypeOAuth, Credentials: map[string]any{"access_token": "unit-test-token"}},
		{ID: 2, Platform: PlatformAnthropic, Type: AccountTypeSetupToken},
	}}}
	svc := &AccountUsageService{accountRepo: repo, usageFetcher: fetcher, cache: NewUsageCache()}
	usage, failures, err := svc.GetUsageBatch(t.Context(), []int64{1, 2}, false)
	require.NoError(t, err)
	require.Empty(t, failures)
	require.Empty(t, usage[1].QuotaWindows)
	require.Zero(t, fetcher.calls.Load())
	for range 2 {
		usage, failures, err = svc.GetUsageBatch(t.Context(), []int64{1, 2}, true)
		require.NoError(t, err)
		require.Empty(t, failures)
		require.Equal(t, 24.0, *quotaWindowByKey(t, usage[1].QuotaWindows, "five_hour").Utilization)
		require.Empty(t, usage[2].QuotaWindows)
	}
	require.Equal(t, int64(1), fetcher.calls.Load())
	require.Len(t, repo.updates, 1, "only the successful upstream fetch is persisted")
	window := quotaWindowByKey(t, usage[1].QuotaWindows, "five_hour")
	require.Equal(t, window.SampledAt.Format(time.RFC3339Nano), repo.updates[0]["session_window_sampled_at"])
}

func TestAccountQuotaSnapshot_ConcurrentAnthropicForceCoalesces(t *testing.T) {
	fetcher := &quotaSnapshotFetcher{response: decodedQuotaResponse(t, `{"five_hour":{"utilization":24}}`)}
	repo := &quotaSnapshotRepo{}
	svc := &AccountUsageService{accountRepo: repo, usageFetcher: fetcher, cache: NewUsageCache()}
	account := &Account{ID: 1, Platform: PlatformAnthropic, Type: AccountTypeOAuth, Credentials: map[string]any{"access_token": "unit-test-token"}}
	var wg sync.WaitGroup
	results := make(chan error, 8)
	for range cap(results) {
		wg.Go(func() {
			_, err := svc.GetUsageForAccount(t.Context(), account, true)
			results <- err
		})
	}
	wg.Wait()
	close(results)
	for err := range results {
		require.NoError(t, err)
	}
	require.Equal(t, int64(1), fetcher.calls.Load())
}

func TestAccountQuotaSnapshot_NewerPassiveReadingSurvivesCachedActive(t *testing.T) {
	oldAt := time.Now().Add(-2 * time.Minute).UTC()
	newAt := oldAt.Add(time.Minute)
	repo := &quotaSnapshotRepo{}
	svc := &AccountUsageService{accountRepo: repo, cache: NewUsageCache()}
	account := &Account{ID: 1, Platform: PlatformAnthropic, Type: AccountTypeOAuth, Extra: map[string]any{
		"session_window_utilization": 0.78, "session_window_sampled_at": newAt.Format(time.RFC3339Nano), "session_window_source": "response_headers",
		"passive_usage_7d_oi_utilization": 0.85, "passive_usage_7d_oi_sampled_at": oldAt.Format(time.RFC3339Nano), "passive_usage_7d_oi_source": "response_headers",
	}}
	svc.cache.apiCache.Store(account.ID, &apiUsageCache{
		response: decodedQuotaResponse(t, `{"five_hour":{"utilization":12},"seven_day":{"utilization":30}}`), timestamp: oldAt, sampledAt: oldAt,
	})
	usage, err := svc.GetUsageForAccount(t.Context(), account)
	require.NoError(t, err)
	window := quotaWindowByKey(t, usage.QuotaWindows, "five_hour")
	require.Equal(t, 78.0, *window.Utilization)
	require.Equal(t, newAt, *window.SampledAt)
	require.Equal(t, "response_headers", window.Source)
	fable := quotaWindowByKey(t, usage.QuotaWindows, "seven_day_fable")
	require.Equal(t, oldAt, *fable.SampledAt)
	require.Equal(t, "Fable", fable.Model)
	require.Empty(t, repo.updates)
}

func TestAccountQuotaSnapshot_OpenAIProbeFailureRetainsPriorSnapshot(t *testing.T) {
	stamp := time.Now().Add(-time.Minute).UTC()
	svc := &AccountUsageService{cache: NewUsageCache()}
	account := &Account{ID: 1, Platform: PlatformOpenAI, Type: AccountTypeOAuth, Extra: map[string]any{
		"codex_5h_used_percent": 82.0, "codex_usage_updated_at": stamp.Format(time.RFC3339Nano),
	}}
	usage, err := svc.GetUsageForAccount(t.Context(), account, true)
	require.NoError(t, err)
	require.Equal(t, "no access token available", usage.QuotaSnapshotError)
	window := quotaWindowByKey(t, usage.QuotaWindows, "five_hour")
	require.Equal(t, 82.0, *window.Utilization)
	require.Equal(t, stamp, *window.SampledAt)
	require.False(t, svc.shouldProbeOpenAICodexSnapshot(account.ID, time.Now(), true), "manual probe retries are bounded")
	usage, err = svc.GetUsageForAccount(t.Context(), account, true)
	require.NoError(t, err)
	require.Equal(t, "no access token available", usage.QuotaSnapshotError, "cooldown must not hide the failed refresh")
}

func TestAccountQuotaSnapshot_DuplicateAccountDropsObservations(t *testing.T) {
	extra := map[string]any{
		"session_window_sampled_at": "2030-10-08T00:00:00Z", "session_window_source": "upstream", "session_window_reset": 123,
		"passive_usage_7d_sonnet_utilization": 0.9, "passive_usage_7d_sonnet_sampled_at": "2030-10-08T00:00:00Z",
		"codex_5h_sampled_at": "2030-10-08T00:00:00Z", "codex_7d_source": "response_headers", "custom_setting": true,
	}
	cloned, err := duplicateAccountExtra(extra)
	require.NoError(t, err)
	require.Equal(t, map[string]any{"custom_setting": true}, cloned)
}

type quotaSnapshotOpenAIQuerier struct {
	calls     atomic.Int64
	response  *OpenAIQuotaUsage
	err       error
	accountID atomic.Int64
	onQuery   func()
}

func (q *quotaSnapshotOpenAIQuerier) QueryUsage(_ context.Context, accountID int64) (*OpenAIQuotaUsage, error) {
	q.calls.Add(1)
	q.accountID.Store(accountID)
	if q.onQuery != nil {
		q.onQuery()
	}
	return q.response, q.err
}

func (q *quotaSnapshotOpenAIQuerier) QueryUsageForOverview(ctx context.Context, accountID int64) (*OpenAIQuotaUsage, error) {
	return q.QueryUsage(ctx, accountID)
}

func TestAccountQuotaSnapshot_OpenAIBatchQueriesWithoutModelProbe(t *testing.T) {
	fetchedAt := time.Now().UTC().Truncate(time.Second)
	querier := &quotaSnapshotOpenAIQuerier{response: &OpenAIQuotaUsage{
		FetchedAt: fetchedAt.Unix(), RateLimit: &OpenAIRateLimit{
			PrimaryWindow:   &OpenAIRateLimitWindow{UsedPercent: 91, LimitWindowSeconds: 720 * 60, ResetAfterSeconds: 3600},
			SecondaryWindow: &OpenAIRateLimitWindow{UsedPercent: 20, LimitWindowSeconds: 20160 * 60, ResetAfterSeconds: 86400},
		},
	}}
	repo := &quotaSnapshotRepo{stubOpenAIAccountRepo: stubOpenAIAccountRepo{accounts: []Account{{
		ID: 1, Platform: PlatformOpenAI, Type: AccountTypeOAuth, Status: StatusError, ErrorMessage: "refresh token rejected",
	}}}}
	svc := &AccountUsageService{accountRepo: repo, openAIQuotaService: querier, cache: NewUsageCache()}
	var usage map[int64]*UsageInfo
	var failures map[int64]string
	var err error
	for range 2 {
		usage, failures, err = svc.GetUsageBatch(t.Context(), []int64{1}, true)
		require.NoError(t, err)
		require.Empty(t, failures)
		require.Empty(t, usage[1].QuotaSnapshotError)
	}
	window := quotaWindowByKey(t, usage[1].QuotaWindows, "five_hour")
	require.Equal(t, 91.0, *window.Utilization)
	require.Equal(t, 720, window.WindowMinutes)
	require.Equal(t, "upstream", window.Source)
	require.Equal(t, fetchedAt, *window.SampledAt)
	require.Equal(t, 20160, quotaWindowByKey(t, usage[1].QuotaWindows, "seven_day").WindowMinutes)
	require.Equal(t, int64(1), querier.calls.Load())
	require.Len(t, repo.updates, 1)
	require.Equal(t, fetchedAt.Format(time.RFC3339Nano), repo.updates[0]["codex_5h_sampled_at"])
	require.Zero(t, repo.clearCalls)
	require.Equal(t, StatusError, repo.accounts[0].Status)
	require.Empty(t, repo.accounts[0].Extra, "batch observations must not mutate account rows in memory")
}

func TestAccountQuotaSnapshot_OpenAIBatchFreshSnapshotSkipsUpstream(t *testing.T) {
	now := time.Now().UTC()
	querier := &quotaSnapshotOpenAIQuerier{err: errors.New("unexpected upstream query")}
	repo := &quotaSnapshotRepo{stubOpenAIAccountRepo: stubOpenAIAccountRepo{accounts: []Account{{
		ID: 1, Platform: PlatformOpenAI, Type: AccountTypeOAuth, Extra: map[string]any{
			"codex_usage_updated_at": now.Format(time.RFC3339Nano), "codex_5h_used_percent": 30.0, "codex_7d_used_percent": 90.0,
		},
	}}}}
	svc := &AccountUsageService{accountRepo: repo, openAIQuotaService: querier, cache: NewUsageCache()}
	usage, failures, err := svc.GetUsageBatch(t.Context(), []int64{1}, false)
	require.NoError(t, err)
	require.Empty(t, failures)
	require.Equal(t, 90.0, *quotaWindowByKey(t, usage[1].QuotaWindows, "seven_day").Utilization)
	require.Zero(t, querier.calls.Load())
}

func TestAccountQuotaSnapshot_OpenAIBatchFailureKeepsSnapshotAndNegativeCache(t *testing.T) {
	oldAt := time.Now().Add(-time.Hour).UTC()
	querier := &quotaSnapshotOpenAIQuerier{err: errors.New("quota read failed")}
	repo := &quotaSnapshotRepo{stubOpenAIAccountRepo: stubOpenAIAccountRepo{accounts: []Account{{
		ID: 1, Platform: PlatformOpenAI, Type: AccountTypeOAuth, Extra: map[string]any{
			"codex_usage_updated_at": oldAt.Format(time.RFC3339Nano), "codex_5h_used_percent": 94.0, "codex_7d_used_percent": 20.0,
		},
	}}}}
	svc := &AccountUsageService{accountRepo: repo, openAIQuotaService: querier, cache: NewUsageCache()}
	for range 2 {
		usage, failures, err := svc.GetUsageBatch(t.Context(), []int64{1}, true)
		require.NoError(t, err)
		require.Empty(t, failures)
		require.Equal(t, "quota read failed", usage[1].QuotaSnapshotError)
		window := quotaWindowByKey(t, usage[1].QuotaWindows, "five_hour")
		require.Equal(t, 94.0, *window.Utilization)
		require.Equal(t, oldAt, *window.SampledAt)
	}
	require.Equal(t, int64(1), querier.calls.Load())
	require.Empty(t, repo.updates)
}

func TestAccountQuotaSnapshot_OpenAIBatchMissingQueryServiceRemainsUnknown(t *testing.T) {
	repo := &quotaSnapshotRepo{stubOpenAIAccountRepo: stubOpenAIAccountRepo{accounts: []Account{{ID: 1, Platform: PlatformOpenAI, Type: AccountTypeOAuth}}}}
	svc := &AccountUsageService{accountRepo: repo, usageLogRepo: &usageBatchLogRepoStub{}, cache: NewUsageCache()}
	usage, failures, err := svc.GetUsageBatch(t.Context(), []int64{1}, true)
	require.NoError(t, err)
	require.Empty(t, failures)
	require.Empty(t, usage[1].QuotaWindows)
	require.Equal(t, "OpenAI quota query service is unavailable", usage[1].QuotaSnapshotError)
	require.NotNil(t, usage[1].FiveHour.WindowStats)
	require.Empty(t, repo.updates)
}

func TestAccountQuotaSnapshot_OpenAIBatchSparkUsesOnlySparkWindows(t *testing.T) {
	parentID := int64(1)
	querier := &quotaSnapshotOpenAIQuerier{response: &OpenAIQuotaUsage{
		FetchedAt: time.Now().Unix(), RateLimit: &OpenAIRateLimit{
			PrimaryWindow: &OpenAIRateLimitWindow{UsedPercent: 5, LimitWindowSeconds: 18000},
		}, AdditionalRateLimits: []OpenAIAdditionalRateLimit{{MeteredFeature: "codex_bengalfox", RateLimit: &OpenAIRateLimit{
			PrimaryWindow:   &OpenAIRateLimitWindow{UsedPercent: 97, LimitWindowSeconds: 18000},
			SecondaryWindow: &OpenAIRateLimitWindow{UsedPercent: 23, LimitWindowSeconds: 604800},
		}}},
	}}
	repo := &quotaSnapshotRepo{stubOpenAIAccountRepo: stubOpenAIAccountRepo{accounts: []Account{{
		ID: 2, Platform: PlatformOpenAI, Type: AccountTypeOAuth, ParentAccountID: &parentID, QuotaDimension: QuotaDimensionSpark,
	}}}}
	svc := &AccountUsageService{accountRepo: repo, openAIQuotaService: querier, cache: NewUsageCache()}
	usage, failures, err := svc.GetUsageBatch(t.Context(), []int64{2}, true)
	require.NoError(t, err)
	require.Empty(t, failures)
	window := quotaWindowByKey(t, usage[2].QuotaWindows, "five_hour")
	require.Equal(t, 97.0, *window.Utilization)
	require.Equal(t, "model", window.Scope)
	require.Equal(t, "Codex Spark", window.Model)
	require.Equal(t, int64(2), querier.accountID.Load())
	require.Equal(t, 97.0, repo.updates[0]["codex_5h_used_percent"])
}

func TestAccountQuotaSnapshot_ConcurrentOpenAIBatchForceCoalesces(t *testing.T) {
	querier := &quotaSnapshotOpenAIQuerier{response: &OpenAIQuotaUsage{FetchedAt: time.Now().Unix(), RateLimit: &OpenAIRateLimit{
		PrimaryWindow:   &OpenAIRateLimitWindow{UsedPercent: 14, LimitWindowSeconds: 18000},
		SecondaryWindow: &OpenAIRateLimitWindow{UsedPercent: 22, LimitWindowSeconds: 604800},
	}}}
	repo := &quotaSnapshotRepo{stubOpenAIAccountRepo: stubOpenAIAccountRepo{accounts: []Account{{ID: 1, Platform: PlatformOpenAI, Type: AccountTypeOAuth}}}}
	svc := &AccountUsageService{accountRepo: repo, openAIQuotaService: querier, cache: NewUsageCache()}
	var wg sync.WaitGroup
	results := make(chan error, 8)
	for range cap(results) {
		wg.Go(func() {
			_, _, err := svc.GetUsageBatch(t.Context(), []int64{1}, true)
			results <- err
		})
	}
	wg.Wait()
	close(results)
	for err := range results {
		require.NoError(t, err)
	}
	require.Equal(t, int64(1), querier.calls.Load())
	require.Len(t, repo.updates, 1)
}

func TestAccountQuotaSnapshot_OpenAIJSONMissingNullZeroAndAbsoluteReset(t *testing.T) {
	sampledAt := time.Now().UTC().Truncate(time.Second)
	for _, shadow := range []bool{false, true} {
		for _, percentage := range []string{"missing", "null", "zero"} {
			for _, hours := range []int{-1, 1} {
				t.Run(string(rune('0'+hours+1))+"/"+percentage+"/"+map[bool]string{false: "main", true: "spark"}[shadow], func(t *testing.T) {
					resetAt := sampledAt.Add(time.Duration(hours) * time.Hour)
					window := map[string]any{"limit_window_seconds": 18000, "reset_at": resetAt.Unix()}
					if percentage == "null" {
						window["used_percent"] = nil
					} else if percentage == "zero" {
						window["used_percent"] = 0
					}
					rateLimit := map[string]any{"primary_window": window, "secondary_window": nil}
					payload := map[string]any{"fetched_at": sampledAt.Unix(), "rate_limit": rateLimit}
					if shadow {
						payload["additional_rate_limits"] = []any{map[string]any{"metered_feature": "codex_bengalfox", "rate_limit": rateLimit}}
					}
					raw, err := json.Marshal(payload)
					require.NoError(t, err)
					var response OpenAIQuotaUsage
					require.NoError(t, json.Unmarshal(raw, &response))
					windows := buildOpenAIQuotaWindows(buildOpenAIQuotaObservationUpdates(&response, shadow, time.Now()))
					fiveHour := quotaWindowByKey(t, windows, "five_hour")
					if percentage == "zero" {
						require.NotNil(t, fiveHour.Utilization)
						require.Zero(t, *fiveHour.Utilization)
					} else {
						require.Nil(t, fiveHour.Utilization)
					}
					require.Equal(t, resetAt, *fiveHour.ResetsAt)
					require.Equal(t, sampledAt, *fiveHour.SampledAt)
					require.Nil(t, quotaWindowByKey(t, windows, "seven_day").Utilization)
				})
			}
		}
	}
	var response OpenAIQuotaUsage
	require.NoError(t, json.Unmarshal([]byte(`{"rate_limit":{"primary_window":{"used_percent":0,"limit_window_seconds":18000}}}`), &response))
	window := quotaWindowByKey(t, buildOpenAIQuotaWindows(buildOpenAIQuotaObservationUpdates(&response, false, sampledAt)), "five_hour")
	require.Nil(t, window.ResetsAt, "missing reset must not decode into a reset happening now")
}

type quotaSnapshotBlocker struct{ calls atomic.Int64 }

func (b *quotaSnapshotBlocker) BlockAccountScheduling(*Account, time.Time, string) { b.calls.Add(1) }
func (b *quotaSnapshotBlocker) ClearAccountSchedulingBlock(int64)                  { b.calls.Add(1) }

func TestAccountQuotaSnapshot_OpenAIObservationNeverDisablesExpiredAuthentication(t *testing.T) {
	var requests atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		require.Equal(t, "/backend-api/wham/usage", r.URL.Path)
		require.Equal(t, http.MethodGet, r.Method)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"rate_limit": map[string]any{"primary_window": map[string]any{"used_percent": 0, "limit_window_seconds": 18000}}})
	}))
	defer server.Close()
	for _, expired := range []bool{true, false} {
		expiresAt := time.Now().Add(time.Hour)
		if expired {
			expiresAt = time.Now().Add(-time.Hour)
		}
		repo := &quotaSnapshotRepo{stubOpenAIAccountRepo: stubOpenAIAccountRepo{accounts: []Account{{
			ID: 1, Platform: PlatformOpenAI, Type: AccountTypeOAuth, Status: StatusActive, Schedulable: true,
			Credentials: map[string]any{"access_token": "unit-test-access", "expires_at": expiresAt.Format(time.RFC3339), "chatgpt_account_id": "unit-test-account"},
		}}}}
		provider := NewOpenAITokenProvider(repo, nil, nil)
		blocker := &quotaSnapshotBlocker{}
		provider.SetAccountRuntimeBlocker(blocker)
		querier := NewOpenAIQuotaService(repo, nil, provider, newQuotaRedirectingFactory(server), nil)
		usage, err := querier.QueryUsageForOverview(t.Context(), 1)
		if expired {
			require.ErrorContains(t, err, "cached access token expired")
			require.Nil(t, usage)
		} else {
			require.NoError(t, err)
			require.NotNil(t, usage)
		}
		require.Zero(t, repo.setErrorCalls)
		require.Zero(t, repo.clearCalls)
		require.Zero(t, blocker.calls.Load())
		require.Equal(t, StatusActive, repo.accounts[0].Status)
		require.True(t, repo.accounts[0].Schedulable)
	}
	require.Equal(t, int64(1), requests.Load(), "only the valid credential can query; no reset-credit or model endpoint is requested")
}

func TestAccountQuotaSnapshot_BatchMissingAccountsAndFailuresAreRaceSafe(t *testing.T) {
	var accounts []Account
	var ids []int64
	for id := int64(1); id <= 100; id++ {
		accounts = append(accounts, Account{ID: id, Platform: PlatformOpenAI, Type: AccountTypeAPIKey})
		ids = append(ids, id, id+1000)
	}
	repo := &quotaSnapshotRepo{stubOpenAIAccountRepo: stubOpenAIAccountRepo{accounts: accounts}}
	svc := &AccountUsageService{accountRepo: repo, cache: NewUsageCache()}
	usage, failures, err := svc.GetUsageBatch(t.Context(), ids, true)
	require.NoError(t, err)
	require.Empty(t, usage)
	require.Len(t, failures, len(ids))
}

func TestAccountQuotaSnapshot_CanceledBatchDoesNotStartQueuedQueries(t *testing.T) {
	started := make(chan struct{}, 6)
	release := make(chan struct{})
	querier := &quotaSnapshotOpenAIQuerier{response: &OpenAIQuotaUsage{RateLimit: &OpenAIRateLimit{
		PrimaryWindow: &OpenAIRateLimitWindow{UsedPercent: 10, LimitWindowSeconds: 18000},
	}}, onQuery: func() { started <- struct{}{}; <-release }}
	var accounts []Account
	var ids []int64
	for id := int64(1); id <= 20; id++ {
		accounts = append(accounts, Account{ID: id, Platform: PlatformOpenAI, Type: AccountTypeOAuth})
		ids = append(ids, id)
	}
	repo := &quotaSnapshotRepo{stubOpenAIAccountRepo: stubOpenAIAccountRepo{accounts: accounts}}
	svc := &AccountUsageService{accountRepo: repo, openAIQuotaService: querier, cache: NewUsageCache()}
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	finished := make(chan error, 1)
	go func() { _, _, err := svc.GetUsageBatch(ctx, ids, true); finished <- err }()
	for range 6 {
		select {
		case <-started:
		case <-time.After(5 * time.Second):
			t.Fatal("batch did not start six query workers")
		}
	}
	cancel()
	close(release)
	select {
	case err := <-finished:
		require.ErrorIs(t, err, context.Canceled)
	case <-time.After(5 * time.Second):
		t.Fatal("canceled batch did not finish")
	}
	require.Equal(t, int64(6), querier.calls.Load(), "cancellation stops new queued probes")
	_, _, err := svc.GetUsageBatch(ctx, ids, true)
	require.ErrorIs(t, err, context.Canceled)
	require.Equal(t, int64(6), querier.calls.Load())
}

func TestAccountQuotaSnapshot_OpenAIResetOnlyFailureRetainsUnpersistedSuccess(t *testing.T) {
	fetchedAt := time.Now().Add(-time.Minute).UTC().Truncate(time.Second)
	querier := &quotaSnapshotOpenAIQuerier{response: &OpenAIQuotaUsage{FetchedAt: fetchedAt.Unix(), RateLimit: &OpenAIRateLimit{
		PrimaryWindow: &OpenAIRateLimitWindow{UsedPercent: 93, LimitWindowSeconds: 18000, ResetAfterSeconds: 3600},
	}}}
	repo := &quotaSnapshotRepo{updateErr: errors.New("snapshot persistence unavailable"), stubOpenAIAccountRepo: stubOpenAIAccountRepo{accounts: []Account{{ID: 1, Platform: PlatformOpenAI, Type: AccountTypeOAuth}}}}
	svc := &AccountUsageService{accountRepo: repo, openAIQuotaService: querier, cache: NewUsageCache()}
	usage, failures, err := svc.GetUsageBatch(t.Context(), []int64{1}, true)
	require.NoError(t, err)
	require.Empty(t, failures)
	require.Equal(t, 93.0, *quotaWindowByKey(t, usage[1].QuotaWindows, "five_hour").Utilization)
	require.Contains(t, usage[1].QuotaSnapshotError, "snapshot persistence unavailable")
	previous := cachedOpenAIBatchQuota(svc.cache, 1)
	svc.cache.openAIBatchCache.Store(int64(1), &openAIBatchQuotaCache{updates: previous.updates, err: previous.err, timestamp: time.Now().Add(-2 * time.Minute)})
	var resetOnly OpenAIQuotaUsage
	require.NoError(t, json.Unmarshal([]byte(`{"rate_limit":{"primary_window":{"limit_window_seconds":18000,"reset_at":1949220000}}}`), &resetOnly))
	querier.response = &resetOnly
	usage, failures, err = svc.GetUsageBatch(t.Context(), []int64{1}, true)
	require.NoError(t, err)
	require.Empty(t, failures)
	window := quotaWindowByKey(t, usage[1].QuotaWindows, "five_hour")
	require.Equal(t, 93.0, *window.Utilization)
	require.Equal(t, fetchedAt, *window.SampledAt)
	require.Equal(t, "OpenAI quota query returned no observed quota", usage[1].QuotaSnapshotError)
	require.Len(t, repo.updates, 1, "an empty usage observation must not overwrite last known data")
}

func TestAccountQuotaSnapshot_OpenAIResetOnlyFailureRetainsPersistedSnapshot(t *testing.T) {
	sampledAt := time.Now().Add(-time.Hour).UTC()
	var resetOnly OpenAIQuotaUsage
	require.NoError(t, json.Unmarshal([]byte(`{"rate_limit":{"primary_window":{"used_percent":null,"limit_window_seconds":18000,"reset_at":1949220000}}}`), &resetOnly))
	querier := &quotaSnapshotOpenAIQuerier{response: &resetOnly}
	repo := &quotaSnapshotRepo{stubOpenAIAccountRepo: stubOpenAIAccountRepo{accounts: []Account{{
		ID: 1, Platform: PlatformOpenAI, Type: AccountTypeOAuth, Extra: map[string]any{
			"codex_5h_used_percent": 93.0, "codex_usage_updated_at": sampledAt.Format(time.RFC3339Nano),
		},
	}}}}
	svc := &AccountUsageService{accountRepo: repo, openAIQuotaService: querier, cache: NewUsageCache()}
	usage, failures, err := svc.GetUsageBatch(t.Context(), []int64{1}, true)
	require.NoError(t, err)
	require.Empty(t, failures)
	window := quotaWindowByKey(t, usage[1].QuotaWindows, "five_hour")
	require.Equal(t, 93.0, *window.Utilization)
	require.Equal(t, sampledAt, *window.SampledAt)
	require.Equal(t, "OpenAI quota query returned no observed quota", usage[1].QuotaSnapshotError)
	require.Empty(t, repo.updates)
}

func TestAccountQuotaSnapshot_AnthropicResetOnlyFailureRetainsObservedQuota(t *testing.T) {
	sampledAt := time.Now().Add(-time.Hour).UTC()
	for _, cacheOnly := range []bool{false, true} {
		t.Run(map[bool]string{false: "persisted", true: "cached"}[cacheOnly], func(t *testing.T) {
			fetcher := &quotaSnapshotFetcher{response: decodedQuotaResponse(t, `{"five_hour":{"utilization":null,"resets_at":"2030-10-08T10:00:00Z"}}`)}
			repo := &quotaSnapshotRepo{}
			svc := &AccountUsageService{accountRepo: repo, usageFetcher: fetcher, cache: NewUsageCache()}
			account := &Account{ID: 1, Platform: PlatformAnthropic, Type: AccountTypeOAuth, Credentials: map[string]any{"access_token": "unit-test-token"}}
			if cacheOnly {
				svc.cache.apiCache.Store(account.ID, &apiUsageCache{response: decodedQuotaResponse(t, `{"five_hour":{"utilization":94}}`), timestamp: sampledAt, sampledAt: sampledAt})
			} else {
				account.Extra = map[string]any{"session_window_utilization": 0.94, "session_window_sampled_at": sampledAt.Format(time.RFC3339Nano), "session_window_source": "response_headers"}
			}
			usage, err := svc.GetUsageForAccount(t.Context(), account, true)
			require.NoError(t, err)
			window := quotaWindowByKey(t, usage.QuotaWindows, "five_hour")
			require.Equal(t, 94.0, *window.Utilization)
			require.Equal(t, sampledAt, *window.SampledAt)
			require.Equal(t, "Anthropic usage query returned no observed quota", usage.QuotaSnapshotError)
			require.Empty(t, repo.updates)
		})
	}
}
