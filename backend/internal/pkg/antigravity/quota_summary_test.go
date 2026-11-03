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
