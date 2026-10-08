package service

import (
	"encoding/json"
	"math"
	"strconv"
	"strings"
	"time"
)

// AccountQuotaWindow is an observed subscription limit, independently of the
// legacy usage bars and local cost statistics. Nil utilization means unknown;
// an elapsed reset keeps the last observation until a new sample arrives.
type AccountQuotaWindow struct {
	Key           string     `json:"key"`
	Utilization   *float64   `json:"utilization"`
	ResetsAt      *time.Time `json:"resets_at"`
	SampledAt     *time.Time `json:"sampled_at"`
	Source        string     `json:"source"`
	WindowMinutes int        `json:"window_minutes,omitempty"`
	Scope         string     `json:"scope"`
	Model         string     `json:"model,omitempty"`
}

func (w *OpenAIRateLimitWindow) UnmarshalJSON(data []byte) error {
	type legacyWindow OpenAIRateLimitWindow
	var decoded legacyWindow
	if err := json.Unmarshal(data, &decoded); err != nil {
		return err
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return err
	}
	decoded.quotaFieldPresence = make(map[string]bool)
	for _, key := range []string{"used_percent", "limit_window_seconds", "reset_after_seconds", "reset_at"} {
		raw := fields[key]
		decoded.quotaFieldPresence[key] = len(raw) > 0 && string(raw) != "null"
	}
	*w = OpenAIRateLimitWindow(decoded)
	return nil
}

func openAIQuotaFieldPresent(window *OpenAIRateLimitWindow, key string) bool {
	return window.quotaFieldPresence == nil || window.quotaFieldPresence[key]
}

// Body responses expose an absolute reset_at; prefer it to relative metadata.
// A missing or null used_percent is not an observed zero. Structs constructed
// internally without a presence map retain their existing value semantics.
func applyOpenAIObservedQuotaWindow(snapshot *OpenAICodexUsageSnapshot, window *OpenAIRateLimitWindow, primary bool, sampledAt time.Time) {
	if window == nil {
		return
	}
	var used *float64
	if openAIQuotaFieldPresent(window, "used_percent") {
		used = quotaUtilization(window.UsedPercent, 1)
	}
	var resetAfter, windowMinutes *int
	if openAIQuotaFieldPresent(window, "reset_at") && window.ResetAt > 0 {
		if resetAt := quotaUnixTime(window.ResetAt); resetAt != nil {
			seconds := int(resetAt.Unix() - sampledAt.Unix())
			resetAfter = &seconds
		}
	} else if openAIQuotaFieldPresent(window, "reset_after_seconds") {
		seconds := int(window.ResetAfterSeconds)
		resetAfter = &seconds
	}
	if openAIQuotaFieldPresent(window, "limit_window_seconds") && window.LimitWindowSeconds > 0 {
		minutes := int(window.LimitWindowSeconds / 60)
		windowMinutes = &minutes
	}
	if primary {
		snapshot.PrimaryUsedPercent, snapshot.PrimaryResetAfterSeconds, snapshot.PrimaryWindowMinutes = used, resetAfter, windowMinutes
	} else {
		snapshot.SecondaryUsedPercent, snapshot.SecondaryResetAfterSeconds, snapshot.SecondaryWindowMinutes = used, resetAfter, windowMinutes
	}
}

// Preserve presence separately from the legacy value fields: decoding an
// omitted or null utilization into float64 must not turn it into a real 0%.
func (r *ClaudeUsageResponse) UnmarshalJSON(data []byte) error {
	type legacyResponse ClaudeUsageResponse
	var decoded legacyResponse
	if err := json.Unmarshal(data, &decoded); err != nil {
		return err
	}
	var windows map[string]json.RawMessage
	if err := json.Unmarshal(data, &windows); err != nil {
		return err
	}
	decoded.quotaFieldPresence = make(map[string]bool)
	for _, key := range []string{"five_hour", "seven_day", "seven_day_sonnet", "seven_day_overage_included"} {
		var fields map[string]json.RawMessage
		if raw := windows[key]; len(raw) == 0 || json.Unmarshal(raw, &fields) != nil || fields == nil {
			continue
		}
		decoded.quotaFieldPresence[key] = true
		raw := fields["utilization"]
		decoded.quotaFieldPresence[key+".utilization"] = len(raw) > 0 && string(raw) != "null"
	}
	*r = ClaudeUsageResponse(decoded)
	return nil
}

func quotaNumber(raw any) *float64 {
	var value float64
	var err error
	switch v := raw.(type) {
	case float64:
		value = v
	case float32:
		value = float64(v)
	case int:
		value = float64(v)
	case int64:
		value = float64(v)
	case json.Number:
		value, err = v.Float64()
	case string:
		value, err = strconv.ParseFloat(strings.TrimSpace(v), 64)
	default:
		return nil
	}
	if err != nil || math.IsNaN(value) || math.IsInf(value, 0) {
		return nil
	}
	return &value
}

func quotaUtilization(raw any, scale float64) *float64 {
	value := quotaNumber(raw)
	if value == nil || *value < 0 {
		return nil
	}
	*value *= scale
	if math.IsNaN(*value) || math.IsInf(*value, 0) {
		return nil
	}
	return value
}

func quotaTime(raw any) *time.Time {
	if value, ok := raw.(string); ok {
		if stamp, err := parseTime(strings.TrimSpace(value)); err == nil && !stamp.IsZero() {
			return &stamp
		}
	}
	return nil
}

func quotaUnixTime(raw any) *time.Time {
	value := quotaNumber(raw)
	if value == nil || *value <= 0 || *value > 253402300799 {
		return nil
	}
	stamp := time.Unix(int64(*value), 0)
	return &stamp
}

func quotaSource(raw any, fallback string) string {
	value, _ := raw.(string)
	switch value {
	case "upstream", "response_headers", "estimated", "local":
		return value
	default:
		return fallback
	}
}

// Once a writer records per-window times, do not reuse the shared timestamp for
// an untouched older window. Older snapshots can still use their stored sample
// time; they never inherit the time that the UI requested the snapshot.
func quotaSampleTime(extra map[string]any, key, legacyKey string, hasWindowSamples bool) *time.Time {
	if _, exists := extra[key]; exists || hasWindowSamples {
		return quotaTime(extra[key])
	}
	return quotaTime(extra[legacyKey])
}

func buildOpenAIQuotaWindows(extra map[string]any) []AccountQuotaWindow {
	var windows []AccountQuotaWindow
	_, has5hSample := extra["codex_5h_sampled_at"]
	_, has7dSample := extra["codex_7d_sampled_at"]
	for _, entry := range []struct{ suffix, key string }{{"5h", "five_hour"}, {"7d", "seven_day"}} {
		prefix := "codex_" + entry.suffix
		utilization := quotaUtilization(extra[prefix+"_used_percent"], 1)
		resetAt := quotaTime(extra[prefix+"_reset_at"])
		sampledAt := quotaSampleTime(extra, prefix+"_sampled_at", "codex_usage_updated_at", has5hSample || has7dSample)
		resetAfter := quotaNumber(extra[prefix+"_reset_after_seconds"])
		if resetAt == nil && sampledAt != nil {
			if resetAfter != nil && math.Abs(*resetAfter) < float64(math.MaxInt64/int64(time.Second)) {
				stamp := sampledAt.Add(time.Duration(*resetAfter) * time.Second)
				resetAt = &stamp
			}
		}
		// An explicitly observed 0%/0-second pair provides no future reset.
		// Legacy writers anchor that zero countdown to the sample time. Hide
		// only this display deadline; retain the observation's age, raw Extra
		// and scheduling fields, and prefer any real future absolute deadline.
		if utilization != nil && *utilization == 0 && resetAfter != nil && *resetAfter == 0 && sampledAt != nil && resetAt != nil && !resetAt.After(*sampledAt) {
			resetAt = nil
		}
		if utilization == nil && resetAt == nil && sampledAt == nil {
			continue
		}
		windows = append(windows, AccountQuotaWindow{
			Key: entry.key, Utilization: utilization, ResetsAt: resetAt, SampledAt: sampledAt,
			Source: quotaSource(extra[prefix+"_source"], "upstream"), Scope: "account",
			WindowMinutes: max(0, parseExtraInt(extra[prefix+"_window_minutes"])),
		})
	}
	return windows
}

// A successful usage body is a complete observation of both slots, including
// unused/null slots. Explicitly replace unavailable percentages with unknown so
// that previously cached readings cannot become fabricated fresh zeroes.
func buildOpenAIQuotaObservationUpdates(usage *OpenAIQuotaUsage, shadow bool, sampledAt time.Time) map[string]any {
	if usage == nil {
		return nil
	}
	if usage.FetchedAt > 0 {
		sampledAt = time.Unix(usage.FetchedAt, 0)
	}
	rateLimit := usage.RateLimit
	if shadow {
		rateLimit = nil
		for _, additional := range usage.AdditionalRateLimits {
			if additional.MeteredFeature == "codex_bengalfox" {
				rateLimit = additional.RateLimit
				break
			}
		}
	}
	if rateLimit == nil || (rateLimit.PrimaryWindow == nil && rateLimit.SecondaryWindow == nil) {
		return nil
	}
	snapshot := &OpenAICodexUsageSnapshot{}
	applyOpenAIObservedQuotaWindow(snapshot, rateLimit.PrimaryWindow, true, sampledAt)
	applyOpenAIObservedQuotaWindow(snapshot, rateLimit.SecondaryWindow, false, sampledAt)
	normalized := snapshot.Normalize()
	if normalized == nil {
		return nil
	}
	updates := map[string]any{"codex_usage_updated_at": sampledAt.UTC().Format(time.RFC3339Nano)}
	for _, slot := range []struct {
		prefix  string
		used    *float64
		reset   *int
		minutes *int
	}{
		{"codex_5h", normalized.Used5hPercent, normalized.Reset5hSeconds, normalized.Window5hMinutes},
		{"codex_7d", normalized.Used7dPercent, normalized.Reset7dSeconds, normalized.Window7dMinutes},
	} {
		updates[slot.prefix+"_used_percent"] = nil
		updates[slot.prefix+"_reset_after_seconds"] = nil
		updates[slot.prefix+"_window_minutes"] = nil
		updates[slot.prefix+"_reset_at"] = nil
		updates[slot.prefix+"_sampled_at"] = sampledAt.UTC().Format(time.RFC3339Nano)
		updates[slot.prefix+"_source"] = "upstream"
		if slot.used != nil {
			updates[slot.prefix+"_used_percent"] = *slot.used
		}
		if slot.minutes != nil {
			updates[slot.prefix+"_window_minutes"] = *slot.minutes
		}
		if slot.reset != nil {
			updates[slot.prefix+"_reset_after_seconds"] = *slot.reset
			resetAt := sampledAt.Add(time.Duration(*slot.reset) * time.Second)
			updates[slot.prefix+"_reset_at"] = resetAt.UTC().Format(time.RFC3339Nano)
		}
	}
	return updates
}

func buildAnthropicPassiveQuotaWindows(account *Account) []AccountQuotaWindow {
	if account == nil {
		return nil
	}
	extra := account.Extra
	prefixes := []string{"session_window", "passive_usage_7d", "passive_usage_7d_sonnet", "passive_usage_7d_oi"}
	hasWindowSamples := false
	for _, prefix := range prefixes {
		if _, exists := extra[prefix+"_sampled_at"]; exists {
			hasWindowSamples = true
		}
	}
	var windows []AccountQuotaWindow
	for i, entry := range []struct {
		key, model string
		minutes    int
	}{{"five_hour", "", 300}, {"seven_day", "", 10080}, {"seven_day_sonnet", "Sonnet", 10080}, {"seven_day_fable", "Fable", 10080}} {
		prefix := prefixes[i]
		utilization := quotaUtilization(extra[prefix+"_utilization"], 100)
		resetAt := quotaUnixTime(extra[prefix+"_reset"])
		if i == 0 {
			if _, explicitlyObserved := extra[prefix+"_reset"]; !explicitlyObserved {
				resetAt = account.SessionWindowEnd
			}
		}
		if utilization == nil && resetAt == nil {
			continue
		}
		source := quotaSource(extra[prefix+"_source"], "upstream")
		sampledAt := quotaSampleTime(extra, prefix+"_sampled_at", "passive_usage_sampled_at", hasWindowSamples)
		if i == 0 && utilization == nil {
			// Status is a coarse signal, never an observed quota percentage.
			source, sampledAt = "estimated", nil
			switch account.SessionWindowStatus {
			case "rejected":
				utilization = quotaUtilization(100.0, 1)
			case "allowed_warning":
				utilization = quotaUtilization(80.0, 1)
			}
		}
		scope := "account"
		if entry.model != "" {
			scope = "model"
		}
		windows = append(windows, AccountQuotaWindow{
			Key: entry.key, Utilization: utilization, ResetsAt: resetAt, SampledAt: sampledAt,
			Source: source, Scope: scope, Model: entry.model, WindowMinutes: entry.minutes,
		})
	}
	return windows
}

func anthropicQuotaExtraPrefix(key string) string {
	switch key {
	case "five_hour":
		return "session_window"
	case "seven_day":
		return "passive_usage_7d"
	case "seven_day_sonnet":
		return "passive_usage_7d_sonnet"
	case "seven_day_fable":
		return "passive_usage_7d_oi"
	default:
		return ""
	}
}

func buildAnthropicActiveQuotaWindows(resp *ClaudeUsageResponse, sampledAt *time.Time) []AccountQuotaWindow {
	if resp == nil {
		return nil
	}
	var windows []AccountQuotaWindow
	for _, entry := range []struct {
		key, upstreamKey, model string
		utilization             float64
		reset                   string
		minutes                 int
	}{
		{"five_hour", "five_hour", "", resp.FiveHour.Utilization, resp.FiveHour.ResetsAt, 300},
		{"seven_day", "seven_day", "", resp.SevenDay.Utilization, resp.SevenDay.ResetsAt, 10080},
		{"seven_day_sonnet", "seven_day_sonnet", "Sonnet", resp.SevenDaySonnet.Utilization, resp.SevenDaySonnet.ResetsAt, 10080},
		{"seven_day_fable", "seven_day_overage_included", "Fable", resp.SevenDayOverageIncluded.Utilization, resp.SevenDayOverageIncluded.ResetsAt, 10080},
	} {
		hasWindow := entry.utilization != 0 || entry.reset != ""
		hasUtilization := hasWindow
		if resp.quotaFieldPresence != nil {
			hasWindow = resp.quotaFieldPresence[entry.upstreamKey]
			hasUtilization = resp.quotaFieldPresence[entry.upstreamKey+".utilization"]
		}
		if !hasWindow {
			continue
		}
		var utilization *float64
		if hasUtilization {
			utilization = quotaUtilization(entry.utilization, 1)
		}
		scope := "account"
		if entry.model != "" {
			scope = "model"
		}
		windows = append(windows, AccountQuotaWindow{
			Key: entry.key, Utilization: utilization, ResetsAt: quotaTime(entry.reset), SampledAt: sampledAt,
			Source: "upstream", Scope: scope, Model: entry.model, WindowMinutes: entry.minutes,
		})
	}
	return windows
}

// recordCodexQuotaWindowSamples is called by both response-header and upstream
// usage writers. Only a new utilization observation advances its sample time.
func recordCodexQuotaWindowSamples(updates map[string]any, sampledAt time.Time, source string) {
	for _, suffix := range []string{"5h", "7d"} {
		prefix := "codex_" + suffix
		if quotaUtilization(updates[prefix+"_used_percent"], 1) != nil {
			updates[prefix+"_sampled_at"] = sampledAt.UTC().Format(time.RFC3339Nano)
			updates[prefix+"_source"] = source
		}
	}
}
