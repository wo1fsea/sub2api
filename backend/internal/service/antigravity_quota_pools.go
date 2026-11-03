package service

import (
	"math"
	"strings"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/pkg/antigravity"
)

// Preserve upstream group membership and order. Never infer a weekly pool from
// model names or time-to-reset, and never turn an omitted fraction into zero.
func buildAntigravityQuotaPools(summary *antigravity.QuotaSummary, sampledAt time.Time) []AccountQuotaWindow {
	if summary == nil {
		return nil
	}
	var windows []AccountQuotaWindow
	seen := make(map[string]bool)
	for _, group := range summary.Groups {
		if strings.TrimSpace(group.DisplayName) == "" {
			continue
		}
		for _, bucket := range group.Buckets {
			if bucket.BucketID == "" || seen[bucket.BucketID] {
				continue
			}
			seen[bucket.BucketID] = true
			window := AccountQuotaWindow{
				Key: "antigravity_pool:" + bucket.BucketID, Pool: group.DisplayName,
				DisplayName: bucket.DisplayName, Scope: "pool", Source: "upstream",
				SampledAt: &sampledAt, Disabled: bucket.Disabled,
			}
			switch bucket.Window {
			case "weekly":
				window.WindowMinutes = 7 * 24 * 60
			case "5h":
				window.WindowMinutes = 5 * 60
			}
			if v := bucket.RemainingFraction; !bucket.Disabled && v != nil && !math.IsNaN(*v) && !math.IsInf(*v, 0) && *v >= 0 && *v <= 1 {
				used := (1 - *v) * 100
				window.Utilization = &used
			}
			if reset, err := time.Parse(time.RFC3339, bucket.ResetTime); err == nil {
				window.ResetsAt = &reset
			}
			windows = append(windows, window)
		}
	}
	return windows
}
