package service

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestCodexClaudeVisionCatalog(t *testing.T) {
	ids := []string{
		"claude-opus-5-5", "anthropic/claude-sonnet-4-6",
		"factory/claude-opus-5-5", "factory/claude-sonnet-5-5",
		"factory/claude-haiku-5-5", "factory/claude-opus-4-6",
		"factory/claude-sonnet-4-6", "factory/claude-haiku-4-5",
	}
	for _, id := range ids {
		t.Run(id, func(t *testing.T) {
			body, err := buildCodexModelsManifest([]string{id}, nil, nil, nil, nil)
			require.NoError(t, err)
			model := decodeCodexManifestModels(t, body)[0]
			require.Equal(t, id, model["slug"])
			require.Equal(t, []any{"text", "image"}, model["input_modalities"])
			require.Equal(t, true, model["supports_image_detail_original"])
		})
	}
	// Arbitrary public aliases inherit the resolved Claude capability too.
	body, err := buildCodexModelsManifest([]string{"private-alias"}, nil, nil,
		map[string]string{"private-alias": "claude-opus-5-5"}, nil)
	require.NoError(t, err)
	require.Equal(t, []any{"text", "image"}, decodeCodexManifestModels(t, body)[0]["input_modalities"])
	for _, id := range []string{"factory/gpt-6-astra", "factory/gpt-oss-120b", "deepseek-v4-flash", "custom-model"} {
		descriptor := newConfiguredCodexModelDescriptor(id)
		require.Equal(t, []string{"text"}, descriptor.InputModalities, id)
		require.False(t, descriptor.SupportsImageDetailOriginal, id)
	}
}
