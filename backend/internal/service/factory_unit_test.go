//go:build unit

package service

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestFactoryModelSupportHonorsFiniteRegistryAndExplicitAllowlist(t *testing.T) {
	account := &Account{Platform: PlatformFactory, Type: AccountTypeAPIKey, Credentials: map[string]any{"api_key": "fk-test"}}
	require.True(t, account.IsModelSupported("factory/claude-opus-5-5"))
	require.True(t, account.IsModelSupported("claude-opus-5-5"))
	require.False(t, account.IsModelSupported("factory/gemini-3.8-flash"))
	require.False(t, account.IsModelSupported("factory/unknown"))

	account.Credentials["model_mapping"] = map[string]any{"team-alias": "factory/glm-5.3"}
	require.True(t, account.IsModelSupported("team-alias"))
	require.False(t, account.IsModelSupported("factory/claude-opus-5-5"), "explicit mapping must be an account allowlist")
	require.False(t, account.IsModelSupported("claude-opus-5-5"), "explicit mapping must not admit unlisted native ids")
	require.False(t, account.IsModelSupported("factory/gpt-5.5"), "explicit mapping must not admit other public ids")
	mapped, matched := account.ResolveMappedModel("team-alias")
	require.True(t, matched)
	require.Equal(t, "glm-5.3", mapped)
	if resolved, matched := account.ResolveMappedModel("factory/claude-opus-5-5"); matched || resolved != "factory/claude-opus-5-5" {
		t.Fatalf("unlisted public id resolved to %q matched=%v", resolved, matched)
	}
}

func TestFactoryErrorDiagnosticsMaskEscapedSecretsWithoutTouchingSuccessFields(t *testing.T) {
	secret := "fk-diagnostic_secret-9101"
	account := &Account{Platform: PlatformFactory, Type: AccountTypeAPIKey, Credentials: map[string]any{"api_key": secret}}
	body := []byte(`{"error":{"message":"\u0066k-diagnostic_secret-9101"},"usage":{"input_tokens":7,"output_tokens":2},"tool_output":"PRESERVE_ME"}`)
	sanitized := string(sanitizeFactoryDiagnosticBody(account, body))
	require.NotContains(t, sanitized, secret)
	require.Contains(t, sanitized, "PRESERVE_ME")
	require.Contains(t, sanitized, `"input_tokens":7`)
	line := `data: {"type":"error","error":{"message":"upstream ` + secret + `"},"usage":{"input_tokens":7}}`
	maskedLine := sanitizeFactoryChatSSELine(account, line)
	require.NotContains(t, maskedLine, secret)
	require.Contains(t, maskedLine, "input_tokens")
	require.True(t, strings.Contains(sanitizeFactoryDiagnosticHeader(account, secret), "fk-***"))
}
