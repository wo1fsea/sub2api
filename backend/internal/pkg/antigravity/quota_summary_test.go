//go:build unit

package antigravity

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestQuotaSummaryTransport(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "/v1internal:retrieveUserQuotaSummary", r.URL.Path)
		require.Equal(t, http.MethodPost, r.Method)
		require.Equal(t, "Bearer test-token", r.Header.Get("Authorization"))
		require.NotEmpty(t, r.Header.Get("User-Agent"))
		var body FetchAvailableModelsRequest
		require.NoError(t, json.NewDecoder(r.Body).Decode(&body))
		require.Equal(t, "test-project", body.Project)
		fmt.Fprint(w, `{"groups":[{"displayName":"Gemini Models","buckets":[{"bucketId":"gemini-weekly","remainingFraction":0},{"bucketId":"gemini-5h"}]}]}`)
	}))
	defer server.Close()
	withMockBaseURLs(t, []string{server.URL})
	client, err := NewClient("")
	require.NoError(t, err)
	result, err := client.RetrieveUserQuotaSummary(context.Background(), "test-token", "test-project", 4096)
	require.NoError(t, err)
	require.Equal(t, 0.0, *result.Groups[0].Buckets[0].RemainingFraction)
	require.Nil(t, result.Groups[0].Buckets[1].RemainingFraction)
}

func TestQuotaSummaryFailureBoundsAndRedaction(t *testing.T) {
	for _, tc := range []struct {
		name, body string
		status     int
		limit      int64
	}{
		{"forbidden", "secret-upstream-body", 403, 4096},
		{"malformed", "secret-upstream-body", 200, 4096},
		{"empty", `{}`, 200, 4096},
		{"oversized", strings.Repeat("s", 65), 200, 64},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(tc.status)
				fmt.Fprint(w, tc.body)
			}))
			defer server.Close()
			withMockBaseURLs(t, []string{server.URL})
			client, err := NewClient("")
			require.NoError(t, err)
			_, err = client.RetrieveUserQuotaSummary(context.Background(), "test-token", "test-project", tc.limit)
			require.Error(t, err)
			require.NotContains(t, err.Error(), "secret-upstream-body")
			require.NotContains(t, err.Error(), "test-token")
		})
	}
}

func TestQuotaSummaryNeverFollowsRedirectAndHonorsCancellation(t *testing.T) {
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		t.Error("redirect must not be followed")
	}))
	defer target.Close()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	}))
	defer server.Close()
	withMockBaseURLs(t, []string{server.URL})
	client, err := NewClient("")
	require.NoError(t, err)
	_, err = client.RetrieveUserQuotaSummary(context.Background(), "test-token", "test-project", 4096)
	require.ErrorContains(t, err, "HTTP 307")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = client.RetrieveUserQuotaSummary(ctx, "test-token", "test-project", 4096)
	require.Error(t, err)
}

// The shape Google returned for a consumer Ultra account on 2026-11-04.
const quotaSummaryBody = `{
  "groups": [
    {"buckets": [
       {"bucketId": "gemini-weekly", "displayName": "Weekly Limit Remaining", "window": "weekly",
        "resetTime": "2026-11-11T15:52:48Z", "remainingFraction": 0.75},
       {"bucketId": "gemini-5h", "displayName": "Five Hour Limit Remaining", "window": "5h",
        "resetTime": "2026-11-04T20:52:48Z", "remainingFraction": 0.4}],
     "displayName": "Gemini Models", "description": "Models within this group: Gemini Flash, Gemini Pro"},
    {"buckets": [
       {"bucketId": "3p-weekly", "window": "weekly", "resetTime": "2026-11-11T15:52:48Z", "remainingFraction": 1},
       {"bucketId": "3p-5h", "window": "5h", "remainingFraction": 1}],
     "displayName": "Claude and GPT models"}
  ],
  "description": "Within each group, models share a weekly limit and a 5-hour limit."
}`

func TestClient_RetrieveUserQuotaSummaryFromURL(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1internal:retrieveUserQuotaSummary" || r.Method != http.MethodPost {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer tok" {
			t.Errorf("unexpected authorization header")
		}
		var body FetchAvailableModelsRequest
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Project != "proj" {
			t.Errorf("unexpected project: %+v, %v", body, err)
		}
		_, _ = w.Write([]byte(quotaSummaryBody))
	}))
	defer server.Close()

	client := mustNewClient(t, "")
	summary, err := client.RetrieveUserQuotaSummaryFromURL(context.Background(), server.URL, "tok", "proj")
	if err != nil {
		t.Fatalf("summary: %v", err)
	}
	if len(summary.Groups) != 2 || summary.Groups[0].DisplayName != "Gemini Models" {
		t.Fatalf("groups: %+v", summary.Groups)
	}
	weekly := summary.Groups[0].Buckets[0]
	if weekly.BucketID != "gemini-weekly" || weekly.Window != "weekly" || weekly.RemainingFraction == nil || *weekly.RemainingFraction != 0.75 ||
		weekly.ResetTime != "2026-11-11T15:52:48Z" {
		t.Fatalf("weekly bucket: %+v", weekly)
	}
	if summary.Groups[1].Buckets[1].ResetTime != "" {
		t.Fatalf("a bucket without resetTime keeps it empty")
	}
}

func TestClient_RetrieveUserQuotaSummaryFromURL_Errors(t *testing.T) {
	for _, tc := range []struct {
		status int
		body   string
	}{{http.StatusForbidden, `{"error":{"code":403}}`}, {http.StatusInternalServerError, `{}`}, {http.StatusOK, `not json`}} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(tc.status)
			_, _ = w.Write([]byte(tc.body))
		}))
		client := mustNewClient(t, "")
		if _, err := client.RetrieveUserQuotaSummaryFromURL(context.Background(), server.URL, "tok", "proj"); err == nil {
			t.Errorf("status %d body %q must be an error", tc.status, tc.body)
		}
		server.Close()
	}
}
