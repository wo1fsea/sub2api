//go:build unit

package service

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestParseFactoryBillingLimits_StandardAndCore(t *testing.T) {
	now := time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC)
	body := []byte(`{
		"usesTokenRateLimitsBilling": true,
		"limits": {
			"standard": {
				"fiveHour": {"usedPercent": 100, "secondsRemaining": 7200},
				"weekly": {"usedPercent": 12.5, "windowEnd": "2026-11-08T00:00:00Z"},
				"monthly": {"usedPercent": 3, "windowEnd": 1794000000000}
			},
			"core": {
				"fiveHour": {"usedPercent": 0},
				"weekly": {"usedPercent": 0},
				"monthly": {"usedPercent": 0}
			}
		}
	}`)
	snap, err := ParseFactoryBillingLimits(body, now)
	require.NoError(t, err)
	require.Equal(t, PlatformFactory, snap.Platform)
	require.Len(t, snap.Windows, 3, "empty core pool is not a scheduling window")
	require.Equal(t, "standard:5h", snap.Windows[0].ID)
	require.True(t, snap.Windows[0].Exhausted)
	require.True(t, snap.Windows[0].ResetsAt.Equal(now.Add(2*time.Hour)))
	require.False(t, snap.Windows[1].Exhausted)
	require.True(t, snap.Windows[1].ResetsAt.Equal(time.Date(2026, 11, 8, 0, 0, 0, 0, time.UTC)))
	require.False(t, snap.Windows[2].ResetsAt.IsZero())

	withCore := strings.Replace(string(body), `"core": {
				"fiveHour": {"usedPercent": 0},
				"weekly": {"usedPercent": 0},
				"monthly": {"usedPercent": 0}
			}`, `"core": {
				"fiveHour": {"usedPercent": 100, "secondsRemaining": 600},
				"weekly": {"usedPercent": 1, "windowEnd": "2026-11-10T00:00:00Z"},
				"monthly": {"usedPercent": 0}
			}`, 1)
	snap, err = ParseFactoryBillingLimits([]byte(withCore), now)
	require.NoError(t, err)
	require.Len(t, snap.Windows, 6)
	require.Equal(t, "core:5h", snap.Windows[3].ID)
	require.True(t, snap.Windows[3].Exhausted)
}

func TestParseFactoryBillingLimits_RejectsBalanceOnlyPayload(t *testing.T) {
	_, err := ParseFactoryBillingLimits([]byte(`{"usesTokenRateLimitsBilling": false}`), time.Now())
	require.Error(t, err)
}

func TestFetchFactoryQuotaWindows_UsesOfficialRequestShape(t *testing.T) {
	var gotAuth, gotOrg, gotPath string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotOrg = r.Header.Get("X-Factory-Org-Id")
		gotPath = r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{
			"usesTokenRateLimitsBilling": true,
			"limits": {"standard": {
				"fiveHour": {"usedPercent": 100, "secondsRemaining": 30},
				"weekly": {"usedPercent": 0, "secondsRemaining": 100},
				"monthly": {"usedPercent": 0, "secondsRemaining": 100}
			}}
		}`)
	}))
	t.Cleanup(server.Close)
	original := factoryBillingLimitsURL
	factoryBillingLimitsURL = func(string) (string, error) { return server.URL + "/api/billing/limits", nil }
	t.Cleanup(func() { factoryBillingLimitsURL = original })

	snap, err := fetchFactoryQuotaWindows(context.Background(), &Account{
		ID:       13,
		Platform: PlatformFactory,
		Credentials: map[string]any{
			"api_key":        "fk-testkey",
			"region":         "us",
			"factory_org_id": "org-1",
		},
	})
	require.NoError(t, err)
	require.Equal(t, "/api/billing/limits", gotPath)
	require.Equal(t, "Bearer fk-testkey", gotAuth)
	require.Equal(t, "org-1", gotOrg)
	require.Equal(t, "standard:5h", snap.Windows[0].ID)
	require.True(t, snap.Windows[0].Exhausted)
}
