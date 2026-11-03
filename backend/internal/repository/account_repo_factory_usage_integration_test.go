//go:build integration

package repository

import (
	"context"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/stretchr/testify/require"
)

func TestFactoryUsageGenerationAtomicCredentialChanges(t *testing.T) {
	ctx := context.Background()
	tx := testEntTx(t)
	repo := newAccountRepositoryWithSQL(tx.Client(), tx, nil)
	a := &service.Account{Name: "factory-generation", Platform: service.PlatformFactory, Type: service.AccountTypeAPIKey, Status: service.StatusActive, Concurrency: 1, Schedulable: true,
		Credentials: map[string]any{"api_key": "fixture-first"}, Extra: map[string]any{"unrelated": "keep", service.FactoryUsageSnapshotExtraKey: map[string]any{"generation": "injected"}, service.FactoryUsageGenerationExtraKey: "injected"}}
	require.NoError(t, repo.Create(ctx, a))
	loaded, err := repo.GetByID(ctx, a.ID)
	require.NoError(t, err)
	first, ok := loaded.Extra[service.FactoryUsageGenerationExtraKey].(string)
	require.True(t, ok)
	require.NotEmpty(t, first)
	require.NotEqual(t, "injected", first)
	require.NotContains(t, loaded.Extra, service.FactoryUsageSnapshotExtraKey)
	snapshot := map[string]any{"generation": first, "last_attempt_at": "2026-11-03T00:00:00Z"}
	written, err := repo.UpdateFactoryUsageSnapshot(ctx, a.ID, first, snapshot)
	require.NoError(t, err)
	require.True(t, written)
	// A stale full admin edit preserves the repository's newer snapshot and generation.
	loaded.Name = "renamed"
	loaded.Extra = map[string]any{"unrelated": "keep"}
	require.NoError(t, repo.Update(ctx, loaded))
	loaded, err = repo.GetByID(ctx, a.ID)
	require.NoError(t, err)
	require.Equal(t, first, loaded.Extra[service.FactoryUsageGenerationExtraKey])
	require.Contains(t, loaded.Extra, service.FactoryUsageSnapshotExtraKey)
	loaded.Credentials = map[string]any{"api_key": "fixture-second"}
	require.NoError(t, repo.Update(ctx, loaded))
	loaded, err = repo.GetByID(ctx, a.ID)
	require.NoError(t, err)
	second := loaded.Extra[service.FactoryUsageGenerationExtraKey].(string)
	require.NotEqual(t, first, second)
	require.NotContains(t, loaded.Extra, service.FactoryUsageSnapshotExtraKey)
	written, err = repo.UpdateFactoryUsageSnapshot(ctx, a.ID, first, snapshot)
	require.NoError(t, err)
	require.False(t, written)
	written, err = repo.UpdateFactoryUsageSnapshot(ctx, a.ID, second, map[string]any{"generation": second})
	require.NoError(t, err)
	require.True(t, written)
	// All direct credential and bulk write paths invalidate atomically too.
	require.NoError(t, repo.UpdateCredentials(ctx, a.ID, map[string]any{"api_key": "fixture-third"}))
	loaded, err = repo.GetByID(ctx, a.ID)
	require.NoError(t, err)
	third := loaded.Extra[service.FactoryUsageGenerationExtraKey].(string)
	require.NotEqual(t, second, third)
	require.NotContains(t, loaded.Extra, service.FactoryUsageSnapshotExtraKey)
	count, err := repo.BulkUpdate(ctx, []int64{a.ID}, service.AccountBulkUpdate{Credentials: map[string]any{"api_key": "fixture-fourth"}, Extra: map[string]any{service.FactoryUsageGenerationExtraKey: third, service.FactoryUsageSnapshotExtraKey: snapshot}})
	require.NoError(t, err)
	require.EqualValues(t, 1, count)
	loaded, err = repo.GetByID(ctx, a.ID)
	require.NoError(t, err)
	fourth := loaded.Extra[service.FactoryUsageGenerationExtraKey].(string)
	require.NotEqual(t, third, fourth)
	require.NotContains(t, loaded.Extra, service.FactoryUsageSnapshotExtraKey)
	require.Equal(t, "keep", loaded.Extra["unrelated"])
	// Generic extra writes cannot resurrect obsolete generations or snapshots.
	require.NoError(t, repo.UpdateExtra(ctx, a.ID, map[string]any{service.FactoryUsageGenerationExtraKey: first, service.FactoryUsageSnapshotExtraKey: snapshot}))
	loaded, err = repo.GetByID(ctx, a.ID)
	require.NoError(t, err)
	require.Equal(t, fourth, loaded.Extra[service.FactoryUsageGenerationExtraKey])
	require.NotContains(t, loaded.Extra, service.FactoryUsageSnapshotExtraKey)
	written, err = repo.UpdateFactoryUsageSnapshot(ctx, a.ID, third, snapshot)
	require.NoError(t, err)
	require.False(t, written)
}
