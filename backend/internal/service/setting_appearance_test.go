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
	for _, stored := range []string{"", "null", "{}", `{"skin":"unknown","mode":"light","accent_color":"#ffffff"}`, `{"skin":"monochrome","mode":"auto","accent_color":"#ffffff"}`, `{"skin":"monochrome","mode":"light","accent_color":"red"}`} {
		require.Equal(t, DefaultSiteAppearance(), parseSiteAppearance(stored))
	}
}

func TestSiteAppearanceMonochromeValidatesInBothModes(t *testing.T) {
	for _, mode := range []string{"light", "dark"} {
		want := SiteAppearance{Skin: "monochrome", Mode: mode, AccentColor: "#d4ff3f"}
		require.NoError(t, want.Validate())
		encoded, err := json.Marshal(want)
		require.NoError(t, err)
		require.Equal(t, want, parseSiteAppearance(string(encoded)))
	}
	// The stored accent remains valid for other skins even though monochrome ignores it.
	require.NoError(t, SiteAppearance{Skin: "monochrome", Mode: "dark", AccentColor: "#102030"}.Validate())
	require.NoError(t, SiteAppearance{Skin: "neubrutalism", Mode: "light", AccentColor: "#d4ff3f"}.Validate())
	require.NoError(t, SiteAppearance{Skin: "original", Mode: "dark", AccentColor: "#ffffff"}.Validate())
	require.Equal(t, DefaultSiteAppearance(), parseSiteAppearance(`{"skin":"monochrome","mode":"light","accent_color":"#fff"}`))
	require.Contains(t, SiteAppearance{Skin: "neon", Mode: "light", AccentColor: "#ffffff"}.Validate().Error(), "monochrome")
}
