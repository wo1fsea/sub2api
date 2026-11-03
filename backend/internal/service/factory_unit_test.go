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

	account.Credentials["model_mapping"] = map[string]any{"team-alias": "factory/claude-sonnet-4-6"}
	require.True(t, account.IsModelSupported("team-alias"))
	require.False(t, account.IsModelSupported("factory/claude-opus-5-5"), "explicit mapping must be an account allowlist")
	require.False(t, account.IsModelSupported("claude-opus-5-5"), "explicit mapping must not admit unlisted native ids")
	require.False(t, account.IsModelSupported("factory/gpt-5.5"), "explicit mapping must not admit other public ids")
	mapped, matched := account.ResolveMappedModel("team-alias")
	require.True(t, matched)
	require.Equal(t, "claude-sonnet-4-6", mapped)
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

func TestFactoryRemovedNamesCannotBeRevivedByMappings(t *testing.T) {
	for _, mapping := range []map[string]any{
		{"factory/gpt-6.1-sol": "gpt-6.1-sol"},
		{"factory/gpt-6.1-sol": "claude-sonnet-4-6"},
		{"gpt-6.1-sol": "claude-sonnet-4-6"},
		{"factory/*": "claude-sonnet-4-6"},
		{"*": "claude-sonnet-4-6"},
		{"old-gpt": "gpt-6.1-sol"},
	} {
		account := &Account{Platform: PlatformFactory, Type: AccountTypeAPIKey, Credentials: map[string]any{"api_key": "fk-test", "model_mapping": mapping}}
		require.Empty(t, account.GetModelMapping(), "removed mappings must not be advertised")
		require.False(t, account.IsModelSupported("claude-sonnet-4-6"), "discarded mapping must not admit a native fallback")
		for _, requested := range []string{"factory/gpt-6.1-sol", "factory/glm-5.3", "old-gpt"} {
			require.False(t, account.IsModelSupported(requested))
			_, matched := account.ResolveMappedModel(requested)
			require.False(t, matched)
		}
	}
	wildcard := &Account{Platform: PlatformFactory, Type: AccountTypeAPIKey, Credentials: map[string]any{"model_mapping": map[string]any{"*": "claude-sonnet-4-6"}}}
	for _, requested := range []string{"factory/gpt-6.1-sol", "gpt-6-astra", "glm-5.3", "minimax-m2.7", "grok-4.7"} {
		require.False(t, wildcard.IsModelSupported(requested))
		_, matched := wildcard.ResolveMappedModel(requested)
		require.False(t, matched)
	}
	require.Empty(t, wildcard.GetModelMapping(), "wildcards must not be advertised as model IDs")
	require.False(t, wildcard.IsModelSupported("team-chat"), "discarded wildcard must fail closed")
	require.False(t, wildcard.IsModelSupported("factory/claude-sonnet-4-6"))
	for _, accountType := range []string{AccountTypeAPIKey, AccountTypeOAuth} {
		account := &Account{Platform: PlatformOpenAI, Type: accountType, Credentials: map[string]any{}}
		require.True(t, account.IsModelSupported("gpt-6-astra"))
	}
}
