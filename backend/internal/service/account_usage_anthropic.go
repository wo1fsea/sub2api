package service

import (
	"context"
	"fmt"
	"math/rand/v2"
	"time"
)

func cachedAnthropicUsage(cache *UsageCache, accountID int64) *apiUsageCache {
	if cache == nil {
		return nil
	}
	value, _ := cache.apiCache.Load(accountID)
	cached, _ := value.(*apiUsageCache)
	return cached
}

func reuseAnthropicUsage(cached *apiUsageCache, force bool) bool {
	if cached == nil {
		return false
	}
	age := time.Since(cached.timestamp)
	if cached.err != nil {
		return age < apiErrorCacheTTL
	}
	ttl := apiCacheTTL
	if force {
		ttl = apiForceRefreshTTL
	}
	return cached.response != nil && age < ttl
}

func anthropicSampleTime(cached *apiUsageCache) *time.Time {
	if cached == nil || cached.response == nil {
		return nil
	}
	stamp := cached.sampledAt
	if stamp.IsZero() && cached.err == nil {
		// Existing in-process cache entries use timestamp for successful fetches.
		stamp = cached.timestamp
	}
	if stamp.IsZero() {
		return nil
	}
	return &stamp
}

func (s *AccountUsageService) getAnthropicUsage(ctx context.Context, account *Account, force bool) (*UsageInfo, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	cached := cachedAnthropicUsage(s.cache, account.ID)
	if !reuseAnthropicUsage(cached, force) {
		fetch := func() (any, error) {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
			previous := cachedAnthropicUsage(s.cache, account.ID)
			if reuseAnthropicUsage(previous, force) {
				return previous, nil
			}
			// Keep the existing jitter and bounded singleflight behavior while
			// ensuring a canceled caller does not poison all concurrent refreshes.
			fetchCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
			defer cancel()
			jitter := time.Duration(rand.Int64N(int64(apiQueryMaxJitter)))
			select {
			case <-time.After(jitter):
			case <-fetchCtx.Done():
				return nil, fetchCtx.Err()
			}
			resp, fetchErr := s.fetchOAuthUsageRaw(fetchCtx, account)
			if fetchErr == nil && resp == nil {
				fetchErr = fmt.Errorf("Anthropic usage query returned no snapshot")
			}
			if fetchErr == nil && !hasObservedQuota(buildAnthropicActiveQuotaWindows(resp, nil)) {
				fetchErr = fmt.Errorf("Anthropic usage query returned no observed quota")
			}
			result := &apiUsageCache{response: resp, err: fetchErr, timestamp: time.Now()}
			if fetchErr == nil {
				result.sampledAt = result.timestamp
				fresh := s.buildUsageInfo(resp, &result.sampledAt)
				if len(fresh.QuotaWindows) > 0 {
					s.syncActiveToPassive(fetchCtx, account.ID, fresh)
				}
			} else {
				result.response = nil
				if previous != nil && previous.response != nil {
					result.response = previous.response
					if sampledAt := anthropicSampleTime(previous); sampledAt != nil {
						result.sampledAt = *sampledAt
					}
				}
			}
			if s.cache != nil {
				s.cache.apiCache.Store(account.ID, result)
			}
			return result, nil
		}
		var result any
		var err error
		if s.cache != nil {
			result, err, _ = s.cache.apiFlight.Do(fmt.Sprintf("usage:%d", account.ID), fetch)
		} else {
			result, err = fetch()
		}
		if err != nil {
			return nil, err
		}
		cached, _ = result.(*apiUsageCache)
	}
	if cached == nil {
		return nil, fmt.Errorf("anthropic usage query returned no snapshot")
	}
	if cached.response == nil {
		// When the active request fails, persisted header observations are still
		// useful. Return them with their original times and a visible error.
		if supportsAnthropicPassiveUsage(account) {
			fallback, fallbackErr := s.getPassiveUsageForAccount(ctx, account)
			if fallbackErr == nil && hasObservedQuota(fallback.QuotaWindows) && cached.err != nil {
				fallback.QuotaSnapshotError = cached.err.Error()
				return fallback, nil
			}
		}
		if cached.err != nil {
			return nil, cached.err
		}
		return nil, fmt.Errorf("anthropic usage query returned no snapshot")
	}
	usage := s.buildUsageInfo(cached.response, anthropicSampleTime(cached))
	usage.Source = "active"
	s.addWindowStats(ctx, account, usage)
	// Response headers received after a cached API response are newer evidence.
	// Preserve their per-window source and never write an older cache hit over them.
	usage.QuotaWindows = mergeQuotaObservations(usage.QuotaWindows, buildAnthropicPassiveQuotaWindows(account))
	if cached.err != nil {
		usage.QuotaSnapshotError = cached.err.Error()
	}
	if usage.SevenDayFable == nil {
		usage.SevenDayFable = buildPassiveUsageWindow(account.Extra, "passive_usage_7d_oi_utilization", "passive_usage_7d_oi_reset")
	}
	// Usage observation does not establish that a rejected refresh token or
	// another account error has recovered. Leave scheduling/account state alone.
	return usage, nil
}

func mergeQuotaObservations(active, passive []AccountQuotaWindow) []AccountQuotaWindow {
	indexes := make(map[string]int, len(active))
	for i, window := range active {
		indexes[window.Key] = i
	}
	for _, window := range passive {
		if i, exists := indexes[window.Key]; exists {
			previous := active[i]
			if window.SampledAt != nil && (previous.SampledAt == nil || window.SampledAt.After(*previous.SampledAt)) {
				active[i] = window
			}
		} else {
			indexes[window.Key] = len(active)
			active = append(active, window)
		}
	}
	return active
}

func hasObservedQuota(windows []AccountQuotaWindow) bool {
	for _, window := range windows {
		if window.Utilization != nil && (window.Source == "upstream" || window.Source == "response_headers") {
			return true
		}
	}
	return false
}
