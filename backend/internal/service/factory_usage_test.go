package service

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

const factoryLimitsFixture = `{"limits":{"standard":{"fiveHour":{"usedPercent":0,"windowEnd":"2026-11-03T20:00:00Z"},"weekly":{"usedPercent":124.5,"windowEnd":1794000000000},"monthly":{"usedPercent":null,"secondsRemaining":60}},"core":{"fiveHour":{"usedPercent":9,"secondsRemaining":30}}},"extraUsageAllowed":false,"extraUsageBalanceCents":1250,"hasActiveSubscription":true,"overagePreference":"droidCore"}`

func TestFactoryUsageParseObservedWindows(t *testing.T) {
	now := time.Date(2026, 11, 3, 15, 0, 0, 0, time.UTC)
	snapshot, err := parseFactoryUsage([]byte(factoryLimitsFixture), now)
	require.NoError(t, err)
	require.Len(t, snapshot.Windows, 6)
	require.Equal(t, 0.0, *snapshot.Windows[0].Utilization)
	require.Equal(t, 124.5, *snapshot.Windows[1].Utilization)
	require.Equal(t, int64(1794000000), snapshot.Windows[1].ResetsAt.Unix())
	require.Nil(t, snapshot.Windows[2].Utilization)
	require.Equal(t, now.Add(time.Minute), *snapshot.Windows[2].ResetsAt)
	require.Equal(t, 0, snapshot.Windows[2].WindowMinutes, "calendar month is not a fabricated fixed duration")
	require.Nil(t, snapshot.Windows[4].Utilization)
	require.Nil(t, snapshot.Windows[4].ResetsAt)
	require.Equal(t, "factory_core_weekly", snapshot.Windows[4].Key)
	require.Equal(t, true, *snapshot.HasActiveSubscription)
	require.Equal(t, "droidCore", snapshot.OverageMode)
	require.Equal(t, false, *snapshot.ExtraUsageAllowed)
	require.Equal(t, 1250.0, *snapshot.ExtraUsageBalanceCents)
	for _, w := range snapshot.Windows {
		require.Equal(t, now, *w.SampledAt)
		require.Equal(t, "upstream", w.Source)
	}
	for _, bad := range []string{`{}`, `{"limits":null}`, `{"limits":{}}`, factoryLimitsFixture + `{}`, `not json`} {
		_, err = parseFactoryUsage([]byte(bad), now)
		require.Error(t, err)
	}
	invalid, err := parseFactoryUsage([]byte(`{"limits":{"standard":{"fiveHour":{"usedPercent":-1,"windowEnd":"nope","secondsRemaining":-1}}},"hasActiveSubscription":"fk-secret","overagePreference":"fk-secret"}`), now)
	require.NoError(t, err)
	require.Nil(t, invalid.Windows[0].Utilization)
	require.Nil(t, invalid.Windows[0].ResetsAt)
	require.Nil(t, invalid.HasActiveSubscription)
	require.Empty(t, invalid.OverageMode)
}

type factoryRoundTripFunc func(*http.Request) (*http.Response, error)

func (f factoryRoundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestFactoryUsageHTTPBoundedAndSanitized(t *testing.T) {
	for _, tc := range []struct {
		status     int
		body, code string
	}{
		{200, factoryLimitsFixture, ""}, {401, "fk-sensitive", "unauthenticated"}, {403, "fk-sensitive", "forbidden"},
		{429, "fk-sensitive", "rate_limited"}, {503, "fk-sensitive", "network_error"},
		{200, strings.Repeat("x", factoryUsageMaxBody+1), "invalid_response"},
	} {
		t.Run(tc.code+string(rune(tc.status)), func(t *testing.T) {
			client := &http.Client{Transport: factoryRoundTripFunc(func(req *http.Request) (*http.Response, error) {
				require.Equal(t, factoryUsageURL, req.URL.String())
				require.Equal(t, http.MethodGet, req.Method)
				require.Equal(t, "Bearer fk-test-only", req.Header.Get("Authorization"))
				return &http.Response{StatusCode: tc.status, Header: http.Header{"Retry-After": []string{"120"}}, Body: io.NopCloser(strings.NewReader(tc.body))}, nil
			})}
			_, failure := requestFactoryUsage(context.Background(), client, "fk-test-only", time.Now())
			if tc.code == "" {
				require.Nil(t, failure)
			} else {
				require.Equal(t, tc.code, failure.code)
				require.NotContains(t, factoryUsageErrorText(failure.code), "fk-")
			}
		})
	}
	client := &http.Client{Transport: factoryRoundTripFunc(func(*http.Request) (*http.Response, error) { return nil, errors.New("transport echoed fk-sensitive") })}
	_, failure := requestFactoryUsage(context.Background(), client, "fk-test-only", time.Now())
	require.Equal(t, "network_error", failure.code)
	require.Equal(t, 24*time.Hour, factoryRetryAfter("999999999999999", time.Now()))
}

func TestFactoryUsageRejectsRedirectAndHonorsTimeout(t *testing.T) {
	var requests int
	client := &http.Client{Transport: factoryRoundTripFunc(func(req *http.Request) (*http.Response, error) {
		requests++
		require.Equal(t, factoryUsageURL, req.URL.String())
		return &http.Response{StatusCode: http.StatusFound, Header: http.Header{"Location": []string{"https://api.factory.ai/untrusted-redirect"}}, Body: io.NopCloser(strings.NewReader(""))}, nil
	})}
	_, failure := requestFactoryUsage(context.Background(), client, "fk-test-only", time.Now())
	require.Equal(t, "network_error", failure.code)
	require.Equal(t, 1, requests)
	require.Nil(t, client.CheckRedirect, "shared client must remain unmodified")
	client = &http.Client{Transport: factoryRoundTripFunc(func(req *http.Request) (*http.Response, error) {
		<-req.Context().Done()
		return nil, req.Context().Err()
	})}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	_, failure = requestFactoryUsage(ctx, client, "fk-test-only", time.Now())
	require.Equal(t, "network_error", failure.code)
}

type factoryUsageRepo struct {
	AccountRepository
	mu      sync.Mutex
	extra   map[string]any
	updates int
}

func (r *factoryUsageRepo) UpdateExtra(_ context.Context, _ int64, updates map[string]any) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	// Model the JSONB round trip and preserve unrelated account metadata.
	data, _ := json.Marshal(updates)
	var decoded map[string]any
	_ = json.Unmarshal(data, &decoded)
	for key, value := range decoded {
		r.extra[key] = value
	}
	r.updates++
	return nil
}

func (r *factoryUsageRepo) UpdateFactoryUsageSnapshot(ctx context.Context, id int64, generation string, snapshot any) (bool, error) {
	r.mu.Lock()
	current := factoryUsageGeneration(r.extra)
	r.mu.Unlock()
	if current != generation {
		return false, nil
	}
	return true, r.UpdateExtra(ctx, id, map[string]any{factoryUsageExtraKey: snapshot})
}

func TestFactoryUsageCacheConcurrentAndRestartBackoff(t *testing.T) {
	repo := &factoryUsageRepo{extra: map[string]any{"unrelated": "preserved"}}
	account := &Account{ID: 13, Platform: PlatformFactory, Type: AccountTypeAPIKey, Extra: map[string]any{}}
	var calls atomic.Int32
	svc := &AccountUsageService{accountRepo: repo, cache: NewUsageCache(), factoryUsageFetcher: func(_ context.Context, _ *Account, now time.Time) (*factoryUsageSnapshot, *factoryUsageError) {
		calls.Add(1)
		snapshot, err := parseFactoryUsage([]byte(factoryLimitsFixture), now)
		require.NoError(t, err)
		return snapshot, nil
	}}
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			info, err := svc.GetUsageForAccount(context.Background(), account, true)
			require.NoError(t, err)
			require.Len(t, info.QuotaWindows, 6)
		}()
	}
	wg.Wait()
	require.EqualValues(t, 1, calls.Load())
	require.Equal(t, 1, repo.updates)
	require.Equal(t, "preserved", repo.extra["unrelated"])
	account.Extra = repo.extra
	// The cooldown and success TTL survive a process restart.
	restarted := &AccountUsageService{accountRepo: repo, cache: NewUsageCache(), factoryUsageFetcher: svc.factoryUsageFetcher}
	_, err := restarted.GetUsageForAccount(context.Background(), account, true)
	require.NoError(t, err)
	require.EqualValues(t, 1, calls.Load())
	prior := factorySnapshotFromExtra(repo.extra)
	old := time.Now().Add(-6 * time.Minute)
	prior.LastAttemptAt = &old
	prior.SampledAt = &old
	prior.NextRefreshAt = &old
	account.Extra = map[string]any{factoryUsageExtraKey: prior}
	restarted.cache = NewUsageCache()
	restarted.factoryUsageFetcher = func(context.Context, *Account, time.Time) (*factoryUsageSnapshot, *factoryUsageError) {
		calls.Add(1)
		return nil, &factoryUsageError{code: "rate_limited", retryAfter: 10 * time.Minute}
	}
	info, err := restarted.GetUsageForAccount(context.Background(), account, true)
	require.NoError(t, err)
	require.True(t, info.FactoryUsage.Stale)
	require.Equal(t, "rate_limited", info.ErrorCode)
	require.Len(t, info.QuotaWindows, 6)
	require.True(t, old.Equal(*info.UpdatedAt))
	require.GreaterOrEqual(t, info.FactoryUsage.RetryAfterSeconds, 599)
	account.Extra = repo.extra
	restarted.cache = NewUsageCache()
	_, err = restarted.GetUsageForAccount(context.Background(), account, true)
	require.NoError(t, err)
	require.EqualValues(t, 2, calls.Load())
	passive, err := restarted.getPassiveUsageForAccount(context.Background(), account)
	require.NoError(t, err)
	require.Equal(t, "passive", passive.Source)
	require.EqualValues(t, 2, calls.Load())
}

func TestFactoryUsageRefreshPolicyAndCancellation(t *testing.T) {
	now := time.Now()
	at := now.Add(-31 * time.Second)
	next := now.Add(4 * time.Minute)
	snapshot := &factoryUsageSnapshot{LastAttemptAt: &at, NextRefreshAt: &next, SampledAt: &at}
	require.False(t, factoryRefreshDue(snapshot, now, false))
	require.True(t, factoryRefreshDue(snapshot, now, true))
	at = now.Add(-20 * time.Second)
	require.False(t, factoryRefreshDue(snapshot, now, true))
	at = now.Add(-6 * time.Minute)
	require.True(t, factoryUsageInfo(snapshot, now, "upstream").FactoryUsage.Stale)
	started, release := make(chan struct{}), make(chan struct{})
	svc := &AccountUsageService{cache: NewUsageCache(), factoryUsageFetcher: func(ctx context.Context, _ *Account, at time.Time) (*factoryUsageSnapshot, *factoryUsageError) {
		close(started)
		<-release
		require.NoError(t, ctx.Err())
		value, _ := parseFactoryUsage([]byte(factoryLimitsFixture), at)
		return value, nil
	}}
	account := &Account{ID: 1, Platform: PlatformFactory, Type: AccountTypeAPIKey}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { _, err := svc.GetUsageForAccount(ctx, account); done <- err }()
	<-started
	cancel()
	require.ErrorIs(t, <-done, context.Canceled)
	close(release)
	info, err := svc.GetUsageForAccount(context.Background(), account)
	require.NoError(t, err)
	require.Len(t, info.QuotaWindows, 6)
}

func TestFactoryUsageCredentialRotationInvalidatesMemoryCache(t *testing.T) {
	account := &Account{ID: 13, Platform: PlatformFactory, Type: AccountTypeAPIKey, Credentials: map[string]any{"api_key": "fk-test-first"}}
	calls := 0
	svc := &AccountUsageService{cache: NewUsageCache(), factoryUsageFetcher: func(_ context.Context, _ *Account, at time.Time) (*factoryUsageSnapshot, *factoryUsageError) {
		calls++
		value, _ := parseFactoryUsage([]byte(factoryLimitsFixture), at)
		return value, nil
	}}
	_, err := svc.GetUsageForAccount(context.Background(), account)
	require.NoError(t, err)
	account.Credentials = map[string]any{"api_key": "fk-test-second"}
	_, err = svc.GetUsageForAccount(context.Background(), account)
	require.NoError(t, err)
	require.Equal(t, 2, calls)
}

func TestFactoryUsageGenerationRejectsStalePersistedAndInflightSnapshots(t *testing.T) {
	now := time.Now()
	future := now.Add(24 * time.Hour)
	old := &factoryUsageSnapshot{Generation: "old", SampledAt: &now, LastAttemptAt: &now, NextRefreshAt: &future, RetryAt: &future, ErrorCode: "rate_limited"}
	extra := map[string]any{FactoryUsageGenerationExtraKey: "new", factoryUsageExtraKey: old}
	require.Nil(t, factorySnapshotFromExtra(extra).SampledAt)
	require.Nil(t, factorySnapshotFromExtra(extra).RetryAt)
	repo := &factoryUsageRepo{extra: map[string]any{FactoryUsageGenerationExtraKey: "new"}}
	svc := &AccountUsageService{accountRepo: repo, cache: NewUsageCache(), factoryUsageFetcher: func(context.Context, *Account, time.Time) (*factoryUsageSnapshot, *factoryUsageError) {
		value, _ := parseFactoryUsage([]byte(factoryLimitsFixture), now)
		return value, nil
	}}
	account := &Account{ID: 13, Platform: PlatformFactory, Type: AccountTypeAPIKey, Extra: map[string]any{FactoryUsageGenerationExtraKey: "old"}}
	info, err := svc.GetUsageForAccount(context.Background(), account)
	require.NoError(t, err)
	require.Equal(t, "credential_changed", info.ErrorCode)
	require.Empty(t, info.QuotaWindows)
	require.Equal(t, 0, repo.updates)
	_, cached := svc.cache.factoryCache.Load(account.ID)
	require.False(t, cached)
	account.Extra = extra
	info, err = svc.GetUsageForAccount(context.Background(), account)
	require.NoError(t, err)
	require.Empty(t, info.ErrorCode)
	require.Len(t, info.QuotaWindows, 6)
	require.Equal(t, 1, repo.updates)
}
