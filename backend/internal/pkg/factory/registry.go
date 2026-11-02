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
	RegistryVersion = "factory-droid-0.242.0-recognized-no-fast-no-gemini"

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

// Model is one recognized non-Fast, non-Gemini Factory model.
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
	providerXAI       = "xai"
	providerFireworks = "fireworks"
	providerBaseten   = "baseten"
	providerMistral   = "mistral"
)

var (
	e5 = []string{"low", "medium", "high", "xhigh", "max"}
	e6 = []string{"none", "low", "medium", "high", "xhigh", "max"}
	e4 = []string{"low", "medium", "high", "xhigh"}
)

// recognizedModels deliberately excludes Gemini, Fast Mode variants, auto,
// and explicit high-cost opt-in models. Provider is carried explicitly because
// it cannot be derived from the protocol or a vendor-looking model prefix.
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
	{ID: "minimax-m2.7", DisplayName: "MiniMax M2.7", Protocol: ProtocolAnthropic, Provider: providerFireworks, ContextWindow: 196600, MaxOutputTokens: 64000, ReasoningEfforts: []string{"high"}, Images: false},
	{ID: "gpt-6.1-sol", DisplayName: "GPT-6.1 Sol", Protocol: ProtocolResponses, Provider: providerOpenAI, ContextWindow: 1050000, MaxOutputTokens: 128000, ReasoningEfforts: e5, Images: true},
	{ID: "gpt-6-sol", DisplayName: "GPT-6 Sol", Protocol: ProtocolResponses, Provider: providerOpenAI, ContextWindow: 1050000, MaxOutputTokens: 128000, ReasoningEfforts: e6, Images: true},
	{ID: "gpt-6-astra", DisplayName: "GPT-6 Astra", Protocol: ProtocolResponses, Provider: providerOpenAI, ContextWindow: 1050000, MaxOutputTokens: 128000, ReasoningEfforts: e5, Images: true},
	{ID: "gpt-6-luna", DisplayName: "GPT-6 Luna", Protocol: ProtocolResponses, Provider: providerOpenAI, ContextWindow: 1050000, MaxOutputTokens: 128000, ReasoningEfforts: e6, Images: true},
	{ID: "gpt-5.6-sol", DisplayName: "GPT-5.6 Sol", Protocol: ProtocolResponses, Provider: providerOpenAI, ContextWindow: 1050000, MaxOutputTokens: 128000, ReasoningEfforts: e6, Images: true},
	{ID: "gpt-5.6-terra", DisplayName: "GPT-5.6 Terra", Protocol: ProtocolResponses, Provider: providerOpenAI, ContextWindow: 1050000, MaxOutputTokens: 128000, ReasoningEfforts: e6, Images: true},
	{ID: "gpt-5.6-luna", DisplayName: "GPT-5.6 Luna", Protocol: ProtocolResponses, Provider: providerOpenAI, ContextWindow: 1050000, MaxOutputTokens: 128000, ReasoningEfforts: e6, Images: true},
	{ID: "gpt-5.5", DisplayName: "GPT-5.5", Protocol: ProtocolResponses, Provider: providerOpenAI, ContextWindow: 1050000, MaxOutputTokens: 128000, ReasoningEfforts: e4, Images: true},
	{ID: "gpt-5.4", DisplayName: "GPT-5.4", Protocol: ProtocolResponses, Provider: providerOpenAI, ContextWindow: 1050000, MaxOutputTokens: 128000, ReasoningEfforts: e4, Images: true},
	{ID: "gpt-5.3-codex", DisplayName: "GPT-5.3-Codex", Protocol: ProtocolResponses, Provider: providerOpenAI, ContextWindow: 400000, MaxOutputTokens: 128000, ReasoningEfforts: e4, Images: true},
	{ID: "grok-4.7", DisplayName: "Grok 4.7", Protocol: ProtocolResponses, Provider: providerXAI, ContextWindow: 500000, MaxOutputTokens: 63356, ReasoningEfforts: e4, Images: true},
	{ID: "grok-4.6", DisplayName: "Grok 4.6", Protocol: ProtocolResponses, Provider: providerXAI, ContextWindow: 200000, MaxOutputTokens: 63356, ReasoningEfforts: e4, Images: true},
	{ID: "glm-5.3", DisplayName: "GLM-5.3", Protocol: ProtocolChatCompletions, Provider: providerFireworks, ContextWindow: 1040000, MaxOutputTokens: 131072, ReasoningEfforts: []string{"low", "high", "max"}, Images: false},
	{ID: "glm-5.3-flash", DisplayName: "GLM-5.3-Flash", Protocol: ProtocolChatCompletions, Provider: providerFireworks, ContextWindow: 1048576, MaxOutputTokens: 131072, ReasoningEfforts: []string{"low", "high", "max"}, Images: true},
	{ID: "glm-5.2", DisplayName: "GLM-5.2", Protocol: ProtocolChatCompletions, Provider: providerBaseten, ContextWindow: 1040000, MaxOutputTokens: 131072, ReasoningEfforts: []string{"none", "high", "max"}, Images: false},
	{ID: "kimi-k3", DisplayName: "Kimi K3", Protocol: ProtocolChatCompletions, Provider: providerFireworks, ContextWindow: 262144, MaxOutputTokens: 65536, ReasoningEfforts: []string{"none", "low", "high", "max"}, Images: true},
	{ID: "deepseek-v4.1-flash", DisplayName: "DeepSeek V4.1 Flash", Protocol: ProtocolChatCompletions, Provider: providerFireworks, ContextWindow: 1040000, MaxOutputTokens: 131072, ReasoningEfforts: []string{"none", "low", "high", "max"}, Images: true},
	{ID: "deepseek-v4.1-flash-1017", DisplayName: "DeepSeek V4.1 Flash 1017", Protocol: ProtocolChatCompletions, Provider: providerFireworks, ContextWindow: 1040000, MaxOutputTokens: 131072, ReasoningEfforts: []string{"none", "low", "high", "max"}, Images: true},
	{ID: "qwen3.8-max", DisplayName: "Qwen3.8 Max", Protocol: ProtocolChatCompletions, Provider: providerFireworks, ContextWindow: 262144, MaxOutputTokens: 131072, ReasoningEfforts: []string{"low", "medium", "xhigh"}, Images: false},
	{ID: "minimax-m3", DisplayName: "MiniMax M3", Protocol: ProtocolChatCompletions, Provider: providerFireworks, ContextWindow: 512000, MaxOutputTokens: 64000, ReasoningEfforts: []string{"high"}, Images: true},
	{ID: "mistral-large-4", DisplayName: "Mistral Large 4", Protocol: ProtocolChatCompletions, Provider: providerMistral, ContextWindow: 524288, MaxOutputTokens: 64000, ReasoningEfforts: []string{"high"}, Images: true},
	{ID: "mistral-medium-3.5", DisplayName: "Mistral Medium 3.5", Protocol: ProtocolChatCompletions, Provider: providerMistral, ContextWindow: 256000, MaxOutputTokens: 64000, ReasoningEfforts: []string{"high"}, Images: true},
	{ID: "nemotron-3-ultra", DisplayName: "Nemotron 3 Ultra", Protocol: ProtocolChatCompletions, Provider: providerBaseten, ContextWindow: 202000, MaxOutputTokens: 65536, ReasoningEfforts: []string{"high"}, Images: false},
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
