package service

import (
	"strconv"
	"strings"
	"time"
)

const (
	// QuotaWindowsExtraKey is the account extra field that stores per-account
	// quota windows (utilization and resets_at). Factory writes it; the recovery
	// decision reads it for any platform that uses the same shape.
	QuotaWindowsExtraKey = "quota_windows"
	// QuotaBlockExtraKey records that scheduling was stopped because a quota
	// window was exhausted, so a later reset can re-enable only that case.
	QuotaBlockExtraKey = "quota_block"

	quotaExhaustionSource = "quota_exhaustion"

	// quotaWindowResetGrace is added after resets_at so a timer does not fire
	// slightly before the upstream window actually rolls.
	quotaWindowResetGrace = 15 * time.Second

	quotaExhaustedUtilization = 100
)

// QuotaWindow is one stored usage window. ID is pool plus name, for example
// "standard:5h". Utilization is a percentage in the range 0–100+.
type QuotaWindow struct {
	ID          string    `json:"id"`
	Pool        string    `json:"pool,omitempty"`
	Name        string    `json:"name,omitempty"`
	Utilization float64   `json:"utilization"`
	ResetsAt    time.Time `json:"resets_at,omitempty"`
	Exhausted   bool      `json:"exhausted"`
}

// QuotaWindowSnapshot is the persisted view of an account's quota windows.
type QuotaWindowSnapshot struct {
	Platform  string        `json:"platform,omitempty"`
	FetchedAt time.Time     `json:"fetched_at,omitempty"`
	Windows   []QuotaWindow `json:"windows"`
}

// QuotaBlock is the explicit signal that an account was taken out of
// scheduling because of quota exhaustion (as opposed to a manual pause or an
// unrelated error).
type QuotaBlock struct {
	Active             bool      `json:"active"`
	Revoked            bool      `json:"revoked"`
	Source             string    `json:"source"`
	Platform           string    `json:"platform,omitempty"`
	WindowID           string    `json:"window_id,omitempty"`
	ResetsAt           time.Time `json:"resets_at,omitempty"`
	ClearedSchedulable bool      `json:"cleared_schedulable"`
	SetError           bool      `json:"set_error"`
	ErrorMessage       string    `json:"error_message,omitempty"`
}

// QuotaRecoveryAction is the pure decision for one account at time now.
type QuotaRecoveryAction int

const (
	// QuotaRecoverySkip leaves the account alone.
	QuotaRecoverySkip QuotaRecoveryAction = iota
	// QuotaRecoveryWait arms a timer at WakeAt and does not change scheduling.
	QuotaRecoveryWait
	// QuotaRecoveryEnable clears recoverable runtime state and, when
	// EnableSchedulable is set, turns scheduling back on.
	QuotaRecoveryEnable
)

// QuotaRecoveryDecision is the result of DecideQuotaWindowRecovery.
type QuotaRecoveryDecision struct {
	Action            QuotaRecoveryAction
	WakeAt            time.Time
	EnableSchedulable bool
	WindowID          string
}

// blocks reports whether this window still prevents scheduling at now.
// A window that is exhausted only by a stale utilization percentage does not
// block once resets_at has passed.
func (w QuotaWindow) blocks(now time.Time) bool {
	// A refreshed utilization below the cap means the window has recovered,
	// including when a stale exhausted flag or a future resets_at is still stored.
	if w.Utilization < quotaExhaustedUtilization {
		return false
	}
	if w.ResetsAt.IsZero() {
		return true
	}
	return w.ResetsAt.After(now)
}

// TightestExhaustedWindow is the exhausted window that resets soonest.
// That is the next moment a quota block might clear. Windows that are not
// exhausted are ignored, even when their resets_at is sooner. A zero resets_at
// cannot win: the caller cannot schedule it.
func TightestExhaustedWindow(windows []QuotaWindow, now time.Time) (QuotaWindow, bool) {
	var best QuotaWindow
	found := false
	for _, window := range windows {
		if !window.blocks(now) || window.ResetsAt.IsZero() || !window.ResetsAt.After(now) {
			continue
		}
		if !found || window.ResetsAt.Before(best.ResetsAt) {
			best = window
			found = true
		}
	}
	return best, found
}

func exhaustedWindows(windows []QuotaWindow, now time.Time) (future []QuotaWindow, unknown bool) {
	for _, window := range windows {
		if !window.blocks(now) {
			continue
		}
		if window.ResetsAt.IsZero() || !window.ResetsAt.After(now) {
			unknown = true
			continue
		}
		future = append(future, window)
	}
	return future, unknown
}

// quotaExhaustionObserveText is the upstream message, or a bounded body when
// the message was empty, used only to recognize a quota-window 402.
func quotaExhaustionObserveText(upstreamMsg string, responseBody []byte) string {
	if text := strings.TrimSpace(upstreamMsg); text != "" {
		return text
	}
	if len(responseBody) == 0 {
		return ""
	}
	if len(responseBody) > 2048 {
		responseBody = responseBody[:2048]
	}
	return string(responseBody)
}

// isQuotaExhaustionText reports whether an error or temp-unschedulable reason
// describes a temporary usage-window limit rather than an auth, billing-balance,
// or manual failure.
func isQuotaExhaustionText(message string) bool {
	low := strings.ToLower(strings.TrimSpace(message))
	if low == "" {
		return false
	}
	if strings.Contains(low, "extra usage") && strings.Contains(low, "balance") {
		return false
	}
	if strings.Contains(low, "authentication failed") || strings.Contains(low, "token revoked") || strings.Contains(low, "token invalidated") {
		return false
	}
	if strings.Contains(low, "organization disabled") || strings.Contains(low, "organization has been disabled") {
		return false
	}
	needles := []string{
		"usage limit",
		"standard usage limit",
		"5-hour",
		"5 hour",
		"five-hour",
		"five hour",
		"5h limit",
		"5h usage",
		"rate limit reached",
		"weekly limit",
		"monthly limit",
		"token rate limit",
	}
	for _, needle := range needles {
		if strings.Contains(low, needle) {
			return true
		}
	}
	return false
}

func parseQuotaBlock(extra map[string]any) (QuotaBlock, bool) {
	if len(extra) == 0 {
		return QuotaBlock{}, false
	}
	raw, ok := extra[QuotaBlockExtraKey]
	if !ok || raw == nil {
		return QuotaBlock{}, false
	}
	switch typed := raw.(type) {
	case QuotaBlock:
		return typed, true
	case *QuotaBlock:
		if typed == nil {
			return QuotaBlock{}, false
		}
		return *typed, true
	case map[string]any:
		return quotaBlockFromMap(typed), true
	default:
		return QuotaBlock{}, false
	}
}

func quotaBlockFromMap(raw map[string]any) QuotaBlock {
	block := QuotaBlock{
		Active:             boolFromExtra(raw["active"]),
		Revoked:            boolFromExtra(raw["revoked"]),
		Source:             stringFromExtra(raw["source"]),
		Platform:           stringFromExtra(raw["platform"]),
		WindowID:           stringFromExtra(raw["window_id"]),
		ClearedSchedulable: boolFromExtra(raw["cleared_schedulable"]),
		SetError:           boolFromExtra(raw["set_error"]),
		ErrorMessage:       stringFromExtra(raw["error_message"]),
	}
	block.ResetsAt = timeFromExtra(raw["resets_at"])
	return block
}

func parseQuotaWindowSnapshot(extra map[string]any) QuotaWindowSnapshot {
	if len(extra) == 0 {
		return QuotaWindowSnapshot{}
	}
	raw, ok := extra[QuotaWindowsExtraKey]
	if !ok || raw == nil {
		return QuotaWindowSnapshot{}
	}
	switch typed := raw.(type) {
	case QuotaWindowSnapshot:
		return typed
	case *QuotaWindowSnapshot:
		if typed == nil {
			return QuotaWindowSnapshot{}
		}
		return *typed
	case map[string]any:
		return quotaSnapshotFromMap(typed)
	default:
		return QuotaWindowSnapshot{}
	}
}

func quotaSnapshotFromMap(raw map[string]any) QuotaWindowSnapshot {
	snap := QuotaWindowSnapshot{
		Platform:  stringFromExtra(raw["platform"]),
		FetchedAt: timeFromExtra(raw["fetched_at"]),
	}
	items, _ := raw["windows"].([]any)
	for _, item := range items {
		asMap, ok := item.(map[string]any)
		if !ok {
			continue
		}
		window := QuotaWindow{
			ID:          stringFromExtra(asMap["id"]),
			Pool:        stringFromExtra(asMap["pool"]),
			Name:        stringFromExtra(asMap["name"]),
			Utilization: floatFromExtra(asMap["utilization"]),
			Exhausted:   boolFromExtra(asMap["exhausted"]),
			ResetsAt:    timeFromExtra(asMap["resets_at"]),
		}
		if window.ID == "" && window.Pool != "" && window.Name != "" {
			window.ID = window.Pool + ":" + window.Name
		}
		if !window.Exhausted && window.Utilization >= quotaExhaustedUtilization {
			window.Exhausted = true
		}
		snap.Windows = append(snap.Windows, window)
	}
	return snap
}

// DecideQuotaWindowRecovery decides whether an account should stay blocked,
// wait for the tightest exhausted window, or be restored.
//
// Enable is allowed only when a quota-exhaustion signal is present (the stored
// block, or a legacy quota error message) and no exhausted window still has a
// future or unknown reset. A revoked block means an operator changed
// schedulable by hand and suppresses both the stored signal and the legacy
// error text. Schedulable is turned back on only when this quota block (or a
// legacy quota error, which SetError always pairs with schedulable=false) is
// why it is off.
func DecideQuotaWindowRecovery(account *Account, now time.Time, grace time.Duration) QuotaRecoveryDecision {
	if grace < 0 {
		grace = 0
	}
	if account == nil || account.Status == StatusDisabled {
		return QuotaRecoveryDecision{}
	}
	block, hasBlock := parseQuotaBlock(account.Extra)
	if hasBlock && block.Revoked {
		return QuotaRecoveryDecision{}
	}
	signal := hasBlock && block.Active && block.Source == quotaExhaustionSource
	legacy := account.Status == StatusError && isQuotaExhaustionText(account.ErrorMessage)
	if !signal && !legacy {
		return QuotaRecoveryDecision{}
	}
	if nonQuotaTempBlock(account, now) {
		return QuotaRecoveryDecision{}
	}

	snap := parseQuotaWindowSnapshot(account.Extra)
	windows := snap.Windows
	if len(windows) == 0 && !block.ResetsAt.IsZero() {
		windows = []QuotaWindow{{
			ID:          block.WindowID,
			ResetsAt:    block.ResetsAt,
			Utilization: quotaExhaustedUtilization,
			Exhausted:   true,
		}}
	}

	future, unknown := exhaustedWindows(windows, now)
	if account.RateLimitResetAt != nil && account.RateLimitResetAt.After(now) {
		future = append(future, QuotaWindow{
			ID:          "rate_limit_reset_at",
			ResetsAt:    account.RateLimitResetAt.UTC(),
			Utilization: quotaExhaustedUtilization,
			Exhausted:   true,
		})
	}
	if len(future) > 0 {
		tightest, ok := TightestExhaustedWindow(future, now)
		if !ok {
			return QuotaRecoveryDecision{}
		}
		wake := tightest.ResetsAt.Add(grace)
		if !wake.After(now) {
			wake = now
		}
		return QuotaRecoveryDecision{
			Action:   QuotaRecoveryWait,
			WakeAt:   wake,
			WindowID: tightest.ID,
		}
	}
	if unknown || (len(snap.Windows) == 0 && block.ResetsAt.IsZero()) {
		// Still exhausted with no clock, or we never learned a window. Do not
		// guess a reset and re-enable.
		return QuotaRecoveryDecision{}
	}

	enableSchedulable := false
	if !account.Schedulable && (block.ClearedSchedulable || legacy) {
		enableSchedulable = true
	}
	windowID := block.WindowID
	return QuotaRecoveryDecision{
		Action:            QuotaRecoveryEnable,
		EnableSchedulable: enableSchedulable,
		WindowID:          windowID,
	}
}

func nonQuotaTempBlock(account *Account, now time.Time) bool {
	if account == nil || account.TempUnschedulableUntil == nil || !account.TempUnschedulableUntil.After(now) {
		return false
	}
	return !isQuotaExhaustionText(account.TempUnschedulableReason)
}

func quotaBlockRevokedValue() map[string]any {
	return map[string]any{
		"active":  false,
		"revoked": true,
		"source":  quotaExhaustionSource,
	}
}

// QuotaBlockRevokedUpdate is the extra patch written when an operator sets
// schedulable themselves. It withdraws permission to auto re-enable later.
func QuotaBlockRevokedUpdate() map[string]any {
	return map[string]any{QuotaBlockExtraKey: quotaBlockRevokedValue()}
}

func boolFromExtra(raw any) bool {
	switch typed := raw.(type) {
	case bool:
		return typed
	case string:
		return strings.EqualFold(strings.TrimSpace(typed), "true")
	case float64:
		return typed != 0
	default:
		return false
	}
}

func stringFromExtra(raw any) string {
	switch typed := raw.(type) {
	case string:
		return strings.TrimSpace(typed)
	default:
		return ""
	}
}

func floatFromExtraString(raw string) float64 {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return 0
	}
	parsed, err := strconv.ParseFloat(raw, 64)
	if err != nil {
		return 0
	}
	return parsed
}

func timeFromExtra(raw any) time.Time {
	switch typed := raw.(type) {
	case time.Time:
		return typed.UTC()
	case *time.Time:
		if typed == nil {
			return time.Time{}
		}
		return typed.UTC()
	case string:
		return parseResetTimestamp(typed)
	case float64:
		return unixFromNumber(typed)
	case int64:
		return unixFromNumber(float64(typed))
	case int:
		return unixFromNumber(float64(typed))
	case jsonNumber:
		value, err := typed.Float64()
		if err != nil {
			return time.Time{}
		}
		return unixFromNumber(value)
	default:
		return time.Time{}
	}
}

func unixFromNumber(value float64) time.Time {
	if value <= 0 {
		return time.Time{}
	}
	seconds := value
	if value > 1e12 {
		seconds = value / 1000
	}
	whole := int64(seconds)
	fraction := time.Duration((seconds - float64(whole)) * float64(time.Second))
	return time.Unix(whole, int64(fraction)).UTC()
}

func parseResetTimestamp(raw string) time.Time {
	raw = strings.TrimSpace(raw)
	if raw == "" || raw == "null" {
		return time.Time{}
	}
	if parsed, err := time.Parse(time.RFC3339Nano, raw); err == nil {
		return parsed.UTC()
	}
	if parsed, err := time.Parse(time.RFC3339, raw); err == nil {
		return parsed.UTC()
	}
	if number, err := strconv.ParseFloat(raw, 64); err == nil {
		parsed := unixFromNumber(number)
		if !parsed.IsZero() {
			return parsed
		}
	}
	return time.Time{}
}

func floatFromExtra(raw any) float64 {
	switch typed := raw.(type) {
	case float64:
		return typed
	case float32:
		return float64(typed)
	case int:
		return float64(typed)
	case int64:
		return float64(typed)
	case jsonNumber:
		value, err := typed.Float64()
		if err != nil {
			return 0
		}
		return value
	case string:
		return floatFromExtraString(typed)
	default:
		return 0
	}
}

// jsonNumber matches encoding/json.Number without importing encoding/json in
// the helper signature. The real type is asserted in time/float parsers below.
type jsonNumber interface {
	Float64() (float64, error)
}
