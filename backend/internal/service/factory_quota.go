package service

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	factorypkg "github.com/Wei-Shaw/sub2api/internal/pkg/factory"
)

const (
	factoryQuotaFetchTimeout = 8 * time.Second
	factoryQuotaMaxBodyBytes = 256 << 10

	factoryQuotaPoolStandard = "standard"
	factoryQuotaPoolCore     = "core"
	factoryQuotaWindow5h     = "5h"
	factoryQuotaWindowWeekly = "weekly"
	factoryQuotaWindowMonth  = "monthly"
)

// factoryBillingLimitsURL builds the official billing-limits URL. Tests replace
// it to point at a local server; production always uses the regional Factory host.
var factoryBillingLimitsURL = func(region string) (string, error) {
	host, ok := factorypkg.RegionHost(region)
	if !ok {
		return "", fmt.Errorf("unsupported factory region")
	}
	return host + "/api/billing/limits", nil
}

type factoryBillingLimitsResponse struct {
	UsesTokenRateLimitsBilling bool                  `json:"usesTokenRateLimitsBilling"`
	Limits                     *factoryBillingLimits `json:"limits"`
}

type factoryBillingLimits struct {
	Standard *factoryLimitPool `json:"standard"`
	Core     *factoryLimitPool `json:"core"`
}

type factoryLimitPool struct {
	FiveHour *factoryBillingWindow `json:"fiveHour"`
	Weekly   *factoryBillingWindow `json:"weekly"`
	Monthly  *factoryBillingWindow `json:"monthly"`
}

type factoryBillingWindow struct {
	UsedPercent      flexFloat       `json:"usedPercent"`
	WindowEnd        json.RawMessage `json:"windowEnd"`
	SecondsRemaining json.RawMessage `json:"secondsRemaining"`
}

type flexFloat float64

func (n *flexFloat) UnmarshalJSON(data []byte) error {
	data = bytesTrim(data)
	if len(data) == 0 || string(data) == "null" {
		*n = 0
		return nil
	}
	if data[0] == '"' {
		var text string
		if err := json.Unmarshal(data, &text); err != nil {
			return err
		}
		parsed, err := strconv.ParseFloat(strings.TrimSpace(text), 64)
		if err != nil {
			return err
		}
		*n = flexFloat(parsed)
		return nil
	}
	var number float64
	if err := json.Unmarshal(data, &number); err != nil {
		return err
	}
	*n = flexFloat(number)
	return nil
}

func bytesTrim(data []byte) []byte {
	return []byte(strings.TrimSpace(string(data)))
}

// ParseFactoryBillingLimits converts a Factory GET /api/billing/limits body into
// the shared quota-window snapshot. Standard 5h/weekly/monthly windows are kept
// when present. Core windows are kept only when that pool reports usage or a
// reset clock; an empty core pool is not a block.
func ParseFactoryBillingLimits(body []byte, now time.Time) (QuotaWindowSnapshot, error) {
	if len(body) == 0 || len(body) > factoryQuotaMaxBodyBytes {
		return QuotaWindowSnapshot{}, fmt.Errorf("factory billing limits response is empty or too large")
	}
	var payload factoryBillingLimitsResponse
	if err := json.Unmarshal(body, &payload); err != nil {
		return QuotaWindowSnapshot{}, fmt.Errorf("factory billing limits response is invalid")
	}
	if !payload.UsesTokenRateLimitsBilling || payload.Limits == nil || payload.Limits.Standard == nil {
		return QuotaWindowSnapshot{}, fmt.Errorf("factory billing limits did not include standard token windows")
	}
	now = now.UTC()
	snap := QuotaWindowSnapshot{
		Platform:  PlatformFactory,
		FetchedAt: now,
	}
	snap.Windows = append(snap.Windows, factoryPoolWindows(factoryQuotaPoolStandard, payload.Limits.Standard, now)...)
	if payload.Limits.Core != nil && factoryPoolHasData(payload.Limits.Core) {
		snap.Windows = append(snap.Windows, factoryPoolWindows(factoryQuotaPoolCore, payload.Limits.Core, now)...)
	}
	if len(snap.Windows) == 0 {
		return QuotaWindowSnapshot{}, fmt.Errorf("factory billing limits did not include any window")
	}
	return snap, nil
}

func factoryPoolHasData(pool *factoryLimitPool) bool {
	if pool == nil {
		return false
	}
	for _, window := range []*factoryBillingWindow{pool.FiveHour, pool.Weekly, pool.Monthly} {
		if window == nil {
			continue
		}
		if float64(window.UsedPercent) > 0 || len(bytesTrim(window.WindowEnd)) > 0 && string(bytesTrim(window.WindowEnd)) != "null" ||
			len(bytesTrim(window.SecondsRemaining)) > 0 && string(bytesTrim(window.SecondsRemaining)) != "null" {
			return true
		}
	}
	return false
}

func factoryPoolWindows(pool string, raw *factoryLimitPool, now time.Time) []QuotaWindow {
	if raw == nil {
		return nil
	}
	type named struct {
		name   string
		window *factoryBillingWindow
	}
	out := make([]QuotaWindow, 0, 3)
	for _, item := range []named{
		{factoryQuotaWindow5h, raw.FiveHour},
		{factoryQuotaWindowWeekly, raw.Weekly},
		{factoryQuotaWindowMonth, raw.Monthly},
	} {
		if item.window == nil {
			continue
		}
		utilization := float64(item.window.UsedPercent)
		if utilization < 0 {
			utilization = 0
		}
		resetsAt := factoryWindowReset(item.window, now)
		out = append(out, QuotaWindow{
			ID:          pool + ":" + item.name,
			Pool:        pool,
			Name:        item.name,
			Utilization: utilization,
			ResetsAt:    resetsAt,
			Exhausted:   utilization >= quotaExhaustedUtilization,
		})
	}
	return out
}

func factoryWindowReset(window *factoryBillingWindow, now time.Time) time.Time {
	if window == nil {
		return time.Time{}
	}
	if seconds := rawFloat(window.SecondsRemaining); seconds > 0 {
		return now.Add(time.Duration(seconds * float64(time.Second))).UTC()
	}
	if raw := bytesTrim(window.WindowEnd); len(raw) > 0 && string(raw) != "null" {
		if parsed := parseResetTimestamp(string(raw)); !parsed.IsZero() {
			return parsed
		}
		if strings.HasPrefix(string(raw), `"`) {
			var text string
			if err := json.Unmarshal(raw, &text); err == nil {
				if parsed := parseResetTimestamp(text); !parsed.IsZero() {
					return parsed
				}
			}
		}
	}
	return time.Time{}
}

func rawFloat(raw json.RawMessage) float64 {
	raw = bytesTrim(raw)
	if len(raw) == 0 || string(raw) == "null" {
		return 0
	}
	if raw[0] == '"' {
		var text string
		if err := json.Unmarshal(raw, &text); err != nil {
			return 0
		}
		return floatFromExtra(text)
	}
	var number float64
	if err := json.Unmarshal(raw, &number); err != nil {
		return 0
	}
	return number
}

func fetchFactoryQuotaWindows(ctx context.Context, account *Account) (QuotaWindowSnapshot, error) {
	if account == nil || !account.IsFactory() {
		return QuotaWindowSnapshot{}, fmt.Errorf("factory quota fetch requires a factory account")
	}
	credentials, err := factorypkg.ParseCredentials(account.Credentials, true)
	if err != nil {
		return QuotaWindowSnapshot{}, fmt.Errorf("factory credentials are invalid")
	}
	endpoint, err := factoryBillingLimitsURL(credentials.Region)
	if err != nil {
		return QuotaWindowSnapshot{}, err
	}
	if ctx == nil {
		ctx = context.Background()
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), factoryQuotaFetchTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return QuotaWindowSnapshot{}, fmt.Errorf("build factory billing limits request")
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Authorization", "Bearer "+credentials.APIKey)
	if credentials.OrgID != "" {
		req.Header.Set("X-Factory-Org-Id", credentials.OrgID)
	}
	client := &http.Client{
		Timeout: factoryQuotaFetchTimeout,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	if account.Proxy != nil && strings.TrimSpace(account.Proxy.URL()) != "" {
		proxyURL, err := url.Parse(account.Proxy.URL())
		if err != nil {
			return QuotaWindowSnapshot{}, fmt.Errorf("factory account proxy url is invalid")
		}
		transport := http.DefaultTransport.(*http.Transport).Clone()
		transport.Proxy = http.ProxyURL(proxyURL)
		client.Transport = transport
	}
	resp, err := client.Do(req)
	if err != nil {
		return QuotaWindowSnapshot{}, fmt.Errorf("factory billing limits request failed")
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(resp.Body, factoryQuotaMaxBodyBytes+1))
	if err != nil {
		return QuotaWindowSnapshot{}, fmt.Errorf("factory billing limits response was unreadable")
	}
	if resp.StatusCode != http.StatusOK {
		return QuotaWindowSnapshot{}, fmt.Errorf("factory billing limits returned HTTP %d", resp.StatusCode)
	}
	return ParseFactoryBillingLimits(body, time.Now().UTC())
}
