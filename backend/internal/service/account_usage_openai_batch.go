package service

import (
	"context"
	"fmt"
	"time"
)

type openAIBatchQuotaCache struct {
	updates   map[string]any
	err       error
	timestamp time.Time
}

func cachedOpenAIBatchQuota(cache *UsageCache, accountID int64) *openAIBatchQuotaCache {
	if cache == nil {
		return nil
	}
	value, _ := cache.openAIBatchCache.Load(accountID)
	cached, _ := value.(*openAIBatchQuotaCache)
	return cached
}

func reuseOpenAIBatchQuota(cached *openAIBatchQuotaCache, force bool) bool {
	if cached == nil {
		return false
	}
	ttl := openAIProbeCacheTTL
	if cached.err != nil {
		ttl = apiErrorCacheTTL
	} else if force {
		ttl = apiForceRefreshTTL
	}
	return time.Since(cached.timestamp) < ttl
}

func needsOpenAIBatchQuotaRefresh(windows []AccountQuotaWindow, now time.Time) bool {
	if len(windows) < 2 {
		return true
	}
	for _, window := range windows {
		if window.Utilization == nil || window.SampledAt == nil || now.Sub(*window.SampledAt) >= openAIProbeCacheTTL ||
			(window.ResetsAt != nil && !now.Before(*window.ResetsAt)) {
			return true
		}
	}
	return false
}

// The overview must never consume model quota merely to measure it. This batch
// path reads /wham/usage only; it does not fall back to /responses, clear errors,
// notify auto-reset, or consume reset credits. The single-account legacy path
// keeps its existing behavior for callers outside the overview.
func (s *AccountUsageService) getOpenAIBatchQuotaUsage(ctx context.Context, account *Account, force bool) (*UsageInfo, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	now := time.Now()
	usage := &UsageInfo{Source: "passive", UpdatedAt: &now}
	applyExtraToUsage(usage, account.Extra, now)
	cached := cachedOpenAIBatchQuota(s.cache, account.ID)
	if cached != nil {
		usage.QuotaWindows = mergeQuotaObservations(usage.QuotaWindows, buildOpenAIQuotaWindows(cached.updates))
	}
	if force || needsOpenAIBatchQuotaRefresh(usage.QuotaWindows, now) {
		if !reuseOpenAIBatchQuota(cached, force) {
			fetch := func() (any, error) {
				if err := ctx.Err(); err != nil {
					return nil, err
				}
				previous := cachedOpenAIBatchQuota(s.cache, account.ID)
				if reuseOpenAIBatchQuota(previous, force) {
					return previous, nil
				}
				result := &openAIBatchQuotaCache{timestamp: time.Now()}
				if s.openAIQuotaService == nil {
					result.err = fmt.Errorf("OpenAI quota query service is unavailable")
				} else {
					fetchCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
					defer cancel()
					upstream, err := s.openAIQuotaService.QueryUsageForOverview(fetchCtx, account.ID)
					result.err = err
					if err == nil {
						sampledAt := time.Now()
						if upstream != nil && upstream.FetchedAt > 0 {
							sampledAt = time.Unix(upstream.FetchedAt, 0)
						}
						result.updates = buildOpenAIQuotaObservationUpdates(upstream, account.IsShadow(), sampledAt)
						if !hasObservedQuota(buildOpenAIQuotaWindows(result.updates)) {
							result.updates = nil
							result.err = fmt.Errorf("OpenAI quota query returned no observed quota")
						} else if s.accountRepo != nil {
							if err := s.accountRepo.UpdateExtra(fetchCtx, account.ID, result.updates); err != nil {
								result.err = fmt.Errorf("failed to cache OpenAI quota snapshot: %w", err)
							}
						}
					}
				}
				if result.err != nil && !hasObservedQuota(buildOpenAIQuotaWindows(result.updates)) && previous != nil {
					result.updates = previous.updates
				}
				if s.cache != nil {
					s.cache.openAIBatchCache.Store(account.ID, result)
				}
				return result, nil
			}
			var result any
			var err error
			if s.cache != nil {
				result, err, _ = s.cache.openAIBatchFlight.Do(fmt.Sprintf("quota:%d", account.ID), fetch)
			} else {
				result, err = fetch()
			}
			if err != nil {
				return nil, err
			}
			cached, _ = result.(*openAIBatchQuotaCache)
		}
	}
	if cached != nil {
		usage.QuotaWindows = mergeQuotaObservations(usage.QuotaWindows, buildOpenAIQuotaWindows(cached.updates))
		if cached.err != nil {
			usage.QuotaSnapshotError = cached.err.Error()
		}
	}
	if account.IsShadow() {
		for i := range usage.QuotaWindows {
			usage.QuotaWindows[i].Scope, usage.QuotaWindows[i].Model = "model", "Codex Spark"
		}
	}
	// Preserve the legacy fields for other existing batch consumers, using the
	// normalized observations instead of mutating the Account.Extra map.
	for _, window := range usage.QuotaWindows {
		if window.Utilization == nil {
			continue
		}
		progress := &UsageProgress{Utilization: *window.Utilization, ResetsAt: window.ResetsAt}
		if window.ResetsAt != nil {
			progress.RemainingSeconds = max(0, int(time.Until(*window.ResetsAt).Seconds()))
		}
		switch window.Key {
		case "five_hour":
			usage.FiveHour = progress
		case "seven_day":
			usage.SevenDay = progress
		}
	}
	if s.usageLogRepo != nil {
		for _, dimension := range []struct {
			progress **UsageProgress
			duration time.Duration
		}{{&usage.FiveHour, 5 * time.Hour}, {&usage.SevenDay, 7 * 24 * time.Hour}} {
			if stats, err := s.usageLogRepo.GetAccountWindowStats(ctx, account.ID, codexWindowStatsStart(*dimension.progress, dimension.duration, now)); err == nil {
				if *dimension.progress == nil {
					*dimension.progress = &UsageProgress{}
				}
				(*dimension.progress).WindowStats = windowStatsFromAccountStats(stats)
			}
		}
	}
	return usage, nil
}
