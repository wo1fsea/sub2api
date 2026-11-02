package factory

import (
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"testing"
)

func TestPrepareInferenceBodyAddsOnlyDroidPreambleAndIsIdempotent(t *testing.T) {
	cases := []struct {
		protocol     Protocol
		body         string
		preamblePath string
	}{
		{ProtocolAnthropic, `{"model":"factory/claude-opus-5-5","system":[{"type":"text","text":"caller system 世界","cache_control":{"type":"ephemeral"}}],"messages":[{"role":"user","content":"hi"}],"tools":[{"name":"t","input_schema":{"type":"object"}}],"custom_ext":{"keep":true}}`, "system"},
		{ProtocolResponses, `{"model":"factory/gpt-6.1-sol","instructions":"caller instructions","input":[{"role":"user","content":[{"type":"input_text","text":"hi"}]}],"tools":[{"type":"function","name":"f"}],"custom_ext":{"keep":true}}`, "instructions"},
		{ProtocolChatCompletions, `{"model":"factory/glm-5.3","messages":[{"role":"system","content":"caller system"},{"role":"user","content":"hi"}],"tools":[{"type":"function","function":{"name":"f"}}],"custom_ext":{"keep":true}}`, "messages.0.content"},
	}
	for _, tc := range cases {
		prepared, model, err := PrepareInferenceBody(tc.protocol, []byte(tc.body))
		if err != nil {
			t.Fatalf("%s: %v", tc.protocol, err)
		}
		if model.Protocol != tc.protocol {
			t.Fatalf("%s resolved protocol %s", tc.protocol, model.Protocol)
		}
		var got map[string]any
		if err := json.Unmarshal(prepared, &got); err != nil {
			t.Fatal(err)
		}
		if got["model"] != model.ID {
			t.Fatalf("%s model = %#v, want %q", tc.protocol, got["model"], model.ID)
		}
		if got["custom_ext"] == nil {
			t.Fatalf("%s dropped unknown extension fields: %s", tc.protocol, prepared)
		}
		text, _ := json.Marshal(got)
		if strings.Count(string(text), DroidLine) != 1 {
			t.Fatalf("%s preamble count != 1: %s", tc.protocol, text)
		}
		again, _, err := PrepareInferenceBody(tc.protocol, prepared)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Count(string(again), DroidLine) != 1 {
			t.Fatalf("%s preamble not idempotent: %s", tc.protocol, again)
		}
	}
}

func TestPrepareInferenceBodyRejectsFastGeminiAndProtocolMismatch(t *testing.T) {
	cases := []struct {
		protocol Protocol
		body     string
	}{
		{ProtocolAnthropic, `{"model":"claude-opus-5-5","speed":"fast"}`},
		{ProtocolResponses, `{"model":"gpt-5.5","service_tier":"priority"}`},
		{ProtocolResponses, `{"model":"factory/claude-opus-5-5","input":"hi"}`},
		{ProtocolChatCompletions, `{"model":"gemini-3.8-flash","messages":[]}`},
		{ProtocolChatCompletions, `{"model":"glm-5.3-fast","messages":[]}`},
		{ProtocolChatCompletions, `{"messages":[]}`},
	}
	for _, tc := range cases {
		if _, _, err := PrepareInferenceBody(tc.protocol, []byte(tc.body)); err == nil {
			t.Fatalf("accepted invalid body %s", tc.body)
		}
	}
}

func TestApplyRequestPolicyForcesFixedEndpointAndHeadersLast(t *testing.T) {
	credentials := Credentials{APIKey: "fk-test", Region: RegionEU, OrgID: "fac_org"}
	model, _ := ResolveModel("gpt-6.1-sol")
	req, _ := http.NewRequest(http.MethodPost, "https://attacker.invalid/generic", strings.NewReader(`{}`))
	req.Header.Set("Authorization", "Bearer attacker")
	req.Header.Set("x-api-key", "attacker")
	req.Header.Set("X-Factory-Org-Id", "wrong")
	req.Header.Set("User-Agent", "attacker-ua")
	if err := ApplyRequestPolicy(req, credentials, model, ProtocolResponses); err != nil {
		t.Fatal(err)
	}
	want, _ := url.Parse(HostEU + "/api/llm/o/v1/responses")
	if req.URL.String() != want.String() {
		t.Fatalf("URL = %s, want %s", req.URL, want)
	}
	if req.Header.Get("Authorization") != "Bearer fk-test" || req.Header.Get("X-Api-Key") != "" {
		t.Fatalf("auth headers not forced: %#v", req.Header)
	}
	if req.Header.Get("X-Factory-Org-Id") != "fac_org" || req.Header.Get("x-provider-routing-source") != "registry_default" || req.Header.Get("x-api-provider") != "openai" {
		t.Fatalf("Factory headers wrong: %#v", req.Header)
	}
	if req.Header.Get("OpenAI-Platform") != OpenAIProjectHeader {
		t.Fatalf("OpenAI-Platform = %q", req.Header.Get("OpenAI-Platform"))
	}
	if req.Header.Get("X-Session-Id") == "" || req.Header.Get("X-Assistant-Message-Id") == "" {
		t.Fatal("missing generated ids")
	}
}

func TestApplyRequestPolicyAnthropicPlaceholderAndFastBetaMatching(t *testing.T) {
	credentials := Credentials{APIKey: "fk-test", Region: RegionUS}
	model, _ := ResolveModel("claude-opus-5-5")
	req, _ := http.NewRequest(http.MethodPost, "https://api.factory.ai/api/llm/a/v1/messages", strings.NewReader(`{}`))
	if err := ApplyRequestPolicy(req, credentials, model, ProtocolAnthropic); err != nil {
		t.Fatal(err)
	}
	if req.Header.Get("X-Api-Key") != "placeholder" || req.Header.Get("OpenAI-Platform") != "" || req.Header.Get("X-Factory-Org-Id") != "" {
		t.Fatalf("unexpected Anthropic headers: %#v", req.Header)
	}
	bad, _ := http.NewRequest(http.MethodPost, "https://api.factory.ai/api/llm/a/v1/messages", strings.NewReader(`{}`))
	bad.Header["Anthropic-Beta"] = []string{"some-beta,fast-mode-2026-02-01"}
	if err := ApplyRequestPolicy(bad, credentials, model, ProtocolAnthropic); err == nil {
		t.Fatal("mixed-case fast beta header was accepted")
	}
}
