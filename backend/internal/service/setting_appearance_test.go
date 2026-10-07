//go:build unit

package service

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/config"
	"github.com/stretchr/testify/require"
)

func TestSiteAppearancePublicAndInjection(t *testing.T) {
	want := SiteAppearance{Skin: "original", Mode: "dark", AccentColor: "#102030"}
	encoded, err := json.Marshal(want)
	require.NoError(t, err)
	svc := NewSettingService(&settingPublicRepoStub{values: map[string]string{SettingKeySiteAppearance: string(encoded)}}, &config.Config{})
	public, err := svc.GetPublicSettings(context.Background())
	require.NoError(t, err)
	require.Equal(t, want, public.SiteAppearance)
	injected, err := svc.GetPublicSettingsForInjection(context.Background())
	require.NoError(t, err)
	data, err := json.Marshal(injected)
	require.NoError(t, err)
	var decoded struct {
		SiteAppearance SiteAppearance `json:"site_appearance"`
	}
	require.NoError(t, json.Unmarshal(data, &decoded))
	require.Equal(t, want, decoded.SiteAppearance)
}

func TestSiteAppearanceDefaults(t *testing.T) {
	for _, stored := range []string{"", "null", "{}", `{"skin":"unknown","mode":"light","accent_color":"#ffffff"}`} {
		require.Equal(t, DefaultSiteAppearance(), parseSiteAppearance(stored))
	}
}
