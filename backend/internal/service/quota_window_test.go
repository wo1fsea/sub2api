//go:build unit

package service

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestTightestExhaustedWindow_SoonestReset(t *testing.T) {
	now := time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC)
	windows := []QuotaWindow{
		{ID: "standard:weekly", Pool: "standard", Name: "weekly", Utilization: 100, Exhausted: true, ResetsAt: now.Add(48 * time.Hour)},
		{ID: "standard:5h", Pool: "standard", Name: "5h", Utilization: 100, Exhausted: true, ResetsAt: now.Add(2 * time.Hour)},
		{ID: "standard:monthly", Pool: "standard", Name: "monthly", Utilization: 10, ResetsAt: now.Add(time.Hour)},
		{ID: "core:5h", Pool: "core", Name: "5h", Utilization: 100, Exhausted: true, ResetsAt: time.Time{}},
	}
	got, ok := TightestExhaustedWindow(windows, now)
	require.True(t, ok)
	require.Equal(t, "standard:5h", got.ID)
}

func TestTightestExhaustedWindow_IgnoresRecoveredUtilization(t *testing.T) {
	now := time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC)
	windows := []QuotaWindow{
		{ID: "standard:5h", Utilization: 0, ResetsAt: now.Add(time.Hour)},
		{ID: "standard:weekly", Utilization: 40, Exhausted: false, ResetsAt: now.Add(2 * time.Hour)},
	}
	_, ok := TightestExhaustedWindow(windows, now)
	require.False(t, ok)
}

func TestDecideQuotaWindowRecovery_StillExhaustedWaitsForTightest(t *testing.T) {
	now := time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC)
	account := factoryQuotaAccount(now.Add(2*time.Hour), 100, true)
	account.Extra[QuotaWindowsExtraKey] = QuotaWindowSnapshot{Windows: []QuotaWindow{
		{ID: "standard:5h", Utilization: 100, Exhausted: true, ResetsAt: now.Add(2 * time.Hour)},
		{ID: "standard:weekly", Utilization: 100, Exhausted: true, ResetsAt: now.Add(72 * time.Hour)},
	}}
	decision := DecideQuotaWindowRecovery(account, now, 15*time.Second)
	require.Equal(t, QuotaRecoveryWait, decision.Action)
	require.Equal(t, "standard:5h", decision.WindowID)
	require.True(t, decision.WakeAt.Equal(now.Add(2*time.Hour+15*time.Second)))
	require.False(t, decision.EnableSchedulable)
}

func TestDecideQuotaWindowRecovery_LaterWindowStillBlocksAfterSoonerReset(t *testing.T) {
	now := time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC)
	account := factoryQuotaAccount(now.Add(-time.Minute), 100, true)
	account.Extra[QuotaWindowsExtraKey] = QuotaWindowSnapshot{Windows: []QuotaWindow{
		{ID: "standard:5h", Utilization: 100, Exhausted: true, ResetsAt: now.Add(-time.Minute)},
		{ID: "standard:weekly", Utilization: 100, Exhausted: true, ResetsAt: now.Add(24 * time.Hour)},
	}}
	decision := DecideQuotaWindowRecovery(account, now, 0)
	require.Equal(t, QuotaRecoveryWait, decision.Action)
	require.Equal(t, "standard:weekly", decision.WindowID)
}

func TestDecideQuotaWindowRecovery_ResetEnablesLegacyQuotaError(t *testing.T) {
	now := time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC)
	account := factoryQuotaAccount(now.Add(-time.Minute), 100, true)
	account.Extra = map[string]any{
		QuotaWindowsExtraKey: map[string]any{
			"platform": "factory",
			"windows": []any{
				map[string]any{
					"id": "standard:5h", "pool": "standard", "name": "5h",
					"utilization": 100.0, "exhausted": true,
					"resets_at": now.Add(-time.Minute).Format(time.RFC3339),
				},
			},
		},
	}
	decision := DecideQuotaWindowRecovery(account, now, 15*time.Second)
	require.Equal(t, QuotaRecoveryEnable, decision.Action)
	require.True(t, decision.EnableSchedulable)
}

func TestDecideQuotaWindowRecovery_RecoveredUtilizationEnablesBeforeStaleReset(t *testing.T) {
	now := time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC)
	account := factoryQuotaAccount(now.Add(time.Hour), 0, true)
	decision := DecideQuotaWindowRecovery(account, now, 0)
	require.Equal(t, QuotaRecoveryEnable, decision.Action)
	require.True(t, decision.EnableSchedulable)
}

func TestDecideQuotaWindowRecovery_ManualUnschedulableSkipped(t *testing.T) {
	now := time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC)
	account := &Account{
		ID:          13,
		Platform:    PlatformFactory,
		Status:      StatusActive,
		Schedulable: false,
		Extra: map[string]any{
			QuotaWindowsExtraKey: QuotaWindowSnapshot{Windows: []QuotaWindow{
				{ID: "standard:5h", Utilization: 0, ResetsAt: now.Add(-time.Hour)},
			}},
		},
	}
	decision := DecideQuotaWindowRecovery(account, now, 0)
	require.Equal(t, QuotaRecoverySkip, decision.Action)
}

func TestDecideQuotaWindowRecovery_UnrelatedErrorSkipped(t *testing.T) {
	now := time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC)
	account := &Account{
		ID:           13,
		Platform:     PlatformFactory,
		Status:       StatusError,
		Schedulable:  false,
		ErrorMessage: "Token revoked (401): account authentication permanently revoked",
		Extra: map[string]any{
			QuotaWindowsExtraKey: QuotaWindowSnapshot{Windows: []QuotaWindow{
				{ID: "standard:5h", Utilization: 0, ResetsAt: now.Add(-time.Hour)},
			}},
		},
	}
	require.Equal(t, QuotaRecoverySkip, DecideQuotaWindowRecovery(account, now, 0).Action)
}

func TestDecideQuotaWindowRecovery_RevokedBlockSkipsLegacyError(t *testing.T) {
	now := time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC)
	account := factoryQuotaAccount(now.Add(-time.Hour), 0, true)
	account.Extra[QuotaBlockExtraKey] = QuotaBlock{Active: false, Revoked: true, Source: quotaExhaustionSource}
	require.Equal(t, QuotaRecoverySkip, DecideQuotaWindowRecovery(account, now, 0).Action)
}

func TestDecideQuotaWindowRecovery_NonQuotaTempBlockSkipped(t *testing.T) {
	now := time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC)
	until := now.Add(time.Hour)
	account := factoryQuotaAccount(now.Add(-time.Hour), 0, true)
	account.TempUnschedulableUntil = &until
	account.TempUnschedulableReason = "proxy unreachable"
	require.Equal(t, QuotaRecoverySkip, DecideQuotaWindowRecovery(account, now, 0).Action)
}

func TestDecideQuotaWindowRecovery_UnknownResetDoesNotEnable(t *testing.T) {
	now := time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC)
	account := factoryQuotaAccount(time.Time{}, 100, true)
	require.Equal(t, QuotaRecoverySkip, DecideQuotaWindowRecovery(account, now, 0).Action)
}

func TestIsQuotaExhaustionText(t *testing.T) {
	require.True(t, isQuotaExhaustionText("Standard usage limit reached"))
	require.True(t, isQuotaExhaustionText("Payment required (402): 5h limit"))
	require.False(t, isQuotaExhaustionText("No Extra Usage balance."))
	require.False(t, isQuotaExhaustionText("Token revoked (401): nope"))
	require.False(t, isQuotaExhaustionText("insufficient balance or billing issue"))
}

func factoryQuotaAccount(resets time.Time, utilization float64, exhausted bool) *Account {
	return &Account{
		ID:           13,
		Platform:     PlatformFactory,
		Status:       StatusError,
		Schedulable:  false,
		ErrorMessage: "Payment required (402): Standard usage limit reached. 5h limit",
		Extra: map[string]any{
			QuotaWindowsExtraKey: QuotaWindowSnapshot{Windows: []QuotaWindow{{
				ID: "standard:5h", Pool: "standard", Name: "5h",
				Utilization: utilization, Exhausted: exhausted, ResetsAt: resets,
			}}},
			QuotaBlockExtraKey: QuotaBlock{
				Active: true, Source: quotaExhaustionSource, Platform: PlatformFactory,
				WindowID: "standard:5h", ResetsAt: resets, ClearedSchedulable: true, SetError: true,
			},
		},
	}
}
