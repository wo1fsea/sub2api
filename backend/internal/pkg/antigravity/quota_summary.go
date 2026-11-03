package antigravity

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// QuotaSummary is the grouped subscription quota returned by the same endpoint
// used by agy. Model quotaInfo is a separate, potentially shorter limiting window.
type QuotaSummary struct {
	Groups []QuotaSummaryGroup `json:"groups"`
}

type QuotaSummaryGroup struct {
	DisplayName string               `json:"displayName"`
	Buckets     []QuotaSummaryBucket `json:"buckets"`
}

type QuotaSummaryBucket struct {
	BucketID          string   `json:"bucketId"`
	DisplayName       string   `json:"displayName"`
	Window            string   `json:"window"`
	RemainingFraction *float64 `json:"remainingFraction"`
	ResetTime         string   `json:"resetTime"`
	Disabled          bool     `json:"disabled"`
}

// RetrieveUserQuotaSummary is read-only, bounded, and never follows redirects
// with the account's bearer token. Errors deliberately omit upstream bodies.
func (c *Client) RetrieveUserQuotaSummary(ctx context.Context, accessToken, projectID string, bodyLimit int64) (*QuotaSummary, error) {
	if c == nil || c.httpClient == nil || bodyLimit <= 0 {
		return nil, errors.New("quota summary client or body limit is invalid")
	}
	body, err := json.Marshal(FetchAvailableModelsRequest{Project: projectID})
	if err != nil {
		return nil, errors.New("quota summary request encoding failed")
	}
	client := *c.httpClient
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	for i, baseURL := range BaseURLs {
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, baseURL+"/v1internal:retrieveUserQuotaSummary", strings.NewReader(string(body)))
		if err != nil {
			return nil, errors.New("quota summary request creation failed")
		}
		req.Header.Set("Authorization", "Bearer "+accessToken)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("User-Agent", GetUserAgentForContext(ctx))
		resp, err := client.Do(req)
		if err != nil {
			if ctx.Err() == nil && shouldFallbackToNextURL(err, 0) && i+1 < len(BaseURLs) {
				continue
			}
			return nil, errors.New("quota summary transport failed")
		}
		data, readErr := io.ReadAll(io.LimitReader(resp.Body, bodyLimit+1))
		_ = resp.Body.Close()
		if readErr != nil || int64(len(data)) > bodyLimit {
			return nil, errors.New("quota summary response unreadable or too large")
		}
		if shouldFallbackToNextURL(nil, resp.StatusCode) && i+1 < len(BaseURLs) {
			continue
		}
		if resp.StatusCode != http.StatusOK {
			return nil, fmt.Errorf("quota summary HTTP %d", resp.StatusCode)
		}
		var summary QuotaSummary
		if err := json.Unmarshal(data, &summary); err != nil || len(summary.Groups) == 0 {
			return nil, errors.New("quota summary response invalid or unavailable")
		}
		return &summary, nil
	}
	return nil, errors.New("quota summary endpoint unavailable")
}
