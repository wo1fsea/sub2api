//go:build unit

package admin

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/stretchr/testify/require"
)

func TestUpdateSettingsSiteAppearanceRoundTripAndOmission(t *testing.T) {
	h, repo := newStepUpSwitchTestHandler(t, map[string]string{})
	want := service.SiteAppearance{Skin: "original", Mode: "dark", AccentColor: "#112233"}
	rec := doUpdateSettings(t, h, map[string]any{"site_appearance": want}, nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var persisted service.SiteAppearance
	require.NoError(t, json.Unmarshal([]byte(repo.values[service.SettingKeySiteAppearance]), &persisted))
	require.Equal(t, want, persisted)
	var response struct {
		Data struct {
			SiteAppearance service.SiteAppearance `json:"site_appearance"`
		} `json:"data"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &response))
	require.Equal(t, want, response.Data.SiteAppearance)
	rec = doUpdateSettings(t, h, map[string]any{"site_name": "New name"}, nil)
	require.Equal(t, http.StatusOK, rec.Code)
	require.NoError(t, json.Unmarshal([]byte(repo.values[service.SettingKeySiteAppearance]), &persisted))
	require.Equal(t, want, persisted)
}

func TestUpdateSettingsMonochromeRoundTripInBothModes(t *testing.T) {
	h, repo := newStepUpSwitchTestHandler(t, map[string]string{})
	for _, mode := range []string{"light", "dark"} {
		want := service.SiteAppearance{Skin: "monochrome", Mode: mode, AccentColor: "#112233"}
		rec := doUpdateSettings(t, h, map[string]any{"site_appearance": want}, nil)
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		var persisted service.SiteAppearance
		require.NoError(t, json.Unmarshal([]byte(repo.values[service.SettingKeySiteAppearance]), &persisted))
		require.Equal(t, want, persisted)
		var response struct {
			Data struct {
				SiteAppearance service.SiteAppearance `json:"site_appearance"`
			} `json:"data"`
		}
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &response))
		require.Equal(t, want, response.Data.SiteAppearance)
	}
	// Omitting the field keeps the accepted monochrome selection and its stored accent.
	rec := doUpdateSettings(t, h, map[string]any{"site_name": "Rename only"}, nil)
	require.Equal(t, http.StatusOK, rec.Code)
	var persisted service.SiteAppearance
	require.NoError(t, json.Unmarshal([]byte(repo.values[service.SettingKeySiteAppearance]), &persisted))
	require.Equal(t, service.SiteAppearance{Skin: "monochrome", Mode: "dark", AccentColor: "#112233"}, persisted)
	// Returning to a legacy skin is a normal write and keeps the accent for that skin.
	rec = doUpdateSettings(t, h, map[string]any{"site_appearance": service.SiteAppearance{Skin: "original", Mode: "dark", AccentColor: "#112233"}}, nil)
	require.Equal(t, http.StatusOK, rec.Code)
	require.NoError(t, json.Unmarshal([]byte(repo.values[service.SettingKeySiteAppearance]), &persisted))
	require.Equal(t, service.SiteAppearance{Skin: "original", Mode: "dark", AccentColor: "#112233"}, persisted)
}

func TestUpdateSettingsRejectsInvalidAppearanceBeforeWrites(t *testing.T) {
	for _, value := range []any{nil, map[string]any{}, service.SiteAppearance{Skin: "other", Mode: "light", AccentColor: "#ffffff"}, service.SiteAppearance{Skin: "original", Mode: "auto", AccentColor: "#ffffff"}, service.SiteAppearance{Skin: "original", Mode: "dark", AccentColor: "red;display:none"}, service.SiteAppearance{Skin: "monochrome", Mode: "auto", AccentColor: "#ffffff"}, service.SiteAppearance{Skin: "monochrome", Mode: "light", AccentColor: "rgb(0,0,0)"}} {
		h, repo := newStepUpSwitchTestHandler(t, map[string]string{service.SettingKeySiteName: "Keep name"})
		rec := doUpdateSettings(t, h, map[string]any{"site_appearance": value, "site_name": "Invalid write"}, nil)
		require.Equal(t, http.StatusBadRequest, rec.Code)
		require.Equal(t, "Keep name", repo.values[service.SettingKeySiteName])
		require.Empty(t, repo.lastUpdates)
	}
}
