package factory

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

// PrepareInferenceBody validates the registry model and protocol, rejects
// unsupported Fast intent, rewrites the model to its exact native id, and adds
// only the minimal idempotent Droid preamble. Other caller content is kept.
func PrepareInferenceBody(protocol Protocol, body []byte) ([]byte, Model, error) {
	var payload map[string]any
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	if err := decoder.Decode(&payload); err != nil || payload == nil {
		return nil, Model{}, fmt.Errorf("invalid Factory request body")
	}
	rawModel, ok := payload["model"].(string)
	if !ok || strings.TrimSpace(rawModel) == "" {
		return nil, Model{}, fmt.Errorf("factory model is required")
	}
	if IsFastOrGeminiID(rawModel) {
		return nil, Model{}, fmt.Errorf("factory Fast Mode and Gemini models are not supported")
	}
	model, ok := ResolveModel(rawModel)
	if !ok {
		return nil, Model{}, fmt.Errorf("unsupported Factory model")
	}
	if model.Protocol != protocol {
		return nil, Model{}, fmt.Errorf("factory model is not valid for this protocol")
	}
	if hasFastIntent(protocol, payload) {
		return nil, Model{}, fmt.Errorf("factory Fast Mode is not supported")
	}
	payload["model"] = model.ID
	switch protocol {
	case ProtocolResponses:
		if err := openResponsesInstructions(payload); err != nil {
			return nil, Model{}, err
		}
	case ProtocolChatCompletions:
		if err := openChatMessages(payload); err != nil {
			return nil, Model{}, err
		}
	case ProtocolAnthropic:
		if err := openAnthropicSystem(payload); err != nil {
			return nil, Model{}, err
		}
	default:
		return nil, Model{}, fmt.Errorf("unsupported Factory protocol")
	}
	prepared, err := json.Marshal(payload)
	if err != nil {
		return nil, Model{}, fmt.Errorf("encode Factory request body")
	}
	return prepared, model, nil
}

func hasFastIntent(protocol Protocol, payload map[string]any) bool {
	if protocol == ProtocolAnthropic {
		if speed, _ := payload["speed"].(string); strings.EqualFold(strings.TrimSpace(speed), "fast") {
			return true
		}
	}
	if protocol == ProtocolResponses {
		if tier, _ := payload["service_tier"].(string); strings.EqualFold(strings.TrimSpace(tier), "priority") {
			return true
		}
	}
	return false
}

func startsWithDroidLine(text string) bool { return strings.HasPrefix(text, DroidLine) }

func openResponsesInstructions(payload map[string]any) error {
	raw, exists := payload["instructions"]
	if !exists || raw == nil {
		payload["instructions"] = DroidLine
		return nil
	}
	text, ok := raw.(string)
	if !ok {
		return fmt.Errorf("factory Responses instructions must be a string")
	}
	if startsWithDroidLine(text) {
		return nil
	}
	if strings.TrimSpace(text) == "" {
		payload["instructions"] = DroidLine
	} else {
		payload["instructions"] = DroidLine + "\n" + text
	}
	return nil
}

func openChatMessages(payload map[string]any) error {
	raw, exists := payload["messages"]
	if !exists || raw == nil {
		payload["messages"] = []any{map[string]any{"role": "system", "content": DroidLine}}
		return nil
	}
	messages, ok := raw.([]any)
	if !ok {
		return fmt.Errorf("factory chat messages must be an array")
	}
	if len(messages) == 0 {
		payload["messages"] = []any{map[string]any{"role": "system", "content": DroidLine}}
		return nil
	}
	first, _ := messages[0].(map[string]any)
	if first == nil || first["role"] != "system" {
		payload["messages"] = append([]any{map[string]any{"role": "system", "content": DroidLine}}, messages...)
		return nil
	}
	return prefixSystemContent(first)
}

func openAnthropicSystem(payload map[string]any) error {
	raw, exists := payload["system"]
	if !exists || raw == nil {
		payload["system"] = DroidLine
		return nil
	}
	if text, ok := raw.(string); ok {
		if startsWithDroidLine(text) {
			return nil
		}
		if strings.TrimSpace(text) == "" {
			payload["system"] = DroidLine
		} else {
			payload["system"] = DroidLine + "\n" + text
		}
		return nil
	}
	blocks, ok := raw.([]any)
	if !ok {
		return fmt.Errorf("factory Anthropic system must be a string or content blocks")
	}
	container := map[string]any{"content": blocks}
	if err := prefixSystemContent(container); err != nil {
		return err
	}
	payload["system"] = container["content"]
	return nil
}

func prefixSystemContent(message map[string]any) error {
	raw, exists := message["content"]
	if !exists || raw == nil {
		message["content"] = DroidLine
		return nil
	}
	if text, ok := raw.(string); ok {
		if startsWithDroidLine(text) {
			return nil
		}
		if strings.TrimSpace(text) == "" {
			message["content"] = DroidLine
		} else {
			message["content"] = DroidLine + "\n" + text
		}
		return nil
	}
	blocks, ok := raw.([]any)
	if !ok {
		return fmt.Errorf("factory system content must be a string or content blocks")
	}
	if len(blocks) > 0 {
		if first, ok := blocks[0].(map[string]any); ok {
			if text, ok := first["text"].(string); ok && startsWithDroidLine(text) {
				return nil
			}
		}
	}
	message["content"] = append([]any{map[string]any{"type": "text", "text": DroidLine}}, blocks...)
	return nil
}

// ApplyRequestPolicy must run after every generic header override. It replaces
// the destination with the fixed regional endpoint, removes credential-bearing
// and Droid-owned headers in every casing, and installs the observed contract.
func ApplyRequestPolicy(req *http.Request, credentials Credentials, model Model, protocol Protocol) error {
	if req == nil {
		return fmt.Errorf("factory request is nil")
	}
	if model.Protocol != protocol {
		return fmt.Errorf("factory model protocol mismatch")
	}
	endpoint, ok := EndpointURL(credentials.Region, protocol)
	if !ok {
		return fmt.Errorf("unsupported Factory region")
	}
	parsed, err := url.Parse(endpoint)
	if err != nil {
		return fmt.Errorf("invalid Factory endpoint")
	}
	for key, values := range req.Header {
		if !strings.EqualFold(key, "anthropic-beta") {
			continue
		}
		for _, value := range values {
			if strings.Contains(strings.ToLower(value), "fast-mode") {
				return fmt.Errorf("factory Fast Mode is not supported")
			}
		}
	}
	req.Method = http.MethodPost
	req.URL = parsed
	req.Host = ""
	req.RequestURI = ""
	for _, name := range []string{"authorization", "x-api-key", "x-goog-api-key", "cookie", "host", "content-length", "x-factory-client", "x-client-version", "user-agent", "x-factory-org-id", "x-api-provider", "x-provider-routing-source", "x-session-id", "x-assistant-message-id", "openai-platform"} {
		deleteHeaderAll(req.Header, name)
	}
	req.Header.Set("Authorization", "Bearer "+credentials.APIKey)
	req.Header.Set("X-Factory-Client", "cli")
	req.Header.Set("X-Client-Version", ClientVersion)
	req.Header.Set("User-Agent", UserAgent)
	req.Header.Set("x-api-provider", model.Provider)
	req.Header.Set("x-provider-routing-source", "registry_default")
	req.Header.Set("x-session-id", randomUUID())
	req.Header.Set("x-assistant-message-id", randomUUID())
	if credentials.OrgID != "" {
		req.Header.Set("X-Factory-Org-Id", credentials.OrgID)
	}
	if protocol == ProtocolAnthropic {
		req.Header.Set("X-Api-Key", "placeholder")
	}
	if model.Provider == providerOpenAI {
		req.Header.Set("OpenAI-Platform", OpenAIProjectHeader)
	}
	if req.Header.Get("Content-Type") == "" {
		req.Header.Set("Content-Type", "application/json")
	}
	return nil
}

func deleteHeaderAll(header http.Header, lowerName string) {
	for key := range header {
		if strings.EqualFold(key, lowerName) {
			delete(header, key)
		}
	}
}

func randomUUID() string {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "00000000-0000-4000-8000-000000000000"
	}
	raw[6] = (raw[6] & 0x0f) | 0x40
	raw[8] = (raw[8] & 0x3f) | 0x80
	buf := make([]byte, 36)
	hex.Encode(buf[0:8], raw[0:4])
	buf[8] = '-'
	hex.Encode(buf[9:13], raw[4:6])
	buf[13] = '-'
	hex.Encode(buf[14:18], raw[6:8])
	buf[18] = '-'
	hex.Encode(buf[19:23], raw[8:10])
	buf[23] = '-'
	hex.Encode(buf[24:36], raw[10:16])
	return string(buf)
}
