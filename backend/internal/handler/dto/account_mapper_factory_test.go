package dto

import (
	"encoding/json"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/stretchr/testify/require"
)

func TestAccountFromServiceShallow_FactoryRedactsKeyAndPreservesRouting(t *testing.T) {
	mapping := map[string]any{
		"factory/gpt-5.5": "gpt-5.5",
	}
	src := &service.Account{
		ID:       9101,
		Name:     "factory-eu",
		Platform: service.PlatformFactory,
		Type:     service.AccountTypeAPIKey,
		Credentials: map[string]any{
			"api_key":         "fk-factory-secret-9101",
			"region":          "eu",
			"factory_org_id":  "fac_org_9101",
			"model_mapping":   mapping,
			"base_url":        "https://caller-controlled.example",
			"header_override": map[string]any{"Authorization": "Bearer caller"},
		},
	}

	got := AccountFromServiceShallow(src)
	require.NotNil(t, got)
	require.NotContains(t, got.Credentials, "api_key")
	require.True(t, got.CredentialsStatus["has_api_key"])
	require.Equal(t, "eu", got.Credentials["region"])
	require.Equal(t, "fac_org_9101", got.Credentials["factory_org_id"])
	require.Equal(t, mapping, got.Credentials["model_mapping"])

	raw, err := json.Marshal(got)
	require.NoError(t, err)
	require.NotContains(t, string(raw), "fk-factory-secret-9101")
	require.Contains(t, string(raw), `"has_api_key":true`)

	// DTO projection must never mutate the service account used by the gateway.
	require.Equal(t, "fk-factory-secret-9101", src.Credentials["api_key"])
}
