package factory

import (
	"strings"
	"testing"
)

func TestFiniteRegistryProtocolsAndExcludedFamilies(t *testing.T) {
	seen := map[string]bool{}
	protocolCounts := map[Protocol]int{}
	for _, model := range Models() {
		if seen[model.ID] {
			t.Fatalf("duplicate model %q", model.ID)
		}
		seen[model.ID] = true
		protocolCounts[model.Protocol]++
		if model.Provider == "" {
			t.Fatalf("model %q has no provider", model.ID)
		}
		if IsFastOrGeminiID(model.ID) {
			t.Fatalf("excluded family leaked into registry: %q", model.ID)
		}
	}
	if protocolCounts[ProtocolAnthropic] == 0 || protocolCounts[ProtocolResponses] == 0 || protocolCounts[ProtocolChatCompletions] == 0 {
		t.Fatalf("all three protocols must be represented: %#v", protocolCounts)
	}
	for _, id := range []string{"claude-opus-5-5-fast", "gemini-3.8-flash", "auto", "gpt-6-astra-ultrafast"} {
		if _, ok := ResolveModel(id); ok {
			t.Fatalf("excluded model resolved: %s", id)
		}
	}
}

func TestPublicAndNativeResolutionIsExact(t *testing.T) {
	for _, model := range Models() {
		public := PublicModelPrefix + model.ID
		for _, input := range []string{model.ID, public, "  " + public + "  "} {
			got, ok := ResolveModel(input)
			if !ok || got.ID != model.ID || got.Protocol != model.Protocol {
				t.Fatalf("ResolveModel(%q) = %#v, %v", input, got, ok)
			}
		}
	}
	for _, input := range []string{"", "factory/", "factory/unknown", "claude-unknown", "factory/factory/claude-opus-5-5"} {
		if _, ok := ResolveModel(input); ok {
			t.Fatalf("unexpected resolution for %q", input)
		}
	}
	defaults := DefaultModelMapping()
	if len(defaults) != len(Models()) {
		t.Fatalf("default mapping size = %d, want %d", len(defaults), len(Models()))
	}
	for public, native := range defaults {
		if strings.TrimPrefix(public, PublicModelPrefix) != native {
			t.Fatalf("mapping %q -> %q is not exact", public, native)
		}
	}
}

func TestOpenAIProjectHeaderLiteralMatchesPinnedDroidEvidence(t *testing.T) {
	const want = "org-bHuLtG1fGmYk5YaOihAAXFBw"
	if OpenAIProjectHeader != want {
		t.Fatalf("OpenAIProjectHeader = %q, want pinned literal %q", OpenAIProjectHeader, want)
	}
}

func TestEndpointURLsAreFixedPerRegionAndProtocol(t *testing.T) {
	cases := []struct {
		region   string
		protocol Protocol
		want     string
	}{
		{RegionUS, ProtocolAnthropic, HostUS + "/api/llm/a/v1/messages"},
		{RegionUS, ProtocolResponses, HostUS + "/api/llm/o/v1/responses"},
		{RegionUS, ProtocolChatCompletions, HostUS + "/api/llm/o/v1/chat/completions"},
		{RegionEU, ProtocolAnthropic, HostEU + "/api/llm/a/v1/messages"},
		{RegionEU, ProtocolResponses, HostEU + "/api/llm/o/v1/responses"},
		{RegionEU, ProtocolChatCompletions, HostEU + "/api/llm/o/v1/chat/completions"},
	}
	for _, tc := range cases {
		got, ok := EndpointURL(tc.region, tc.protocol)
		if !ok || got != tc.want {
			t.Fatalf("EndpointURL(%q,%q) = %q,%v; want %q", tc.region, tc.protocol, got, ok, tc.want)
		}
	}
	if _, ok := EndpointURL("attacker.invalid", ProtocolResponses); ok {
		t.Fatal("arbitrary region accepted")
	}
}
