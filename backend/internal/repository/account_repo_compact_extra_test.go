package repository

import "testing"

func TestShouldEnqueueSchedulerOutboxForExtraUpdates_CompactCapabilityKeysAreRelevant(t *testing.T) {
	updates := map[string]any{
		"openai_compact_supported":  true,
		"openai_compact_checked_at": "2026-04-10T10:00:00Z",
	}

	if !shouldEnqueueSchedulerOutboxForExtraUpdates(updates) {
		t.Fatalf("expected compact capability updates to enqueue scheduler outbox")
	}
}

func TestShouldEnqueueSchedulerOutboxForExtraUpdates_OpenAIResponsesCapabilityKeysAreRelevant(t *testing.T) {
	updates := map[string]any{
		"openai_responses_mode":      "force_chat_completions",
		"openai_responses_supported": false,
	}

	if !shouldEnqueueSchedulerOutboxForExtraUpdates(updates) {
		t.Fatalf("expected responses capability updates to enqueue scheduler outbox")
	}
}

func TestShouldEnqueueSchedulerOutboxForExtraUpdates_QuotaSampleMetadataIsNeutral(t *testing.T) {
	updates := map[string]any{
		"session_window_sampled_at":          "2026-10-08T00:00:00Z",
		"session_window_source":              "response_headers",
		"session_window_reset":               1234,
		"passive_usage_7d_sonnet_sampled_at": "2026-10-08T00:00:00Z",
		"codex_5h_sampled_at":                "2026-10-08T00:00:00Z",
		"codex_7d_source":                    "upstream",
	}
	if shouldEnqueueSchedulerOutboxForExtraUpdates(updates) {
		t.Fatal("display-only quota metadata must not rebuild scheduler buckets")
	}
}
