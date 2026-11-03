//go:build unit

package service

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/pkg/antigravity"
	"github.com/stretchr/testify/require"
)

// Sanitized account-12 observation, 2026-11-03: the third-party 5h pool is
// disabled while weekly is exhausted; model quotas alone omit Gemini weekly.
const agPoolFixture = `{"groups":[{"displayName":"Gemini Models","buckets":[
{"bucketId":"gemini-weekly","window":"weekly","remainingFraction":0.5729232,"resetTime":"2026-11-06T12:12:24Z"},
{"bucketId":"gemini-5h","window":"5h","remainingFraction":1,"resetTime":"2026-11-03T14:36:50Z"}]},
{"displayName":"Claude and GPT models","buckets":[
{"bucketId":"3p-weekly","window":"weekly","remainingFraction":0,"resetTime":"2026-11-06T03:05:39Z"},
{"bucketId":"3p-5h","window":"5h","remainingFraction":1,"disabled":true,"resetTime":"2026-11-03T14:31:08Z"}]}]}`

func TestAntigravityQuotaPoolsObservedResponse(t *testing.T) {
	var summary antigravity.QuotaSummary
	require.NoError(t, json.Unmarshal([]byte(agPoolFixture), &summary))
	now := time.Now()
	windows := buildAntigravityQuotaPools(&summary, now)
	require.Len(t, windows, 4)
	require.InDelta(t, 42.70768, *windows[0].Utilization, 1e-8)
	require.Equal(t, "Gemini Models", windows[0].Pool)
	require.Equal(t, 10080, windows[0].WindowMinutes)
	require.Equal(t, 0.0, *windows[1].Utilization)
	require.Equal(t, 300, windows[1].WindowMinutes)
	require.Equal(t, 100.0, *windows[2].Utilization)
	require.True(t, windows[3].Disabled)
	require.Nil(t, windows[3].Utilization)
	for _, w := range windows {
		require.Equal(t, "pool", w.Scope)
		require.Equal(t, now, *w.SampledAt)
		require.NotNil(t, w.ResetsAt)
	}
}

func TestAntigravityQuotaPoolsMissingInvalidAndUnknownWindows(t *testing.T) {
	var summary antigravity.QuotaSummary
	require.NoError(t, json.Unmarshal([]byte(`{"groups":[{"displayName":"New Pool","buckets":[
{"bucketId":"unknown","window":"other","resetTime":"bad"},
{"bucketId":"negative","remainingFraction":-1},
{"bucketId":"overflow","remainingFraction":1.1},
{"bucketId":"unknown","remainingFraction":0.8},
{"remainingFraction":1}]}]}`), &summary))
	windows := buildAntigravityQuotaPools(&summary, time.Now())
	require.Len(t, windows, 3)
	for _, w := range windows {
		require.Nil(t, w.Utilization)
		require.Nil(t, w.ResetsAt)
		require.Zero(t, w.WindowMinutes)
	}
}

func TestAntigravityFetchQuotaPoolsAndOptionalFailure(t *testing.T) {
	for _, failure := range []bool{false, true} {
		t.Run(fmt.Sprint(failure), func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/v1internal:fetchAvailableModels":
					fmt.Fprint(w, `{"models":{"gemini-2.5-pro":{"quotaInfo":{"remainingFraction":1}}}}`)
				case "/v1internal:loadCodeAssist":
					fmt.Fprint(w, `{"paidTier":{"id":"g1-ultra-tier"}}`)
				case "/v1internal:retrieveUserQuotaSummary":
					if failure {
						w.WriteHeader(503)
						fmt.Fprint(w, "secret-body")
						return
					}
					fmt.Fprint(w, agPoolFixture)
				default:
					t.Errorf("unexpected path %s", r.URL.Path)
				}
			}))
			defer server.Close()
			old := antigravity.BaseURLs
			antigravity.BaseURLs = []string{server.URL}
			t.Cleanup(func() { antigravity.BaseURLs = old })
			result, err := NewAntigravityQuotaFetcher(nil, nil).FetchQuota(context.Background(), &Account{
				Platform: PlatformAntigravity, Credentials: map[string]any{"access_token": "test-token", "project_id": "project"},
			}, "")
			require.NoError(t, err)
			require.Len(t, result.UsageInfo.AntigravityQuota, 1)
			require.Equal(t, "ULTRA", result.UsageInfo.SubscriptionTier)
			if failure {
				require.Empty(t, result.UsageInfo.QuotaWindows)
				require.Equal(t, "antigravity_quota_summary_unavailable", result.UsageInfo.QuotaSnapshotError)
				require.Equal(t, antigravityErrorTTL, antigravityCacheTTL(result.UsageInfo))
			} else {
				require.Len(t, result.UsageInfo.QuotaWindows, 4)
				require.Empty(t, result.UsageInfo.QuotaSnapshotError)
			}
		})
	}
}
