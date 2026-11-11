package service

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"

	httppool "github.com/Wei-Shaw/sub2api/internal/pkg/httpclient"
)

const (
	factoryUsageURL                = "https://api.factory.ai/api/billing/limits"
	factoryUsageTTL                = 5 * time.Minute
	factoryUsageCooldown           = 30 * time.Second
	factoryUsageTimeout            = 10 * time.Second
	factoryUsageMaxBody            = 256 * 1024
	FactoryUsageSnapshotExtraKey   = "factory_usage_snapshot"
	FactoryUsageGenerationExtraKey = "factory_usage_generation"
	factoryUsageExtraKey           = FactoryUsageSnapshotExtraKey
)

// FactoryUsageState contains only subscription metadata, never absolute token
// quotas: Factory's percentages cannot establish an absolute allowance.
type FactoryUsageState struct {
	Generation             string     `json:"generation"`
	HasActiveSubscription  *bool      `json:"has_active_subscription,omitempty"`
	OverageMode            string     `json:"overage_mode,omitempty"`
	ExtraUsageAllowed      *bool      `json:"extra_usage_allowed,omitempty"`
	ExtraUsageBalanceCents *float64   `json:"extra_usage_balance_cents,omitempty"`
	Stale                  bool       `json:"stale"`
	LastAttemptAt          *time.Time `json:"last_attempt_at,omitempty"`
	NextRefreshAt          *time.Time `json:"next_refresh_at,omitempty"`
	RetryAfterSeconds      int        `json:"retry_after_seconds,omitempty"`
	ErrorCode              string     `json:"error_code,omitempty"`
}

type factoryUsageSnapshot struct {
	Generation             string               `json:"generation"`
	Windows                []AccountQuotaWindow `json:"windows"`
	HasActiveSubscription  *bool                `json:"has_active_subscription,omitempty"`
	OverageMode            string               `json:"overage_mode,omitempty"`
	ExtraUsageAllowed      *bool                `json:"extra_usage_allowed,omitempty"`
	ExtraUsageBalanceCents *float64             `json:"extra_usage_balance_cents,omitempty"`
	SampledAt              *time.Time           `json:"sampled_at,omitempty"`
	LastAttemptAt          *time.Time           `json:"last_attempt_at,omitempty"`
	NextRefreshAt          *time.Time           `json:"next_refresh_at,omitempty"`
	RetryAt                *time.Time           `json:"retry_at,omitempty"`
	ErrorCode              string               `json:"error_code,omitempty"`
	Failures               int                  `json:"failures,omitempty"`
}

type factoryUsageFetcher func(context.Context, *Account, time.Time) (*factoryUsageSnapshot, *factoryUsageError)
type factoryUsageSnapshotWriter interface {
	UpdateFactoryUsageSnapshot(context.Context, int64, string, any) (bool, error)
}
type factoryUsageCacheEntry struct {
	snapshot         *factoryUsageSnapshot
	credentialDigest [32]byte // process memory only; never included in Extra/API output
}
type factoryUsageError struct {
	code       string
	retryAfter time.Duration
}

func factoryUsageErrorText(code string) string {
	switch code {
	case "unauthenticated":
		return "Factory subscription credential was rejected"
	case "forbidden":
		return "Factory subscription access was denied"
	case "rate_limited":
		return "Factory subscription refresh is rate limited"
	case "invalid_response":
		return "Factory subscription response was invalid"
	case "missing_credential":
		return "Factory subscription credential is missing"
	case "persistence_error":
		return "Factory subscription snapshot could not be saved"
	case "credential_changed":
		return "Factory subscription credential changed; refresh the account"
	case "network_error":
		return "Factory subscription service is unavailable"
	default:
		return ""
	}
}

// The endpoint is deliberately independent of the inference base URL. Copy the
// pooled client before disabling redirects so no shared client is mutated.
func fetchFactoryUsage(ctx context.Context, account *Account, sampledAt time.Time) (*factoryUsageSnapshot, *factoryUsageError) {
	key := strings.TrimSpace(account.GetCredential("api_key"))
	if key == "" {
		return nil, &factoryUsageError{code: "missing_credential"}
	}
	proxyURL := ""
	if account.ProxyID != nil && account.Proxy != nil {
		proxyURL = account.Proxy.URL()
	}
	pooled, err := httppool.GetClient(httppool.Options{ProxyURL: proxyURL, Timeout: factoryUsageTimeout, ResponseHeaderTimeout: 8 * time.Second})
	if err != nil {
		return nil, &factoryUsageError{code: "network_error"}
	}
	return requestFactoryUsage(ctx, pooled, key, sampledAt)
}

func requestFactoryUsage(ctx context.Context, client *http.Client, key string, sampledAt time.Time) (*factoryUsageSnapshot, *factoryUsageError) {
	boundedClient := *client
	boundedClient.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, factoryUsageURL, nil)
	if err != nil {
		return nil, &factoryUsageError{code: "network_error"}
	}
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("Accept", "application/json")
	resp, err := boundedClient.Do(req)
	// Neither upstream response bodies nor transport errors are safe to expose:
	// they may echo the Authorization header or a proxy credential.
	if err != nil {
		return nil, &factoryUsageError{code: "network_error"}
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		code := "network_error"
		switch resp.StatusCode {
		case 401:
			code = "unauthenticated"
		case 403:
			code = "forbidden"
		case 429:
			code = "rate_limited"
		}
		return nil, &factoryUsageError{code: code, retryAfter: factoryRetryAfter(resp.Header.Get("Retry-After"), sampledAt)}
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, factoryUsageMaxBody+1))
	if err != nil || len(body) > factoryUsageMaxBody {
		return nil, &factoryUsageError{code: "invalid_response"}
	}
	snapshot, err := parseFactoryUsage(body, time.Now().UTC())
	if err != nil {
		return nil, &factoryUsageError{code: "invalid_response"}
	}
	return snapshot, nil
}

func factoryRetryAfter(value string, now time.Time) time.Duration {
	var wait time.Duration
	if seconds, err := strconv.ParseFloat(strings.TrimSpace(value), 64); err == nil && seconds > 0 && !math.IsInf(seconds, 0) && !math.IsNaN(seconds) {
		wait = time.Duration(math.Min(seconds, 86400)) * time.Second
	} else if at, err := http.ParseTime(value); err == nil {
		wait = at.Sub(now)
	}
	if wait < 0 {
		return 0
	}
	if wait > 24*time.Hour {
		return 24 * time.Hour
	}
	return wait
}

// Only known metadata values are retained. Unknown values remain unknown rather
// than exposing arbitrary upstream strings through accounts.extra or API errors.
func factoryEnum(value any, allowed ...string) string {
	s, _ := value.(string)
	for _, a := range allowed {
		if s == a {
			return s
		}
	}
	return ""
}

func parseFactoryUsage(body []byte, sampledAt time.Time) (*factoryUsageSnapshot, error) {
	var raw map[string]any
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	if err := decoder.Decode(&raw); err != nil {
		return nil, err
	}
	if decoder.Decode(new(any)) != io.EOF {
		return nil, fmt.Errorf("trailing data")
	}
	limits, ok := raw["limits"].(map[string]any)
	if !ok || limits == nil {
		return nil, fmt.Errorf("missing limits")
	}
	_, standard := limits["standard"].(map[string]any)
	_, core := limits["core"].(map[string]any)
	if !standard && !core {
		return nil, fmt.Errorf("missing pools")
	}
	snapshot := &factoryUsageSnapshot{SampledAt: &sampledAt, Windows: buildFactoryQuotaWindows(limits, sampledAt)}
	if active, ok := raw["hasActiveSubscription"].(bool); ok {
		snapshot.HasActiveSubscription = &active
	}
	snapshot.OverageMode = factoryEnum(raw["overagePreference"], "droidCore")
	if allowed, ok := raw["extraUsageAllowed"].(bool); ok {
		snapshot.ExtraUsageAllowed = &allowed
	}
	snapshot.ExtraUsageBalanceCents = quotaNumber(raw["extraUsageBalanceCents"])
	return snapshot, nil
}

func factorySnapshotFromExtra(extra map[string]any) *factoryUsageSnapshot {
	snapshot := &factoryUsageSnapshot{}
	if raw, ok := extra[factoryUsageExtraKey]; ok {
		if data, err := json.Marshal(raw); err == nil {
			if json.Unmarshal(data, snapshot) != nil {
				return &factoryUsageSnapshot{Generation: factoryUsageGeneration(extra)}
			}
		}
	}
	snapshot.Failures = min(max(snapshot.Failures, 0), 5)
	if snapshot.Generation != factoryUsageGeneration(extra) {
		return &factoryUsageSnapshot{Generation: factoryUsageGeneration(extra)}
	}
	return snapshot
}

func factoryUsageGeneration(extra map[string]any) string {
	value, _ := extra[FactoryUsageGenerationExtraKey].(string)
	return value
}

func factoryUsageInfo(snapshot *factoryUsageSnapshot, now time.Time, source string) *UsageInfo {
	state := &FactoryUsageState{Generation: snapshot.Generation, HasActiveSubscription: snapshot.HasActiveSubscription, OverageMode: snapshot.OverageMode,
		ExtraUsageAllowed: snapshot.ExtraUsageAllowed, ExtraUsageBalanceCents: snapshot.ExtraUsageBalanceCents,
		LastAttemptAt: snapshot.LastAttemptAt, NextRefreshAt: snapshot.NextRefreshAt, ErrorCode: snapshot.ErrorCode,
		Stale: snapshot.SampledAt == nil || now.Sub(*snapshot.SampledAt) >= factoryUsageTTL || snapshot.ErrorCode != ""}
	retryAt := snapshot.RetryAt
	if snapshot.LastAttemptAt != nil {
		cooldown := snapshot.LastAttemptAt.Add(factoryUsageCooldown)
		if retryAt == nil || cooldown.After(*retryAt) {
			retryAt = &cooldown
		}
	}
	if retryAt != nil && retryAt.After(now) {
		state.RetryAfterSeconds = int(math.Ceil(retryAt.Sub(now).Seconds()))
	}
	message := factoryUsageErrorText(snapshot.ErrorCode)
	return &UsageInfo{QuotaWindows: snapshot.Windows, FactoryUsage: state, Source: source, UpdatedAt: snapshot.SampledAt,
		Error: message, ErrorCode: snapshot.ErrorCode, QuotaSnapshotError: message}
}

func factoryRefreshDue(snapshot *factoryUsageSnapshot, now time.Time, force bool) bool {
	if snapshot.RetryAt != nil && now.Before(*snapshot.RetryAt) {
		return false
	}
	if snapshot.LastAttemptAt != nil && now.Sub(*snapshot.LastAttemptAt) < factoryUsageCooldown {
		return false
	}
	return force || snapshot.NextRefreshAt == nil || !now.Before(*snapshot.NextRefreshAt)
}

func (s *AccountUsageService) getFactoryUsage(ctx context.Context, account *Account, force bool) (*UsageInfo, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	// Cache entries are immutable. Every return constructs a fresh view so stale
	// age/countdowns remain correct, including after a failed refresh or restart.
	credentialDigest := sha256.Sum256([]byte(strings.TrimSpace(account.GetCredential("api_key"))))
	generation := factoryUsageGeneration(account.Extra)
	read := func() *factoryUsageSnapshot {
		stored := factorySnapshotFromExtra(account.Extra)
		if cached, ok := s.cache.factoryCache.Load(account.ID); ok {
			entry, isEntry := cached.(*factoryUsageCacheEntry)
			if !isEntry || entry.credentialDigest != credentialDigest || entry.snapshot.Generation != generation {
				return &factoryUsageSnapshot{Generation: generation}
			}
			value := entry.snapshot
			if stored.LastAttemptAt == nil || (value.LastAttemptAt != nil && !value.LastAttemptAt.Before(*stored.LastAttemptAt)) {
				return value
			}
		}
		return stored
	}
	snapshot := read()
	if !factoryRefreshDue(snapshot, time.Now(), force) {
		return factoryUsageInfo(snapshot, time.Now(), "active"), nil
	}
	flightKey := strconv.FormatInt(account.ID, 10) + ":" + generation + fmt.Sprintf(":%x", credentialDigest)
	result := s.cache.factoryFlight.DoChan(flightKey, func() (any, error) {
		snapshot := read()
		now := time.Now().UTC()
		if !factoryRefreshDue(snapshot, now, force) {
			return snapshot, nil
		}
		fetcher := s.factoryUsageFetcher
		if fetcher == nil {
			fetcher = fetchFactoryUsage
		}
		// One caller navigating away must not cancel the refresh joined by others.
		fetchCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), factoryUsageTimeout)
		fresh, fetchErr := fetcher(fetchCtx, account, now)
		cancel()
		if fetchErr != nil {
			copy := *snapshot
			fresh = &copy
			fresh.ErrorCode = fetchErr.code
			fresh.Failures = min(fresh.Failures+1, 5)
			delay := time.Minute * time.Duration(1<<min(fresh.Failures-1, 4))
			if fetchErr.retryAfter > delay {
				delay = fetchErr.retryAfter
			}
			retry := now.Add(delay)
			fresh.RetryAt = &retry
			fresh.NextRefreshAt = &retry
		} else {
			next := now.Add(factoryUsageTTL)
			fresh.NextRefreshAt = &next
		}
		fresh.LastAttemptAt = &now
		fresh.Generation = generation
		if s.accountRepo != nil {
			persistCtx, persistCancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
			writer, ok := s.accountRepo.(factoryUsageSnapshotWriter)
			if !ok {
				persistCancel()
				return &factoryUsageSnapshot{Generation: generation, ErrorCode: "persistence_error", LastAttemptAt: &now}, nil
			}
			written, err := writer.UpdateFactoryUsageSnapshot(persistCtx, account.ID, generation, fresh)
			persistCancel()
			if err == nil && !written {
				return &factoryUsageSnapshot{Generation: generation, ErrorCode: "credential_changed", LastAttemptAt: &now}, nil
			}
			if err != nil && fresh.ErrorCode == "" {
				fresh.ErrorCode = "persistence_error"
			}
		}
		s.cache.factoryCache.Store(account.ID, &factoryUsageCacheEntry{snapshot: fresh, credentialDigest: credentialDigest})
		return fresh, nil
	})
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case response := <-result:
		if response.Err != nil {
			return nil, response.Err
		}
		snapshot, ok := response.Val.(*factoryUsageSnapshot)
		if !ok || snapshot == nil {
			return nil, fmt.Errorf("factory usage cache returned an unexpected value")
		}
		return factoryUsageInfo(snapshot, time.Now(), "active"), nil
	}
}
