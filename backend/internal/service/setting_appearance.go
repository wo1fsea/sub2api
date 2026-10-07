package service

import (
	"encoding/json"
	"fmt"
	"regexp"
)

const SettingKeySiteAppearance = "site_appearance"

// SiteAppearance is shared by every visitor. Only the admin settings API writes it.
type SiteAppearance struct {
	Skin        string `json:"skin"`
	Mode        string `json:"mode"`
	AccentColor string `json:"accent_color"`
}

func DefaultSiteAppearance() SiteAppearance {
	return SiteAppearance{Skin: "neubrutalism", Mode: "light", AccentColor: "#d4ff3f"}
}

var appearanceHexColor = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

func (a SiteAppearance) Validate() error {
	if a.Skin != "neubrutalism" && a.Skin != "original" {
		return fmt.Errorf("site appearance skin must be neubrutalism or original")
	}
	if a.Mode != "light" && a.Mode != "dark" {
		return fmt.Errorf("site appearance mode must be light or dark")
	}
	if !appearanceHexColor.MatchString(a.AccentColor) {
		return fmt.Errorf("site appearance accent_color must be a six-digit hex color")
	}
	return nil
}

func parseSiteAppearance(value string) SiteAppearance {
	var appearance SiteAppearance
	if json.Unmarshal([]byte(value), &appearance) != nil || appearance.Validate() != nil {
		return DefaultSiteAppearance()
	}
	return appearance
}
