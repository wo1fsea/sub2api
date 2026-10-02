//go:build unit

package repository

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/config"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/stretchr/testify/require"
)

func TestSchedulerLegacySnapshotCompatibility(t *testing.T) {
	ctx := context.Background()
	cache, _ := newSchedulerCacheUnitWithRedis(t)
	account := service.Account{
		ID: 810, Platform: service.PlatformAnthropic, Type: service.AccountTypeOAuth,
		Status: service.StatusActive, Schedulable: true,
		Credentials: map[string]any{"access_token": "synthetic-secret", "account_scheduling_threshold": 60},
		Extra: map[string]any{"base_rpm": 15, "rpm_strategy": "tiered", "rpm_sticky_buffer": 3,
			"passive_usage_7d_utilization": .70, "passive_usage_7d_reset": time.Now().Add(time.Hour).Unix()},
	}
	bucket := service.SchedulerBucket{GroupID: 8, Platform: service.PlatformAnthropic, Mode: service.SchedulerModeSingle}
	token, err := cache.CaptureBucketWriteToken(ctx, bucket)
	require.NoError(t, err)
	require.NoError(t, cache.SetSnapshot(ctx, bucket, token, []service.Account{account}))

	// Reproduce the actual 0.2.4 projection: full account remains intact while
	// the shared metadata is overwritten without these admission-control fields.
	legacy := buildSchedulerMetadataAccount(account)
	delete(legacy.Credentials, "account_scheduling_threshold")
	for key := range account.Extra {
		delete(legacy.Extra, key)
	}
	payload, err := json.Marshal(legacy)
	require.NoError(t, err)
	require.NoError(t, cache.rdb.Set(ctx, schedulerAccountMetaKey("810"), payload, 0).Err())
	lastUsed := time.Now().UTC().Truncate(time.Second)
	require.NoError(t, cache.UpdateLastUsed(ctx, map[int64]time.Time{account.ID: lastUsed}))

	candidates, hit, err := cache.GetSnapshot(ctx, bucket)
	require.NoError(t, err)
	require.True(t, hit)
	require.Zero(t, candidates[0].GetBaseRPM(), "legacy projection reproduces the unsafe admission")

	cfg := &config.Config{}
	cfg.Gateway.Scheduling.LegacySnapshotCompat = true
	compat := ProvideSchedulerCache(cache.rdb, cfg)
	candidates, hit, err = compat.GetSnapshot(ctx, bucket)
	require.NoError(t, err)
	require.True(t, hit)
	require.Len(t, candidates, 1)
	require.Equal(t, 15, candidates[0].GetBaseRPM())
	require.Equal(t, service.WindowCostNotSchedulable, candidates[0].CheckRPMSchedulability(18))
	require.True(t, service.EvaluateAccountSchedulingThreshold(candidates[0], map[string]int{service.PlatformAnthropic: 100}, time.Now()).ShouldPause)
	require.NotContains(t, candidates[0].Credentials, "access_token")
	require.True(t, candidates[0].LastUsedAt.Equal(lastUsed))

	require.NoError(t, cache.rdb.Del(ctx, schedulerAccountKey("810")).Err())
	_, hit, err = compat.GetSnapshot(ctx, bucket)
	require.NoError(t, err)
	require.False(t, hit, "missing full payload must not fall back to unsafe legacy metadata")
	require.NoError(t, cache.rdb.Set(ctx, schedulerAccountKey("810"), "invalid-json", 0).Err())
	_, hit, err = compat.GetSnapshot(ctx, bucket)
	require.Error(t, err)
	require.False(t, hit)
}

func TestSchedulerLegacySnapshotCompatibilityDefaultsOff(t *testing.T) {
	for _, cfg := range []*config.Config{nil, {}} {
		cache := ProvideSchedulerCache(nil, cfg).(*schedulerCache)
		require.False(t, cache.legacySnapshotCompat)
	}
}
