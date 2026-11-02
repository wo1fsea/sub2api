package service

import (
	"fmt"
	"strings"

	factorypkg "github.com/Wei-Shaw/sub2api/internal/pkg/factory"
)

func factoryCredentialBlank(value any) bool {
	if value == nil {
		return true
	}
	text, ok := value.(string)
	return ok && strings.TrimSpace(text) == ""
}

func cloneCredentialMap(source map[string]any) map[string]any {
	out := make(map[string]any, len(source))
	for key, value := range source {
		out[key] = value
	}
	return out
}

func normalizeFactoryCreateCredentials(platform, accountType string, credentials map[string]any) error {
	if platform != PlatformFactory {
		return nil
	}
	if accountType != AccountTypeAPIKey {
		return fmt.Errorf("Factory accounts only support apikey credentials")
	}
	return factorypkg.NormalizeCredentials(credentials, true)
}

func mergeFactoryUpdateCredentials(existing, incoming map[string]any) (map[string]any, error) {
	merged := cloneCredentialMap(existing)
	for key, value := range incoming {
		if key == "api_key" && factoryCredentialBlank(value) {
			continue
		}
		merged[key] = value
	}
	if err := factorypkg.NormalizeCredentials(merged, true); err != nil {
		return nil, err
	}
	return merged, nil
}

func prepareFactoryBulkCredentials(targets []*Account, incoming map[string]any) (map[string]any, error) {
	hasFactory, hasOther := false, false
	for _, target := range targets {
		if target == nil {
			continue
		}
		if target.IsFactory() {
			hasFactory = true
		} else {
			hasOther = true
		}
	}
	if !hasFactory {
		return incoming, nil
	}
	if hasOther {
		for _, key := range []string{"region", "factory_org_id"} {
			if _, ok := incoming[key]; ok {
				return nil, fmt.Errorf("%s supports only Factory targets in a mixed bulk update", key)
			}
		}
	}
	partial := cloneCredentialMap(incoming)
	if value, ok := partial["api_key"]; ok && factoryCredentialBlank(value) {
		delete(partial, "api_key")
	}
	var normalizedPartial map[string]any
	for _, target := range targets {
		if target == nil || !target.IsFactory() {
			continue
		}
		if target.Type != AccountTypeAPIKey {
			return nil, fmt.Errorf("Factory account %d only supports apikey credentials", target.ID)
		}
		effective := cloneCredentialMap(target.Credentials)
		for key, value := range partial {
			effective[key] = value
		}
		if err := factorypkg.NormalizeCredentials(effective, true); err != nil {
			return nil, fmt.Errorf("Factory account %d: %w", target.ID, err)
		}
		if normalizedPartial == nil {
			normalizedPartial = make(map[string]any, len(partial))
			for key := range partial {
				switch key {
				case "factory_org_id":
					if value, ok := effective[key]; ok {
						normalizedPartial[key] = value
					} else {
						normalizedPartial[key] = ""
					}
				case "model_mapping":
					if value, ok := effective[key]; ok {
						normalizedPartial[key] = value
					} else {
						normalizedPartial[key] = map[string]any{}
					}
				default:
					if value, ok := effective[key]; ok {
						normalizedPartial[key] = value
					}
				}
			}
		}
	}
	if normalizedPartial == nil {
		normalizedPartial = make(map[string]any, len(partial))
	}
	return normalizedPartial, nil
}
