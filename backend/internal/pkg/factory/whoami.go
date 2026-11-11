package factory

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
)

const MaxWhoamiResponseBytes = 64 << 10

// WhoamiResult is the bounded, selected subset of Factory whoami. No raw body
// is retained or returned to callers.
type WhoamiResult struct {
	OrgID           string
	Region          string
	InferenceRegion string
	UserID          string
	Email           string
	EnterpriseHost  bool
}

type whoamiPayload struct {
	UserID          string `json:"userId"`
	OrgID           string `json:"orgId"`
	Email           string `json:"email"`
	Region          string `json:"region"`
	InferenceRegion string `json:"inferenceRegion"`
	IsEnterprise    bool   `json:"isEnterprise"`
	PremBaseHostV2  string `json:"premBaseHostV2"`
}

// NewWhoamiRequest builds the exact authentication probe request. Callers add
// timeout and redirect suppression through the request context.
func NewWhoamiRequest(ctx context.Context, credentials Credentials) (*http.Request, error) {
	endpoint, ok := WhoamiURL(credentials.Region)
	if !ok {
		return nil, fmt.Errorf("unsupported Factory region")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, fmt.Errorf("build Factory whoami request")
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Authorization", "Bearer "+credentials.APIKey)
	req.Header.Set("X-Factory-Whoami-Extended", "true")
	if credentials.OrgID != "" {
		req.Header.Set("X-Factory-Org-Id", credentials.OrgID)
	}
	return req, nil
}

// DecodeWhoami decodes only selected fields and enforces a bounded payload.
func DecodeWhoami(body []byte) (WhoamiResult, error) {
	if len(body) > MaxWhoamiResponseBytes {
		return WhoamiResult{}, fmt.Errorf("factory whoami response is too large")
	}
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return WhoamiResult{}, fmt.Errorf("factory whoami returned an empty response")
	}
	var object map[string]json.RawMessage
	if err := json.Unmarshal(trimmed, &object); err != nil || len(object) == 0 {
		return WhoamiResult{}, fmt.Errorf("factory whoami returned an invalid response")
	}
	var payload whoamiPayload
	if err := json.Unmarshal(trimmed, &payload); err != nil {
		return WhoamiResult{}, fmt.Errorf("factory whoami returned an invalid response")
	}
	legacyRegion, legacySet, err := normalizeWhoamiRegion(payload.Region)
	if err != nil {
		return WhoamiResult{}, err
	}
	inferenceRegion, inferenceSet, err := normalizeWhoamiRegion(payload.InferenceRegion)
	if err != nil {
		return WhoamiResult{}, err
	}
	region := RegionUS
	if inheritance := inferenceSet || legacySet; inheritance {
		if inferenceSet && legacySet && inferenceRegion != legacyRegion {
			return WhoamiResult{}, fmt.Errorf("factory whoami returned contradictory regions")
		}
		if inferenceSet {
			region = inferenceRegion
		} else {
			region = legacyRegion
		}
	}
	userID, email := strings.TrimSpace(payload.UserID), strings.TrimSpace(payload.Email)
	if userID == "" && email == "" {
		return WhoamiResult{}, fmt.Errorf("factory whoami did not identify a user")
	}
	premHost := strings.TrimRight(strings.TrimSpace(payload.PremBaseHostV2), "/")
	enterprise := payload.IsEnterprise
	if premHost != "" && premHost != "https://prem.factory.ai" {
		enterprise = true
	}
	return WhoamiResult{OrgID: strings.TrimSpace(payload.OrgID), Region: region, InferenceRegion: strings.TrimSpace(payload.InferenceRegion), UserID: userID, Email: email, EnterpriseHost: enterprise}, nil
}

func normalizeWhoamiRegion(raw string) (string, bool, error) {
	value := strings.ToLower(strings.TrimSpace(raw))
	if value == "" {
		return "", false, nil
	}
	switch value {
	case "global", "us":
		return RegionUS, true, nil
	case "eu":
		return RegionEU, true, nil
	default:
		return "", false, fmt.Errorf("factory whoami returned an unsupported region")
	}
}

// VerifyWhoami checks actionable region/org mismatches and rejects enterprise
// hosts, which this API-key adapter does not support.
func VerifyWhoami(result WhoamiResult, credentials Credentials) error {
	if result.UserID == "" && result.Email == "" {
		return fmt.Errorf("factory whoami did not identify a user")
	}
	if result.EnterpriseHost {
		return fmt.Errorf("factory reports an enterprise host, which is not supported; use an official US or EU account")
	}
	if result.Region != credentials.Region {
		return fmt.Errorf("factory reports region %s but this account is configured for %s; update the account region", result.Region, credentials.Region)
	}
	if credentials.OrgID != "" && result.OrgID != credentials.OrgID {
		return fmt.Errorf("factory active organization does not match factory_org_id; verify or clear the organization")
	}
	return nil
}
