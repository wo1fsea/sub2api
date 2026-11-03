// Package factory implements the Droid API contract used by sub2api: the
// finite model registry, fixed regional endpoints, credential validation,
// request opening, required headers, and whoami decoding.
//
// This is community protocol evidence, not a stable public Factory API.
// Unknown models, regions, endpoints, and credential shapes fail closed
// locally instead of reaching a generic vendor URL or protocol guess.
package factory

import "strings"

const (
	// Platform is the concrete sub2api platform id for Factory accounts.
	Platform = "factory"

	// PublicModelPrefix namespaces Factory models so composite groups cannot
	// confuse them with same-named models from other providers.
	PublicModelPrefix = "factory/"

	// RegistryVersion identifies this bounded model table. Entitlement still
	// depends on the account and Factory-side model policy.
	RegistryVersion = "factory-droid-0.242.0-claude-only"

	RegionUS = "us"
	RegionEU = "eu"

	HostUS = "https://api.factory.ai"
	HostEU = "https://api.eu.factory.ai"

	ClientVersion = "0.242.0"
	UserAgent     = "factory-cli/" + ClientVersion

	// DroidLine is the minimal fixed opening Factory expects. The adapter
	// only prefixes it and never rewrites caller content.
	DroidLine = "You are Droid, an AI software engineering agent built by Factory."

	// OpenAIProjectHeader is the observed provider marker Droid sends for
	// models served by Factory's OpenAI provider.
	OpenAIProjectHeader = "org-bHuLtG1fGmYk5YaOihAAXFBw"
)

// Protocol is the native Factory wire protocol for a model.
type Protocol string

const (
	ProtocolAnthropic       Protocol = "anthropic"
	ProtocolResponses       Protocol = "responses"
	ProtocolChatCompletions Protocol = "chat_completions"
)

// Model is one recognized Claude model offered through Factory.
type Model struct {
	ID               string   `json:"id"`
	DisplayName      string   `json:"display_name"`
	Protocol         Protocol `json:"protocol"`
	Provider         string   `json:"provider"`
	ContextWindow    int      `json:"context_window,omitempty"`
	MaxOutputTokens  int      `json:"max_output_tokens,omitempty"`
	ReasoningEfforts []string `json:"reasoning_efforts,omitempty"`
	Images           bool     `json:"images"`
}

const (
	providerAnthropic = "anthropic"
	providerOpenAI    = "openai"
)

var (
	e5 = []string{"low", "medium", "high", "xhigh", "max"}
)

// recognizedModels is the Claude-only Factory allowlist, including Fable.
// Non-Anthropic models, Fast Mode variants and auto fail closed locally.
var recognizedModels = []Model{
	{ID: "claude-fable-5.1", DisplayName: "Fable 5.1", Protocol: ProtocolAnthropic, Provider: providerAnthropic, ContextWindow: 867000, MaxOutputTokens: 128000, ReasoningEfforts: e5, Images: true},
	{ID: "claude-fable-5", DisplayName: "Fable 5", Protocol: ProtocolAnthropic, Provider: providerAnthropic, ContextWindow: 867000, MaxOutputTokens: 128000, ReasoningEfforts: e5, Images: true},
	{ID: "claude-opus-5-5", DisplayName: "Opus 5.5", Protocol: ProtocolAnthropic, Provider: providerAnthropic, ContextWindow: 872000, MaxOutputTokens: 128000, ReasoningEfforts: e5, Images: true},
	{ID: "claude-opus-5", DisplayName: "Opus 5", Protocol: ProtocolAnthropic, Provider: providerAnthropic, ContextWindow: 867000, MaxOutputTokens: 128000, ReasoningEfforts: e5, Images: true},
	{ID: "claude-opus-4-8", DisplayName: "Opus 4.8", Protocol: ProtocolAnthropic, Provider: providerAnthropic, ContextWindow: 867000, MaxOutputTokens: 128000, ReasoningEfforts: e5, Images: true},
	{ID: "claude-sonnet-5-5", DisplayName: "Sonnet 5.5", Protocol: ProtocolAnthropic, Provider: providerAnthropic, ContextWindow: 872000, MaxOutputTokens: 128000, ReasoningEfforts: e5, Images: true},
	{ID: "claude-sonnet-5", DisplayName: "Sonnet 5", Protocol: ProtocolAnthropic, Provider: providerAnthropic, ContextWindow: 872000, MaxOutputTokens: 128000, ReasoningEfforts: e5, Images: true},
	{ID: "claude-sonnet-4-6", DisplayName: "Sonnet 4.6", Protocol: ProtocolAnthropic, Provider: providerAnthropic, ContextWindow: 931000, MaxOutputTokens: 64000, ReasoningEfforts: []string{"low", "medium", "high", "max"}, Images: true},
	{ID: "claude-haiku-5-5", DisplayName: "Haiku 5.5", Protocol: ProtocolAnthropic, Provider: providerAnthropic, ContextWindow: 872000, MaxOutputTokens: 128000, ReasoningEfforts: e5, Images: true},
	{ID: "claude-haiku-4-5-20251001", DisplayName: "Haiku 4.5", Protocol: ProtocolAnthropic, Provider: providerAnthropic, ReasoningEfforts: []string{"low", "medium", "high"}, Images: true},
}

var modelsByID = func() map[string]Model {
	out := make(map[string]Model, len(recognizedModels))
	for _, model := range recognizedModels {
		out[model.ID] = cloneModel(model)
	}
	return out
}()

func cloneModel(model Model) Model {
	model.ReasoningEfforts = append([]string(nil), model.ReasoningEfforts...)
	return model
}

// Models returns a copy of the finite registry in stable catalog order.
func Models() []Model {
	out := make([]Model, 0, len(recognizedModels))
	for _, model := range recognizedModels {
		out = append(out, cloneModel(model))
	}
	return out
}

// ModelIDs returns native registry ids in catalog order.
func ModelIDs() []string {
	out := make([]string, 0, len(recognizedModels))
	for _, model := range recognizedModels {
		out = append(out, model.ID)
	}
	return out
}

// PublicModelIDs returns factory/<native-id> names in catalog order.
func PublicModelIDs() []string {
	out := make([]string, 0, len(recognizedModels))
	for _, model := range recognizedModels {
		out = append(out, PublicModelPrefix+model.ID)
	}
	return out
}

// DefaultModelMapping maps public names to exact native ids for an unmapped
// Factory account.
func DefaultModelMapping() map[string]string {
	out := make(map[string]string, len(recognizedModels))
	for _, model := range recognizedModels {
		out[PublicModelPrefix+model.ID] = model.ID
	}
	return out
}

func ResolveModel(raw string) (Model, bool) {
	name := strings.TrimSpace(raw)
	if name == "" {
		return Model{}, false
	}
	name = strings.TrimPrefix(name, PublicModelPrefix)
	model, ok := modelsByID[name]
	if !ok {
		return Model{}, false
	}
	return cloneModel(model), true
}

// IsExcludedModelName prevents account aliases and wildcards from reviving
// removed provider model names. Ordinary team aliases remain supported.
func IsExcludedModelName(raw string) bool {
	name := strings.ToLower(strings.TrimSpace(raw))
	// Factory exposes a finite catalog plus exact team aliases. A wildcard is
	// neither a public model nor an exact alias and must not be advertised.
	if strings.Contains(name, "*") {
		return true
	}
	if strings.HasPrefix(name, PublicModelPrefix) {
		_, supported := ResolveModel(raw)
		return !supported
	}
	for _, prefix := range []string{"gpt-", "grok-", "glm-", "minimax-", "deepseek-", "kimi-", "mistral-", "qwen", "nemotron-", "gemini-"} {
		if strings.HasPrefix(name, prefix) {
			return true
		}
	}
	return IsFastOrGeminiID(name)
}

func NativeModelID(raw string) (string, bool) {
	model, ok := ResolveModel(raw)
	if !ok {
		return "", false
	}
	return model.ID, true
}

func ProtocolForModel(raw string) (Protocol, bool) {
	model, ok := ResolveModel(raw)
	if !ok {
		return "", false
	}
	return model.Protocol, true
}

func CanonicalPublicID(raw string) (string, bool) {
	native, ok := NativeModelID(raw)
	if !ok {
		return "", false
	}
	return PublicModelPrefix + native, true
}

func IsFastOrGeminiID(raw string) bool {
	id := strings.ToLower(strings.TrimSpace(raw))
	id = strings.TrimPrefix(id, PublicModelPrefix)
	return strings.HasPrefix(id, "gemini-") || strings.HasSuffix(id, "-fast") || id == "auto" || id == "auto-fast"
}

func RegionHost(region string) (string, bool) {
	switch strings.ToLower(strings.TrimSpace(region)) {
	case "", RegionUS:
		return HostUS, true
	case RegionEU:
		return HostEU, true
	default:
		return "", false
	}
}

func BaseURL(region string, protocol Protocol) (string, bool) {
	host, ok := RegionHost(region)
	if !ok {
		return "", false
	}
	switch protocol {
	case ProtocolAnthropic:
		return host + "/api/llm/a", true
	case ProtocolResponses, ProtocolChatCompletions:
		return host + "/api/llm/o", true
	default:
		return "", false
	}
}

func EndpointURL(region string, protocol Protocol) (string, bool) {
	base, ok := BaseURL(region, protocol)
	if !ok {
		return "", false
	}
	switch protocol {
	case ProtocolAnthropic:
		return base + "/v1/messages", true
	case ProtocolResponses:
		return base + "/v1/responses", true
	case ProtocolChatCompletions:
		return base + "/v1/chat/completions", true
	default:
		return "", false
	}
}

func WhoamiURL(region string) (string, bool) {
	host, ok := RegionHost(region)
	if !ok {
		return "", false
	}
	return host + "/api/cli/whoami", true
}
