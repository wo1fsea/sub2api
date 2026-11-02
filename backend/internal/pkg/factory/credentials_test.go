package factory

import (
	"strings"
	"testing"
)

func TestNormalizeCredentialsStrictAndCanonicalModelMapping(t *testing.T) {
	credentials := map[string]any{
		"api_key": " fk-test_Key-123 ", "region": " EU ", "factory_org_id": "fac_org-1",
		"model_mapping": map[string]any{"team-alias": "factory/claude-opus-5-5"},
	}
	if err := NormalizeCredentials(credentials, true); err != nil {
		t.Fatal(err)
	}
	if credentials["api_key"] != "fk-test_Key-123" || credentials["region"] != RegionEU || credentials["factory_org_id"] != "fac_org-1" {
		t.Fatalf("unexpected normalized credentials: %#v", credentials)
	}
	mapping := credentials["model_mapping"].(map[string]any)
	if mapping["team-alias"] != "claude-opus-5-5" {
		t.Fatalf("mapping target was not canonicalized to native: %#v", mapping)
	}
}

func TestNormalizeCredentialsRejectsMalformedWithoutEchoingSecrets(t *testing.T) {
	cases := []map[string]any{
		{"api_key": "not-factory"},
		{"api_key": "fk-valid.secret"},
		{"api_key": "fk-valid key"},
		{"api_key": "fk-valid", "region": "mars"},
		{"api_key": "fk-valid", "factory_org_id": "bad org"},
		{"api_key": "fk-valid", "model_mapping": map[string]any{"alias": "factory/gemini-3.8-flash"}},
		{"api_key": "fk-valid", "model_mapping": map[string]any{"alias": "glm-5.3", " alias ": "claude-opus-5-5"}},
		{"api_key": "fk-valid", "base_url": "https://evil.invalid", "opaque-secret-key-name": "do-not-echo"},
	}
	for _, credentials := range cases {
		err := NormalizeCredentials(credentials, true)
		if err == nil {
			t.Fatalf("accepted invalid credentials: %#v", credentials)
		}
		if strings.Contains(err.Error(), "do-not-echo") || strings.Contains(err.Error(), "opaque-secret-key-name") || strings.Contains(err.Error(), "fk-valid.secret") {
			t.Fatalf("credential value/key leaked in error: %v", err)
		}
	}
}

func TestParseCredentialsDefaultsRegionAndDoesNotMutate(t *testing.T) {
	source := map[string]any{"api_key": "fk-valid", "factory_org_id": ""}
	parsed, err := ParseCredentials(source, true)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Region != RegionUS || parsed.OrgID != "" || parsed.ModelMapping != nil {
		t.Fatalf("unexpected parsed credentials: %#v", parsed)
	}
	if source["region"] != nil {
		t.Fatalf("ParseCredentials mutated source: %#v", source)
	}
}

func TestCredentialsRejectUnsupportedKeysIncludingEndpointOverrides(t *testing.T) {
	for _, key := range []string{"base_url", "api_base_urls", "protocol_rules", "api_protocol", "access_token", "refresh_token", "cookie", "header_overrides"} {
		if err := NormalizeCredentials(map[string]any{"api_key": "fk-valid", key: "x"}, true); err == nil {
			t.Fatalf("accepted unsupported credential key %q", key)
		}
	}
}
