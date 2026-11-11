package antigravity

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/Wei-Shaw/sub2api/internal/pkg/servertiming"
)

// quotaSummaryBodyLimit bounds a single-endpoint retrieveUserQuotaSummary read.
const quotaSummaryBodyLimit = 1 << 20

// QuotaSummaryBucket is one quota window of a group, e.g. "gemini-5h" or "gemini-weekly".
// RemainingFraction stays a pointer so an omitted fraction is not treated as zero remaining.
type QuotaSummaryBucket struct {
	BucketID          string   `json:"bucketId"`
	DisplayName       string   `json:"displayName,omitempty"`
	Window            string   `json:"window,omitempty"`
	RemainingFraction *float64 `json:"remainingFraction,omitempty"`
	ResetTime         string   `json:"resetTime,omitempty"`
	Disabled          bool     `json:"disabled,omitempty"`
}

// QuotaSummaryGroup is a set of models that share their quota windows.
type QuotaSummaryGroup struct {
	DisplayName string               `json:"displayName"`
	Description string               `json:"description,omitempty"`
	Buckets     []QuotaSummaryBucket `json:"buckets"`
}

// QuotaSummary is the retrieveUserQuotaSummary response.
//
// Unlike fetchAvailableModels, which reports one fraction per model, this reports every
// window of every group. Errors omit upstream bodies and the bearer token.
type QuotaSummary struct {
	Groups      []QuotaSummaryGroup `json:"groups"`
	Description string              `json:"description,omitempty"`
}

// QuotaSummaryResponse is the upstream name for QuotaSummary.
type QuotaSummaryResponse = QuotaSummary

// RetrieveUserQuotaSummary reads the account's per-group quota windows.
// bodyLimit must be positive. Redirects are not followed with the bearer token.
func (c *Client) RetrieveUserQuotaSummary(ctx context.Context, accessToken, projectID string, bodyLimit int64) (*QuotaSummary, error) {
	if c == nil || c.httpClient == nil || bodyLimit <= 0 {
		return nil, errors.New("quota summary client or body limit is invalid")
	}
	var lastErr error
	for i, baseURL := range BaseURLs {
		summary, status, err := c.retrieveUserQuotaSummary(ctx, baseURL, accessToken, projectID, bodyLimit)
		if err == nil {
			DefaultURLAvailability.MarkSuccess(baseURL)
			return summary, nil
		}
		lastErr = redactQuotaSummaryError(err)
		if ctx.Err() == nil && shouldFallbackToNextURL(err, status) && i+1 < len(BaseURLs) {
			continue
		}
		return nil, lastErr
	}
	if lastErr == nil {
		return nil, errors.New("quota summary endpoint unavailable")
	}
	return nil, lastErr
}

// RetrieveUserQuotaSummaryFromURL reads the quota summary from one endpoint, without fallback.
func (c *Client) RetrieveUserQuotaSummaryFromURL(ctx context.Context, baseURL, accessToken, projectID string) (*QuotaSummaryResponse, error) {
	baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if baseURL == "" {
		return nil, errors.New("retrieveUserQuotaSummary base URL is required")
	}
	summary, _, err := c.retrieveUserQuotaSummary(ctx, baseURL, accessToken, projectID, quotaSummaryBodyLimit)
	if err != nil {
		return nil, redactQuotaSummaryError(err)
	}
	return summary, nil
}

func (c *Client) retrieveUserQuotaSummary(ctx context.Context, baseURL, accessToken, projectID string, bodyLimit int64) (*QuotaSummary, int, error) {
	if c == nil || c.httpClient == nil || bodyLimit <= 0 {
		return nil, 0, errors.New("quota summary client or body limit is invalid")
	}
	body, err := json.Marshal(FetchAvailableModelsRequest{Project: projectID})
	if err != nil {
		return nil, 0, errors.New("quota summary request encoding failed")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, baseURL+"/v1internal:retrieveUserQuotaSummary", strings.NewReader(string(body)))
	if err != nil {
		return nil, 0, errors.New("quota summary request creation failed")
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", GetUserAgentForContext(ctx))

	client := *c.httpClient
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := servertiming.Do(&client, req)
	if err != nil {
		return nil, 0, err
	}
	data, readErr := io.ReadAll(io.LimitReader(resp.Body, bodyLimit+1))
	_ = resp.Body.Close()
	if readErr != nil || int64(len(data)) > bodyLimit {
		return nil, resp.StatusCode, errors.New("quota summary response unreadable or too large")
	}
	if resp.StatusCode != http.StatusOK {
		return nil, resp.StatusCode, fmt.Errorf("quota summary HTTP %d", resp.StatusCode)
	}
	var summary QuotaSummary
	if err := json.Unmarshal(data, &summary); err != nil || len(summary.Groups) == 0 {
		return nil, resp.StatusCode, errors.New("quota summary response invalid or unavailable")
	}
	return &summary, resp.StatusCode, nil
}

func redactQuotaSummaryError(err error) error {
	if err == nil {
		return nil
	}
	msg := err.Error()
	switch {
	case strings.HasPrefix(msg, "quota summary HTTP "),
		msg == "quota summary response unreadable or too large",
		msg == "quota summary response invalid or unavailable",
		msg == "quota summary request creation failed",
		msg == "quota summary request encoding failed",
		msg == "quota summary client or body limit is invalid",
		msg == "quota summary transport failed",
		msg == "retrieveUserQuotaSummary base URL is required":
		return err
	default:
		return errors.New("quota summary transport failed")
	}
}
