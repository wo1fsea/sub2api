package service

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strings"

	"regexp"
)

var factoryAPIKeyRegex = regexp.MustCompile(`fk-[A-Za-z0-9_-]+`)

func sanitizeFactorySecrets(message string) string {
	if message == "" {
		return message
	}
	return factoryAPIKeyRegex.ReplaceAllString(message, "fk-***")
}

func maskFactoryCredential(account *Account, message string) string {
	if account != nil && account.IsFactory() {
		if key := strings.TrimSpace(account.GetCredential("api_key")); key != "" {
			message = strings.ReplaceAll(message, key, "fk-***")
		}
	}
	return sanitizeFactorySecrets(message)
}

func sanitizeAPIKeyShapedJSONErrors(body []byte) []byte {
	if len(body) == 0 || !json.Valid(body) {
		return []byte(sanitizeFactorySecrets(string(body)))
	}
	var value any
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	if err := decoder.Decode(&value); err != nil {
		return []byte(sanitizeFactorySecrets(string(body)))
	}
	value = sanitizeFactoryJSONValue(nil, value)
	encoded, err := json.Marshal(value)
	if err != nil {
		return []byte(sanitizeFactorySecrets(string(body)))
	}
	return encoded
}

func sanitizeFactoryDiagnosticBody(account *Account, body []byte) []byte {
	if account == nil || !account.IsFactory() || len(body) == 0 {
		return body
	}
	if !json.Valid(body) {
		return []byte(maskFactoryCredential(account, string(body)))
	}
	var value any
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	if err := decoder.Decode(&value); err != nil {
		return []byte(maskFactoryCredential(account, string(body)))
	}
	value = sanitizeFactoryJSONValue(account, value)
	encoded, err := json.Marshal(value)
	if err != nil {
		return []byte(maskFactoryCredential(account, string(body)))
	}
	return encoded
}

func sanitizeFactoryJSONValue(account *Account, value any) any {
	switch typed := value.(type) {
	case string:
		return maskFactoryCredential(account, typed)
	case []any:
		for i := range typed {
			typed[i] = sanitizeFactoryJSONValue(account, typed[i])
		}
	case map[string]any:
		for key, item := range typed {
			typed[key] = sanitizeFactoryJSONValue(account, item)
		}
	}
	return value
}

func sanitizeFactoryDiagnosticHeader(account *Account, value string) string {
	return maskFactoryCredential(account, value)
}

func sanitizeFactoryResponseHeaders(account *Account, headers http.Header) http.Header {
	if account == nil || !account.IsFactory() || headers == nil {
		return headers
	}
	clone := headers.Clone()
	for key, values := range clone {
		for i := range values {
			values[i] = sanitizeFactoryDiagnosticHeader(account, values[i])
		}
		clone[key] = values
	}
	return clone
}

func sanitizeFactoryErrorEventData(account *Account, payload []byte) []byte {
	if account == nil || !account.IsFactory() || len(payload) == 0 {
		return payload
	}
	return sanitizeFactoryDiagnosticBody(account, payload)
}

func sanitizeFactoryAnthropicSSELine(account *Account, line string) string {
	if account == nil || !account.IsFactory() {
		return line
	}
	trimmed := strings.TrimSpace(line)
	if !strings.HasPrefix(trimmed, "data:") {
		return line
	}
	payload := strings.TrimSpace(strings.TrimPrefix(trimmed, "data:"))
	if payload == "" || payload == "[DONE]" || !json.Valid([]byte(payload)) {
		return line
	}
	var object map[string]any
	if err := json.Unmarshal([]byte(payload), &object); err != nil {
		return line
	}
	if eventType, _ := object["type"].(string); eventType != "error" {
		return line
	}
	sanitized := sanitizeFactoryDiagnosticBody(account, []byte(payload))
	return "data: " + string(sanitized)
}

func sanitizeFactoryChatSSELine(account *Account, line string) string {
	if account == nil || !account.IsFactory() {
		return line
	}
	trimmed := strings.TrimSpace(line)
	if !strings.HasPrefix(trimmed, "data:") {
		return line
	}
	payload := strings.TrimSpace(strings.TrimPrefix(trimmed, "data:"))
	if payload == "" || payload == "[DONE]" || !json.Valid([]byte(payload)) {
		return line
	}
	var object map[string]any
	if err := json.Unmarshal([]byte(payload), &object); err != nil {
		return line
	}
	_, hasError := object["error"]
	eventType, _ := object["type"].(string)
	if !hasError && eventType != "error" {
		return line
	}
	sanitized := sanitizeFactoryDiagnosticBody(account, []byte(payload))
	return "data: " + string(sanitized)
}
