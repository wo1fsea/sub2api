package factory

import (
	"fmt"
	"strings"
	"unicode"
)

const (
	credentialKeyAPIKey       = "api_key"
	credentialKeyRegion       = "region"
	credentialKeyOrgID        = "factory_org_id"
	credentialKeyModelMapping = "model_mapping"
	maxAPIKeyLength           = 4096
	maxOrgIDLength            = 256
	maxMappingEntries         = 256
	maxMappingKeyLength       = 256
)

var factoryCredentialKeys = map[string]struct{}{
	credentialKeyAPIKey: {}, credentialKeyRegion: {}, credentialKeyOrgID: {}, credentialKeyModelMapping: {},
}

// Credentials is the validated, normalized Factory API-key credential shape.
type Credentials struct {
	APIKey       string
	Region       string
	OrgID        string
	ModelMapping map[string]string
}

// IsCredentialKey reports whether key belongs to the strict Factory shape.
func IsCredentialKey(key string) bool {
	_, ok := factoryCredentialKeys[key]
	return ok
}

func isControlOrSpace(r rune) bool { return unicode.IsControl(r) || unicode.IsSpace(r) }

func containsControlOrSpace(value string) bool {
	return strings.IndexFunc(value, isControlOrSpace) >= 0
}

func validateAPIKey(value string) (string, error) {
	key := strings.TrimSpace(value)
	if key == "" {
		return "", fmt.Errorf("api_key is required")
	}
	if len(key) > maxAPIKeyLength {
		return "", fmt.Errorf("api_key is too long")
	}
	if containsControlOrSpace(key) {
		return "", fmt.Errorf("api_key must not contain whitespace or control characters")
	}
	if !strings.HasPrefix(key, "fk-") || len(key) <= len("fk-") {
		return "", fmt.Errorf("api_key must be a Factory fk- key")
	}
	const keySuffix = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-"
	for _, r := range strings.TrimPrefix(key, "fk-") {
		if !strings.ContainsRune(keySuffix, r) {
			return "", fmt.Errorf("api_key contains unsupported characters")
		}
	}
	return key, nil
}

func normalizeRegion(raw any) (string, error) {
	if raw == nil {
		return RegionUS, nil
	}
	value, ok := raw.(string)
	if !ok {
		return "", fmt.Errorf("region must be us or eu")
	}
	value = strings.ToLower(strings.TrimSpace(value))
	if value == "" {
		return RegionUS, nil
	}
	if value != RegionUS && value != RegionEU {
		return "", fmt.Errorf("region must be us or eu")
	}
	return value, nil
}

func normalizeOrgID(raw any) (string, error) {
	if raw == nil {
		return "", nil
	}
	value, ok := raw.(string)
	if !ok {
		return "", fmt.Errorf("factory_org_id must be a string")
	}
	value = strings.TrimSpace(value)
	if value == "" {
		return "", nil
	}
	if len(value) > maxOrgIDLength {
		return "", fmt.Errorf("factory_org_id is too long")
	}
	if containsControlOrSpace(value) {
		return "", fmt.Errorf("factory_org_id must not contain whitespace or control characters")
	}
	for _, r := range value {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '_' || r == '-' {
			continue
		}
		return "", fmt.Errorf("factory_org_id contains unsupported characters")
	}
	return value, nil
}

func normalizeModelMapping(raw any) (map[string]string, error) {
	if raw == nil {
		return nil, nil
	}
	var entries map[string]any
	switch value := raw.(type) {
	case map[string]any:
		entries = value
	case map[string]string:
		entries = make(map[string]any, len(value))
		for key, target := range value {
			entries[key] = target
		}
	default:
		return nil, fmt.Errorf("model_mapping must be an object of public model to native model")
	}
	if len(entries) > maxMappingEntries {
		return nil, fmt.Errorf("model_mapping supports at most %d entries", maxMappingEntries)
	}
	out := make(map[string]string, len(entries))
	seen := make(map[string]struct{}, len(entries))
	for key, rawTarget := range entries {
		public := strings.TrimSpace(key)
		if public == "" || len(public) > maxMappingKeyLength || containsControlOrSpace(public) {
			return nil, fmt.Errorf("model_mapping has an invalid request model")
		}
		if _, duplicate := seen[public]; duplicate {
			return nil, fmt.Errorf("model_mapping contains duplicate normalized request models")
		}
		seen[public] = struct{}{}
		target, ok := rawTarget.(string)
		if !ok {
			return nil, fmt.Errorf("model_mapping targets must be strings")
		}
		native, ok := NativeModelID(target)
		if !ok {
			return nil, fmt.Errorf("model_mapping target is not a supported Factory model")
		}
		out[public] = native
	}
	if len(out) == 0 {
		return nil, nil
	}
	return out, nil
}

// NormalizeCredentials validates and mutates a strict Factory credential map.
// requireAPIKey=false is used by callers that have already merged an omitted or
// blank edit with the existing key; a remaining empty key is still rejected.
func NormalizeCredentials(credentials map[string]any, requireAPIKey bool) error {
	if credentials == nil {
		if requireAPIKey {
			return fmt.Errorf("api_key is required")
		}
		return nil
	}
	for key := range credentials {
		if !IsCredentialKey(key) {
			return fmt.Errorf("unsupported Factory credential key")
		}
	}
	rawKey, hasKey := credentials[credentialKeyAPIKey]
	if hasKey && rawKey != nil {
		value, ok := rawKey.(string)
		if !ok {
			return fmt.Errorf("api_key must be a string")
		}
		key, err := validateAPIKey(value)
		if err != nil {
			return err
		}
		credentials[credentialKeyAPIKey] = key
	} else if requireAPIKey {
		return fmt.Errorf("api_key is required")
	} else {
		delete(credentials, credentialKeyAPIKey)
	}
	region, err := normalizeRegion(credentials[credentialKeyRegion])
	if err != nil {
		return err
	}
	credentials[credentialKeyRegion] = region
	orgID, err := normalizeOrgID(credentials[credentialKeyOrgID])
	if err != nil {
		return err
	}
	if orgID == "" {
		delete(credentials, credentialKeyOrgID)
	} else {
		credentials[credentialKeyOrgID] = orgID
	}
	mapping, err := normalizeModelMapping(credentials[credentialKeyModelMapping])
	if err != nil {
		return err
	}
	if mapping == nil {
		delete(credentials, credentialKeyModelMapping)
	} else {
		normalized := make(map[string]any, len(mapping))
		for key, value := range mapping {
			normalized[key] = value
		}
		credentials[credentialKeyModelMapping] = normalized
	}
	return nil
}

// ParseCredentials validates without mutating the source map.
func ParseCredentials(credentials map[string]any, requireAPIKey bool) (Credentials, error) {
	clone := make(map[string]any, len(credentials))
	for key, value := range credentials {
		clone[key] = value
	}
	if err := NormalizeCredentials(clone, requireAPIKey); err != nil {
		return Credentials{}, err
	}
	result := Credentials{Region: RegionUS}
	if key, ok := clone[credentialKeyAPIKey].(string); ok {
		result.APIKey = key
	}
	if region, ok := clone[credentialKeyRegion].(string); ok {
		result.Region = region
	}
	if orgID, ok := clone[credentialKeyOrgID].(string); ok {
		result.OrgID = orgID
	}
	if mapping, ok := clone[credentialKeyModelMapping].(map[string]any); ok {
		result.ModelMapping = make(map[string]string, len(mapping))
		for key, value := range mapping {
			if target, ok := value.(string); ok {
				result.ModelMapping[key] = target
			}
		}
	}
	return result, nil
}
