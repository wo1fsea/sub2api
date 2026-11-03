//go:build unit

package service

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/config"
	"github.com/Wei-Shaw/sub2api/internal/pkg/tlsfingerprint"
	"github.com/gin-gonic/gin"
	gocache "github.com/patrickmn/go-cache"
	"github.com/stretchr/testify/require"
	"github.com/tidwall/gjson"
)

type factoryAcceptanceTransport struct {
	requests  []*http.Request
	bodies    [][]byte
	responses []*http.Response
}

type factoryLiveHTTPUpstream struct {
	client *http.Client
	mu     sync.Mutex
	whoami int
	infer  int
}

type factoryAcceptanceCompositeRouteRepo struct {
	routes []CompositeModelRoute
}

func (r *factoryAcceptanceCompositeRouteRepo) ListByGroup(context.Context, int64, bool) ([]CompositeModelRoute, error) {
	return r.routes, nil
}

func (r *factoryAcceptanceCompositeRouteRepo) Create(context.Context, *CompositeModelRoute) error {
	return nil
}

func (r *factoryAcceptanceCompositeRouteRepo) Update(context.Context, *CompositeModelRoute) error {
	return nil
}

func (r *factoryAcceptanceCompositeRouteRepo) Delete(context.Context, int64) error {
	return nil
}

func (r *factoryAcceptanceCompositeRouteRepo) DeleteByGroup(context.Context, int64) error {
	return nil
}

func newFactoryLiveHTTPUpstream() *factoryLiveHTTPUpstream {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	return &factoryLiveHTTPUpstream{client: &http.Client{
		Transport: transport,
		Timeout:   90 * time.Second,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}}
}

func (u *factoryLiveHTTPUpstream) Do(req *http.Request, proxyURL string, _ int64, _ int) (*http.Response, error) {
	if strings.TrimSpace(proxyURL) != "" {
		return nil, errors.New("Factory live smoke does not support a proxy")
	}
	u.mu.Lock()
	if req.URL.Path == "/api/cli/whoami" {
		u.whoami++
	} else {
		u.infer++
	}
	u.mu.Unlock()
	return u.client.Do(req)
}

func (u *factoryLiveHTTPUpstream) DoWithTLS(req *http.Request, proxyURL string, accountID int64, concurrency int, _ *tlsfingerprint.Profile) (*http.Response, error) {
	return u.Do(req, proxyURL, accountID, concurrency)
}

func (u *factoryLiveHTTPUpstream) counts() (whoami, inference int) {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.whoami, u.infer
}

func (u *factoryAcceptanceTransport) Do(req *http.Request, _ string, _ int64, _ int) (*http.Response, error) {
	body, err := io.ReadAll(req.Body)
	if err != nil {
		return nil, err
	}
	_ = req.Body.Close()
	req.Body = io.NopCloser(bytes.NewReader(body))
	u.requests = append(u.requests, req)
	u.bodies = append(u.bodies, append([]byte(nil), body...))
	if len(u.responses) == 0 {
		return nil, errors.New("unexpected Factory upstream call")
	}
	resp := u.responses[0]
	u.responses = u.responses[1:]
	return resp, nil
}

func (u *factoryAcceptanceTransport) DoWithTLS(req *http.Request, proxyURL string, accountID int64, concurrency int, _ *tlsfingerprint.Profile) (*http.Response, error) {
	return u.Do(req, proxyURL, accountID, concurrency)
}

func factoryAcceptanceAccount(region, orgID string) *Account {
	creds := map[string]any{
		"api_key": "fk-factory-acceptance-9101",
		"region":  region,
	}
	if orgID != "" {
		creds["factory_org_id"] = orgID
	}
	return &Account{
		ID:          9101,
		Name:        "factory-acceptance",
		Platform:    PlatformFactory,
		Type:        AccountTypeAPIKey,
		Concurrency: 1,
		Status:      StatusActive,
		Schedulable: true,
		Credentials: creds,
	}
}

func factoryAcceptanceContext(path string, body []byte) (*gin.Context, *httptest.ResponseRecorder) {
	rec := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(rec)
	c.Request = httptest.NewRequest(http.MethodPost, path, bytes.NewReader(body))
	c.Request.Header.Set("Content-Type", "application/json")
	c.Request.Header.Set("Authorization", "Bearer caller-must-not-leak")
	return c, rec
}

func factoryAcceptanceService(upstream *factoryAcceptanceTransport) *OpenAIGatewayService {
	return &OpenAIGatewayService{
		cfg: &config.Config{Security: config.SecurityConfig{
			URLAllowlist: config.URLAllowlistConfig{Enabled: false, AllowInsecureHTTP: true},
		}},
		httpUpstream: upstream,
	}
}

func factoryAnthropicJSON() *http.Response {
	return &http.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Content-Type": []string{"application/json"}, "x-request-id": []string{"rid_factory_anthropic"}},
		Body: io.NopCloser(strings.NewReader(`{
"id":"msg_factory_1","type":"message","role":"assistant","model":"claude-sonnet-4-6",
"content":[
{"type":"text","text":"found Ω"},
{"type":"tool_use","id":"toolu_factory_1","name":"lookup","input":{"q":"Ω"}}
],
"stop_reason":"tool_use",
"usage":{"input_tokens":11,"output_tokens":7,"cache_creation_input_tokens":2,"cache_read_input_tokens":3}
}`)),
	}
}

// factoryAnthropicToolStream exercises the Anthropic SSE shape Factory returns
// for Claude models: text plus a tool_use block whose arguments arrive as
// input_json_delta events. Responses and Chat Completions inbound requests are
// converted from this stream even when the client asks for a buffered reply.
func factoryAnthropicToolStream() *http.Response {
	sse := strings.Join([]string{
		`event: message_start`,
		`data: {"type":"message_start","message":{"id":"msg_factory_cross","type":"message","role":"assistant","model":"claude-sonnet-4-6","content":[],"stop_reason":null,"usage":{"input_tokens":11,"output_tokens":1,"cache_creation_input_tokens":2,"cache_read_input_tokens":3}}}`,
		"",
		`event: content_block_start`,
		`data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
		"",
		`event: content_block_delta`,
		`data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"found Ω"}}`,
		"",
		`event: content_block_stop`,
		`data: {"type":"content_block_stop","index":0}`,
		"",
		`event: content_block_start`,
		`data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_factory_1","name":"lookup","input":{}}}`,
		"",
		`event: content_block_delta`,
		`data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"q\":\"Ω\"}"}}`,
		"",
		`event: content_block_stop`,
		`data: {"type":"content_block_stop","index":1}`,
		"",
		`event: message_delta`,
		`data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":7}}`,
		"",
		`event: message_stop`,
		`data: {"type":"message_stop"}`,
		"",
		"",
	}, "\n")
	return &http.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Content-Type": []string{"text/event-stream"}, "x-request-id": []string{"rid_factory_cross_stream"}},
		Body:       io.NopCloser(strings.NewReader(sse)),
	}
}

func factoryAnthropicStream() *http.Response {
	sse := strings.Join([]string{
		`event: message_start`,
		`data: {"type":"message_start","message":{"id":"msg_factory_stream","type":"message","role":"assistant","model":"claude-sonnet-4-6","content":[],"stop_reason":null,"usage":{"input_tokens":11,"output_tokens":1,"cache_read_input_tokens":3}}}`,
		"",
		`event: content_block_start`,
		`data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
		"",
		`event: content_block_delta`,
		`data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"stream Ω"}}`,
		"",
		`event: content_block_stop`,
		`data: {"type":"content_block_stop","index":0}`,
		"",
		`event: message_delta`,
		`data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}`,
		"",
		`event: message_stop`,
		`data: {"type":"message_stop"}`,
		"",
		"",
	}, "\n")
	return &http.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Content-Type": []string{"text/event-stream"}, "x-request-id": []string{"rid_factory_anthropic_stream"}},
		Body:       io.NopCloser(strings.NewReader(sse)),
	}
}

func factoryAnthropicErrorStream(secret string) *http.Response {
	sse := strings.Join([]string{
		`event: error`,
		`data: {"type":"error","error":{"type":"api_error","message":"upstream failed with ` + secret + `"}}`,
		"",
		"",
	}, "\n")
	return &http.Response{
		StatusCode: http.StatusOK,
		Header: http.Header{
			"Content-Type": []string{"text/event-stream"},
			"x-request-id": []string{secret},
		},
		Body: io.NopCloser(strings.NewReader(sse)),
	}
}

func factoryAcceptanceBodyForSurface(surface, model, extra string) []byte {
	switch surface {
	case "anthropic":
		return []byte(`{"model":"` + model + `","max_tokens":32,"messages":[{"role":"user","content":"must not leave"}]` + extra + `,"stream":false}`)
	case "chat":
		return []byte(`{"model":"` + model + `","messages":[{"role":"user","content":"must not leave"}]` + extra + `,"stream":false}`)
	default:
		return []byte(`{"model":"` + model + `","input":"must not leave"` + extra + `,"stream":false}`)
	}
}

func TestFactoryAcceptance_ForwardResponsesToClaudeCrossProtocolPreservesToolsAndUsage(t *testing.T) {
	gin.SetMode(gin.TestMode)
	body := []byte(`{
"model":"factory/claude-sonnet-4-6",
"instructions":"PRESERVE_ME_SYSTEM_Ω",
"input":[{"role":"user","content":[{"type":"input_text","text":"PRESERVE_ME_INPUT_λ"}]}],
"tools":[{"type":"function","name":"lookup","description":"PRESERVE_ME_TOOL","parameters":{"type":"object","properties":{"q":{"type":"string"}},"required":["q"]}}],
"stream":false
}`)
	upstream := &factoryAcceptanceTransport{responses: []*http.Response{factoryAnthropicToolStream()}}
	svc := factoryAcceptanceService(upstream)
	c, rec := factoryAcceptanceContext("/v1/responses", body)

	result, err := svc.Forward(context.Background(), c, factoryAcceptanceAccount("us", ""), body)
	require.NoError(t, err)
	require.NotNil(t, result)
	require.Len(t, upstream.requests, 1)

	req := upstream.requests[0]
	require.Equal(t, http.MethodPost, req.Method)
	require.Equal(t, "https://api.factory.ai/api/llm/a/v1/messages", req.URL.String())
	require.Equal(t, "Bearer fk-factory-acceptance-9101", req.Header.Get("Authorization"))
	require.Equal(t, "placeholder", req.Header.Get("X-Api-Key"))
	require.Equal(t, "cli", req.Header.Get("X-Factory-Client"))
	require.Empty(t, req.Header.Get("OpenAI-Platform"))
	require.Equal(t, "anthropic", req.Header.Get("x-api-provider"))
	require.Equal(t, "registry_default", req.Header.Get("x-provider-routing-source"))
	require.NotEmpty(t, req.Header.Get("x-session-id"))
	require.NotEmpty(t, req.Header.Get("x-assistant-message-id"))
	require.Empty(t, req.Header.Get("X-Factory-Org-Id"))
	require.Equal(t, "claude-sonnet-4-6", gjson.GetBytes(upstream.bodies[0], "model").String())
	sent := string(upstream.bodies[0])
	require.Contains(t, sent, "You are Droid, an AI software engineering agent built by Factory.")
	require.Contains(t, sent, "PRESERVE_ME_SYSTEM_Ω")
	require.Contains(t, sent, "PRESERVE_ME_INPUT_λ")
	require.Contains(t, sent, "PRESERVE_ME_TOOL")
	require.NotContains(t, sent, "caller-must-not-leak")

	require.Equal(t, 16, result.Usage.InputTokens)
	require.Equal(t, 7, result.Usage.OutputTokens)
	require.Equal(t, 3, result.Usage.CacheReadInputTokens)
	require.Equal(t, 2, result.Usage.CacheCreationInputTokens)
	responseBody := rec.Body.String()
	responseJSON := gjson.Parse(responseBody)
	require.Equal(t, "found Ω", responseJSON.Get(`output.#(type=="message").content.0.text`).String())
	require.Equal(t, "toolu_factory_1", responseJSON.Get(`output.#(type=="function_call").call_id`).String())
	require.Equal(t, "lookup", responseJSON.Get(`output.#(type=="function_call").name`).String())
	require.JSONEq(t, `{"q":"Ω"}`, responseJSON.Get(`output.#(type=="function_call").arguments`).String())
}

func TestFactoryAcceptance_ForwardAsAnthropicNativePreservesToolsAndUsage(t *testing.T) {
	gin.SetMode(gin.TestMode)
	body := []byte(`{
"model":"factory/claude-sonnet-4-6",
"max_tokens":128,
"system":"PRESERVE_ANTHROPIC_SYSTEM_Ω",
"tools":[{"name":"lookup","description":"PRESERVE_ANTHROPIC_TOOL","input_schema":{"type":"object","properties":{"q":{"type":"string"}},"required":["q"]}}],
"messages":[{"role":"user","content":[{"type":"text","text":"PRESERVE_ANTHROPIC_INPUT_λ"}]}],
"stream":false
}`)
	upstream := &factoryAcceptanceTransport{responses: []*http.Response{factoryAnthropicJSON()}}
	svc := factoryAcceptanceService(upstream)
	c, rec := factoryAcceptanceContext("/v1/messages", body)

	result, err := svc.ForwardAsAnthropic(context.Background(), c, factoryAcceptanceAccount("us", ""), body, "", "")
	require.NoError(t, err)
	require.NotNil(t, result)
	require.Len(t, upstream.requests, 1)

	req := upstream.requests[0]
	require.Equal(t, "https://api.factory.ai/api/llm/a/v1/messages", req.URL.String())
	require.Equal(t, "Bearer fk-factory-acceptance-9101", req.Header.Get("Authorization"))
	require.Equal(t, "placeholder", req.Header.Get("X-Api-Key"))
	require.Equal(t, "claude-sonnet-4-6", gjson.GetBytes(upstream.bodies[0], "model").String())
	sent := string(upstream.bodies[0])
	require.Contains(t, sent, "You are Droid, an AI software engineering agent built by Factory.")
	require.Contains(t, sent, "PRESERVE_ANTHROPIC_SYSTEM_Ω")
	require.Contains(t, sent, "PRESERVE_ANTHROPIC_INPUT_λ")
	require.Contains(t, sent, "PRESERVE_ANTHROPIC_TOOL")
	require.NotContains(t, sent, "caller-must-not-leak")

	require.Equal(t, 16, result.Usage.InputTokens)
	require.Equal(t, 7, result.Usage.OutputTokens)
	require.Equal(t, 3, result.Usage.CacheReadInputTokens)
	require.Equal(t, 2, result.Usage.CacheCreationInputTokens)
	responseBody := rec.Body.String()
	require.Contains(t, responseBody, "toolu_factory_1")
	require.Contains(t, responseBody, "found Ω")
}

func TestFactoryAcceptance_ForwardChatCompletionsToClaudeCrossProtocolPreservesToolsAndUsage(t *testing.T) {
	gin.SetMode(gin.TestMode)
	body := []byte(`{
"model":"factory/claude-sonnet-4-6",
"messages":[{"role":"system","content":"PRESERVE_CHAT_SYSTEM_Ω"},{"role":"user","content":"PRESERVE_CHAT_INPUT_λ"}],
"tools":[{"type":"function","function":{"name":"lookup","description":"PRESERVE_CHAT_TOOL","parameters":{"type":"object","properties":{"q":{"type":"string"}},"required":["q"]}}}],
"stream":false
}`)
	upstream := &factoryAcceptanceTransport{responses: []*http.Response{factoryAnthropicToolStream()}}
	svc := factoryAcceptanceService(upstream)
	c, rec := factoryAcceptanceContext("/v1/chat/completions", body)

	result, err := svc.ForwardAsChatCompletions(context.Background(), c, factoryAcceptanceAccount("us", ""), body, "", "")
	require.NoError(t, err)
	require.NotNil(t, result)
	require.Len(t, upstream.requests, 1)

	req := upstream.requests[0]
	require.Equal(t, "https://api.factory.ai/api/llm/a/v1/messages", req.URL.String())
	require.Equal(t, "Bearer fk-factory-acceptance-9101", req.Header.Get("Authorization"))
	require.Equal(t, "placeholder", req.Header.Get("X-Api-Key"))
	require.Equal(t, "claude-sonnet-4-6", gjson.GetBytes(upstream.bodies[0], "model").String())
	sent := string(upstream.bodies[0])
	require.Contains(t, sent, "You are Droid, an AI software engineering agent built by Factory.")
	require.Contains(t, sent, "PRESERVE_CHAT_SYSTEM_Ω")
	require.Contains(t, sent, "PRESERVE_CHAT_INPUT_λ")
	require.Contains(t, sent, "PRESERVE_CHAT_TOOL")
	require.NotContains(t, sent, "caller-must-not-leak")

	require.Equal(t, 16, result.Usage.InputTokens)
	require.Equal(t, 7, result.Usage.OutputTokens)
	require.Equal(t, 3, result.Usage.CacheReadInputTokens)
	require.Equal(t, 2, result.Usage.CacheCreationInputTokens)
	responseJSON := gjson.Parse(rec.Body.String())
	require.Equal(t, "found Ω", responseJSON.Get("choices.0.message.content").String())
	require.Equal(t, "toolu_factory_1", responseJSON.Get("choices.0.message.tool_calls.0.id").String())
	require.Equal(t, "lookup", responseJSON.Get("choices.0.message.tool_calls.0.function.name").String())
	require.Equal(t, "tool_calls", responseJSON.Get("choices.0.finish_reason").String())
}

func TestFactoryAcceptance_ForwardResponsesToClaudeStreamingPreservesDeltaAndUsage(t *testing.T) {
	gin.SetMode(gin.TestMode)
	body := []byte(`{"model":"factory/claude-sonnet-4-6","input":"stream please","stream":true}`)
	upstream := &factoryAcceptanceTransport{responses: []*http.Response{factoryAnthropicToolStream()}}
	svc := factoryAcceptanceService(upstream)
	c, rec := factoryAcceptanceContext("/v1/responses", body)

	result, err := svc.Forward(context.Background(), c, factoryAcceptanceAccount("us", ""), body)
	require.NoError(t, err)
	require.NotNil(t, result)
	require.True(t, result.Stream)
	require.Equal(t, 16, result.Usage.InputTokens)
	require.Equal(t, 7, result.Usage.OutputTokens)
	require.Equal(t, 3, result.Usage.CacheReadInputTokens)
	require.Equal(t, 2, result.Usage.CacheCreationInputTokens)
	require.Len(t, upstream.requests, 1)
	require.Equal(t, "https://api.factory.ai/api/llm/a/v1/messages", upstream.requests[0].URL.String())
	responseBody := rec.Body.String()
	require.Contains(t, responseBody, "response.output_text.delta")
	require.Contains(t, responseBody, "found Ω")
	require.Contains(t, responseBody, "response.completed")
	require.Contains(t, responseBody, "toolu_factory_1")
	require.Contains(t, responseBody, "lookup")
}

func TestFactoryAcceptance_ForwardChatCompletionsToClaudeStreamingPreservesEventsAndUsage(t *testing.T) {
	gin.SetMode(gin.TestMode)
	body := []byte(`{
"model":"factory/claude-sonnet-4-6",
"messages":[{"role":"user","content":"stream please"}],
"tools":[{"type":"function","function":{"name":"lookup","parameters":{"type":"object","properties":{"q":{"type":"string"}}}}}],
"stream":true
}`)
	upstream := &factoryAcceptanceTransport{responses: []*http.Response{factoryAnthropicToolStream()}}
	svc := factoryAcceptanceService(upstream)
	c, rec := factoryAcceptanceContext("/v1/chat/completions", body)

	result, err := svc.ForwardAsChatCompletions(context.Background(), c, factoryAcceptanceAccount("us", ""), body, "", "")
	require.NoError(t, err)
	require.NotNil(t, result)
	require.True(t, result.Stream)
	require.Equal(t, 16, result.Usage.InputTokens)
	require.Equal(t, 7, result.Usage.OutputTokens)
	require.Equal(t, 3, result.Usage.CacheReadInputTokens)
	require.Equal(t, 2, result.Usage.CacheCreationInputTokens)
	require.Len(t, upstream.requests, 1)
	require.Equal(t, "https://api.factory.ai/api/llm/a/v1/messages", upstream.requests[0].URL.String())
	responseBody := rec.Body.String()
	require.Contains(t, responseBody, "chat.completion.chunk")
	require.Contains(t, responseBody, "found Ω")
	require.Contains(t, responseBody, "toolu_factory_1")
	require.Contains(t, responseBody, "[DONE]")
}

func TestFactoryAcceptance_ForwardAsAnthropicStreamingPreservesEventsAndUsage(t *testing.T) {
	gin.SetMode(gin.TestMode)
	body := []byte(`{"model":"factory/claude-sonnet-4-6","max_tokens":64,"system":"stream system","messages":[{"role":"user","content":"stream input"}],"stream":true}`)
	upstream := &factoryAcceptanceTransport{responses: []*http.Response{factoryAnthropicStream()}}
	svc := factoryAcceptanceService(upstream)
	c, rec := factoryAcceptanceContext("/v1/messages", body)

	result, err := svc.ForwardAsAnthropic(context.Background(), c, factoryAcceptanceAccount("us", ""), body, "", "")
	require.NoError(t, err)
	require.NotNil(t, result)
	require.True(t, result.Stream)
	require.Equal(t, 14, result.Usage.InputTokens)
	require.Equal(t, 7, result.Usage.OutputTokens)
	require.Equal(t, 3, result.Usage.CacheReadInputTokens)
	require.Len(t, upstream.requests, 1)
	require.Equal(t, "https://api.factory.ai/api/llm/a/v1/messages", upstream.requests[0].URL.String())
	responseBody := rec.Body.String()
	require.Contains(t, responseBody, "message_start")
	require.Contains(t, responseBody, "stream Ω")
	require.Contains(t, responseBody, "message_stop")
}

func TestFactoryAcceptance_EUOrgAndCallerOverridesAreCanonicalized(t *testing.T) {
	gin.SetMode(gin.TestMode)
	body := []byte(`{"model":"factory/claude-sonnet-4-6","input":"credential check","stream":false}`)
	upstream := &factoryAcceptanceTransport{responses: []*http.Response{factoryAnthropicToolStream()}}
	svc := factoryAcceptanceService(upstream)
	c, _ := factoryAcceptanceContext("/v1/responses", body)
	c.Request.Header.Set("X-Factory-Org-Id", "caller-org")
	c.Request.Header.Set("X-Api-Key", "caller-api-key")
	c.Request.Header.Set("Cookie", "session=caller-cookie")
	account := factoryAcceptanceAccount("eu", "fac_org_acceptance")

	_, err := svc.Forward(context.Background(), c, account, body)
	require.NoError(t, err)
	require.Len(t, upstream.requests, 1)
	req := upstream.requests[0]
	require.Equal(t, "https://api.eu.factory.ai/api/llm/a/v1/messages", req.URL.String())
	require.Equal(t, "Bearer fk-factory-acceptance-9101", req.Header.Get("Authorization"))
	require.Equal(t, "fac_org_acceptance", req.Header.Get("X-Factory-Org-Id"))
	require.Equal(t, "cli", req.Header.Get("X-Factory-Client"))
	require.Equal(t, "placeholder", req.Header.Get("X-Api-Key"))
	require.Empty(t, req.Header.Get("Cookie"))
	require.NotContains(t, string(upstream.bodies[0]), "caller-must-not-leak")
}

func TestFactoryAcceptance_RejectsNonClaudeFamiliesAndStaleModelsWithoutUpstreamCall(t *testing.T) {
	gin.SetMode(gin.TestMode)
	cases := []struct {
		name    string
		surface string
		model   string
		extra   string
		path    string
	}{
		{name: "responses fast id", model: "factory/gpt-5.5-fast"},
		{name: "responses bare gpt", model: "gpt-5.5"},
		{name: "responses auto", model: "factory/auto"},
		{name: "responses compact subpath", model: "factory/claude-sonnet-4-6", path: "/v1/responses/compact"},
		{name: "responses fast intent on claude", model: "factory/claude-sonnet-4-6", extra: `,"service_tier":"priority"`},
		{name: "anthropic stale gpt", surface: "anthropic", model: "factory/gpt-5.5"},
		{name: "anthropic stale glm", surface: "anthropic", model: "factory/glm-5.3"},
		{name: "chat stale gpt", surface: "chat", model: "factory/gpt-5.5"},
		{name: "chat stale deepseek", surface: "chat", model: "factory/deepseek-v4.1-flash"},
	}
	for _, family := range []string{
		"gpt-5.5",
		"gpt-6.1-sol",
		"gpt-5.3-codex",
		"glm-5.3",
		"glm-5.3-flash",
		"deepseek-v4.1-flash",
		"deepseek-v4.1-flash-1017",
		"grok-4.7",
		"grok-4.6",
		"kimi-k3",
		"minimax-m3",
		"minimax-m2.7",
		"mistral-large-4",
		"mistral-medium-3.5",
		"qwen3.8-max",
		"nemotron-3-ultra",
		"gemini-3.1-pro-preview",
		"not-a-real-model",
	} {
		cases = append(cases, struct {
			name    string
			surface string
			model   string
			extra   string
			path    string
		}{name: "family-" + family, model: "factory/" + family})
	}
	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			body := factoryAcceptanceBodyForSurface(tt.surface, tt.model, tt.extra)
			upstream := &factoryAcceptanceTransport{}
			svc := factoryAcceptanceService(upstream)
			path := tt.path
			if path == "" {
				switch tt.surface {
				case "anthropic":
					path = "/v1/messages"
				case "chat":
					path = "/v1/chat/completions"
				default:
					path = "/v1/responses"
				}
			}
			c, rec := factoryAcceptanceContext(path, body)

			var result *OpenAIForwardResult
			var err error
			switch tt.surface {
			case "anthropic":
				result, err = svc.ForwardAsAnthropic(context.Background(), c, factoryAcceptanceAccount("us", ""), body, "", "")
			case "chat":
				result, err = svc.ForwardAsChatCompletions(context.Background(), c, factoryAcceptanceAccount("us", ""), body, "", "")
			default:
				result, err = svc.Forward(context.Background(), c, factoryAcceptanceAccount("us", ""), body)
			}
			require.Error(t, err)
			require.Nil(t, result)
			require.Empty(t, upstream.requests, "non-Claude or stale Factory model/intent must not reach the transport")
			require.NotContains(t, rec.Body.String(), "fk-factory-acceptance-9101")
		})
	}
}

func TestFactoryAcceptance_RejectsAnthropicFastIntentWithoutUpstreamCall(t *testing.T) {
	gin.SetMode(gin.TestMode)
	body := []byte(`{"model":"factory/claude-sonnet-4-6","max_tokens":32,"speed":"fast","messages":[{"role":"user","content":"fast please"}],"stream":false}`)
	upstream := &factoryAcceptanceTransport{}
	svc := factoryAcceptanceService(upstream)
	c, _ := factoryAcceptanceContext("/v1/messages", body)

	result, err := svc.ForwardAsAnthropic(context.Background(), c, factoryAcceptanceAccount("us", ""), body, "", "")
	require.Error(t, err)
	require.Nil(t, result)
	require.Empty(t, upstream.requests, "Anthropic Fast intent must not reach the transport")
}

func TestFactoryAcceptance_RejectsResponsesCrossProtocolFastIntentWithoutUpstreamCall(t *testing.T) {
	gin.SetMode(gin.TestMode)
	body := []byte(`{"model":"factory/claude-sonnet-4-6","input":"fast across protocols","service_tier":"priority","stream":false}`)
	upstream := &factoryAcceptanceTransport{}
	svc := factoryAcceptanceService(upstream)
	c, _ := factoryAcceptanceContext("/v1/responses", body)

	result, err := svc.Forward(context.Background(), c, factoryAcceptanceAccount("us", ""), body)
	require.Error(t, err)
	require.Nil(t, result)
	require.Empty(t, upstream.requests, "Responses priority intent must be rejected before an Anthropic conversion can drop it")
}

func TestFactoryAcceptance_RejectsAnthropicFastBetaHeaderWithoutUpstreamCall(t *testing.T) {
	gin.SetMode(gin.TestMode)
	body := []byte(`{"model":"factory/claude-sonnet-4-6","max_tokens":32,"messages":[{"role":"user","content":"fast beta"}],"stream":false}`)
	upstream := &factoryAcceptanceTransport{}
	svc := factoryAcceptanceService(upstream)
	c, _ := factoryAcceptanceContext("/v1/messages", body)
	c.Request.Header.Set("anthropic-beta", "fast-mode-2026-02-01")

	result, err := svc.ForwardAsAnthropic(context.Background(), c, factoryAcceptanceAccount("us", ""), body, "", "")
	require.Error(t, err)
	require.Nil(t, result)
	require.Empty(t, upstream.requests, "fast-mode beta header must be rejected at the final Factory adapter")
}

func TestFactoryAcceptance_RejectsInvalidAccountStateWithoutUpstreamCall(t *testing.T) {
	gin.SetMode(gin.TestMode)
	body := []byte(`{"model":"factory/claude-sonnet-4-6","input":"must not leave","stream":false}`)
	cases := []struct {
		name   string
		mutate func(*Account)
	}{
		{name: "oauth account type", mutate: func(a *Account) {
			a.Type = AccountTypeOAuth
			a.Credentials = map[string]any{"access_token": "oauth-secret"}
		}},
		{name: "missing api key", mutate: func(a *Account) { delete(a.Credentials, "api_key") }},
		{name: "blank api key", mutate: func(a *Account) { a.Credentials["api_key"] = "" }},
		{name: "non fk key", mutate: func(a *Account) { a.Credentials["api_key"] = "sk-not-factory" }},
		{name: "invalid region", mutate: func(a *Account) { a.Credentials["region"] = "moon" }},
	}
	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			account := factoryAcceptanceAccount("us", "")
			tt.mutate(account)
			upstream := &factoryAcceptanceTransport{}
			svc := factoryAcceptanceService(upstream)
			c, _ := factoryAcceptanceContext("/v1/responses", body)
			result, err := svc.Forward(context.Background(), c, account, body)
			require.Error(t, err)
			require.Nil(t, result)
			require.Empty(t, upstream.requests)
		})
	}
}

func TestFactoryAcceptance_HostilePersistedCredentialsCannotRedirect(t *testing.T) {
	gin.SetMode(gin.TestMode)
	body := []byte(`{"model":"factory/claude-sonnet-4-6","input":"hostile state check","stream":false}`)
	cases := []struct {
		name   string
		mutate func(*Account)
	}{
		{name: "base url", mutate: func(a *Account) {
			a.Credentials["base_url"] = "https://caller-controlled.example"
		}},
		{name: "protocol base urls", mutate: func(a *Account) {
			a.Credentials["api_base_urls"] = map[string]any{APIProtocolResponses: "https://caller-controlled.example"}
		}},
		{name: "pinned protocol", mutate: func(a *Account) {
			a.Credentials["api_protocol"] = APIProtocolChatCompletions
		}},
		{name: "nested headers", mutate: func(a *Account) {
			a.Credentials["headers"] = map[string]any{"Authorization": "Bearer nested-caller", "X-Factory-Org-Id": "nested-org"}
		}},
	}
	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			account := factoryAcceptanceAccount("us", "")
			tt.mutate(account)
			upstream := &factoryAcceptanceTransport{responses: []*http.Response{factoryAnthropicToolStream()}}
			svc := factoryAcceptanceService(upstream)
			c, _ := factoryAcceptanceContext("/v1/responses", body)

			result, err := svc.Forward(context.Background(), c, account, body)
			if err != nil {
				require.Nil(t, result)
				require.Empty(t, upstream.requests, "hostile persisted credentials must fail before transport or be ignored safely")
				return
			}
			require.Len(t, upstream.requests, 1)
			req := upstream.requests[0]
			require.Equal(t, "https://api.factory.ai/api/llm/a/v1/messages", req.URL.String())
			require.Equal(t, "Bearer fk-factory-acceptance-9101", req.Header.Get("Authorization"))
			require.Empty(t, req.Header.Get("X-Factory-Org-Id"))
			require.NotContains(t, string(upstream.bodies[0]), "nested-caller")
			require.NotContains(t, string(upstream.bodies[0]), "nested-org")
		})
	}
}

func TestFactoryAcceptance_ModelSyncFailsClosedWithoutUpstreamCall(t *testing.T) {
	upstream := &factoryAcceptanceTransport{}
	svc := &AccountTestService{
		cfg:          factoryAcceptanceService(upstream).cfg,
		httpUpstream: upstream,
	}
	account := factoryAcceptanceAccount("us", "")

	catalog, err := svc.SyncUpstreamModelCatalog(context.Background(), account)
	require.Error(t, err)
	var syncErr *UpstreamModelSyncError
	require.ErrorAs(t, err, &syncErr)
	require.Equal(t, UpstreamModelSyncErrorUnsupported, syncErr.Kind)
	require.Nil(t, catalog)
	require.Empty(t, upstream.requests)

	models, err := svc.FetchUpstreamSupportedModels(context.Background(), account)
	require.Error(t, err)
	require.ErrorAs(t, err, &syncErr)
	require.Equal(t, UpstreamModelSyncErrorUnsupported, syncErr.Kind)
	require.Empty(t, models)
	require.Empty(t, upstream.requests, "Factory model discovery must not make a generic /models call")
}

func TestFactoryAcceptance_CompositeRouteSchedulerAndNativePricing(t *testing.T) {
	repo := &factoryAcceptanceCompositeRouteRepo{routes: []CompositeModelRoute{
		{
			ID:             1,
			GroupID:        7,
			PublicModel:    "factory/claude-sonnet-4-6",
			MatchType:      CompositeRouteMatchExact,
			TargetPlatform: PlatformFactory,
			UpstreamModel:  "claude-sonnet-4-6",
			Endpoint:       CompositeRouteEndpointChatCompletions,
			Priority:       100,
			Enabled:        true,
		},
		{
			ID:             2,
			GroupID:        7,
			PublicModel:    "team-chat",
			MatchType:      CompositeRouteMatchExact,
			TargetPlatform: PlatformFactory,
			UpstreamModel:  "factory/claude-sonnet-4-6",
			Endpoint:       CompositeRouteEndpointChatCompletions,
			Priority:       100,
			Enabled:        true,
		},
	}}
	resolver := NewCompositeRouteResolver(repo)

	canonical, err := resolver.Resolve(context.Background(), 7, "factory/claude-sonnet-4-6", CompositeRouteEndpointChatCompletions)
	require.NoError(t, err)
	require.True(t, canonical.Matched)
	require.Equal(t, CompositeRouteSourceExplicit, canonical.Source)
	require.Equal(t, PlatformFactory, canonical.TargetPlatform)
	require.Equal(t, "claude-sonnet-4-6", canonical.UpstreamModel)

	alias, err := resolver.Resolve(context.Background(), 7, "team-chat", CompositeRouteEndpointChatCompletions)
	require.NoError(t, err)
	require.True(t, alias.Matched)
	require.Equal(t, PlatformFactory, alias.TargetPlatform)
	require.Equal(t, "factory/claude-sonnet-4-6", alias.UpstreamModel)

	account := factoryAcceptanceAccount("us", "")
	native, matched := account.ResolveMappedModel(alias.UpstreamModel)
	require.True(t, matched)
	require.Equal(t, "claude-sonnet-4-6", native, "pricing must receive the actual native model")

	platform, ok := DetectModelPlatform("factory/claude-sonnet-4-6")
	require.True(t, ok)
	require.Equal(t, PlatformFactory, platform)
	require.True(t, isConcreteRequestPlatform(PlatformFactory))
	found := false
	for _, bucket := range schedulerCanonicalBuckets(99) {
		if bucket.Platform == PlatformFactory {
			found = true
			break
		}
	}
	require.True(t, found, "composite scheduler must have a Factory bucket")
}

func TestFactoryAcceptance_CountTokensFailsClosedWithoutTransport(t *testing.T) {
	gin.SetMode(gin.TestMode)
	upstream := &factoryAcceptanceTransport{}
	svc := factoryAcceptanceService(upstream)
	account := factoryAcceptanceAccount("us", "")

	c, rec := factoryAcceptanceContext("/v1/responses/input_tokens", []byte(`{"model":"factory/claude-sonnet-4-6","input":"count me"}`))
	err := svc.ForwardResponsesInputTokens(context.Background(), c, account, []byte(`{"model":"factory/claude-sonnet-4-6","input":"count me"}`))
	require.Error(t, err)
	require.Equal(t, http.StatusBadRequest, rec.Code)
	require.Empty(t, upstream.requests)

	anthropicBody := []byte(`{"model":"factory/claude-sonnet-4-6","messages":[{"role":"user","content":"count me"}]}`)
	c2, rec2 := factoryAcceptanceContext("/v1/messages/count_tokens", anthropicBody)
	err = svc.ForwardCountTokensAsAnthropic(context.Background(), c2, account, anthropicBody, "")
	require.Error(t, err)
	require.Equal(t, http.StatusBadRequest, rec2.Code)
	require.Empty(t, upstream.requests)
}

func TestFactoryAcceptance_RealSchedulerSelectsFactoryForNativeAndCompositeGroups(t *testing.T) {
	resetOpenAIAdvancedSchedulerSettingCacheForTest()
	groupNative := int64(7001)
	groupComposite := int64(7002)
	native := Account{
		ID:          7101,
		Name:        "factory-native-bucket",
		Platform:    PlatformFactory,
		Type:        AccountTypeAPIKey,
		Concurrency: 1,
		Priority:    1,
		Status:      StatusActive,
		Schedulable: true,
		GroupIDs:    []int64{groupNative},
		Credentials: map[string]any{"api_key": "fk-factory-acceptance-9101", "region": "us"},
	}
	compositeAccount := Account{
		ID:          7201,
		Name:        "factory-composite-bucket",
		Platform:    PlatformFactory,
		Type:        AccountTypeAPIKey,
		Concurrency: 1,
		Priority:    1,
		Status:      StatusActive,
		Schedulable: true,
		GroupIDs:    []int64{groupComposite},
		Credentials: map[string]any{
			"api_key": "fk-factory-acceptance-9101",
			"region":  "us",
			"model_mapping": map[string]any{
				"team-chat": "factory/claude-sonnet-4-6",
			},
		},
	}
	wrongPlatform := Account{
		ID:          7301,
		Name:        "wrong-platform-higher-priority",
		Platform:    PlatformOpenAI,
		Type:        AccountTypeAPIKey,
		Concurrency: 1,
		Priority:    0,
		Status:      StatusActive,
		Schedulable: true,
		GroupIDs:    []int64{groupNative, groupComposite},
		Credentials: map[string]any{"api_key": "sk-wrong-platform"},
	}
	repo := schedulerGroupAwareOpenAIAccountRepo{schedulerTestOpenAIAccountRepo{accounts: []Account{wrongPlatform, native, compositeAccount}}}
	cfg := &config.Config{}
	cfg.Gateway.Scheduling.LoadBatchEnabled = false
	svc := &OpenAIGatewayService{
		accountRepo:        repo,
		cache:              &schedulerTestGatewayCache{},
		cfg:                cfg,
		concurrencyService: NewConcurrencyService(schedulerTestConcurrencyCache{}),
	}

	nativeSelection, _, err := svc.SelectAccountWithSchedulerForCapability(
		context.Background(), &groupNative, "", "", "factory/claude-sonnet-4-6", nil,
		OpenAIUpstreamTransportAny, OpenAIEndpointCapabilityResponses, false, false, false, PlatformFactory,
	)
	require.NoError(t, err)
	require.NotNil(t, nativeSelection)
	require.NotNil(t, nativeSelection.Account)
	require.Equal(t, int64(7101), nativeSelection.Account.ID)
	if nativeSelection.ReleaseFunc != nil {
		defer nativeSelection.ReleaseFunc()
	}

	routeRepo := &factoryAcceptanceCompositeRouteRepo{routes: []CompositeModelRoute{{
		ID: 7002, GroupID: groupComposite, PublicModel: "team-chat", MatchType: CompositeRouteMatchExact,
		TargetPlatform: PlatformFactory, UpstreamModel: "factory/claude-sonnet-4-6", Endpoint: CompositeRouteEndpointChatCompletions,
		Priority: 100, Enabled: true,
	}}}
	decision, err := NewCompositeRouteResolver(routeRepo).Resolve(context.Background(), groupComposite, "team-chat", CompositeRouteEndpointChatCompletions)
	require.NoError(t, err)
	require.True(t, decision.Matched)
	require.Equal(t, PlatformFactory, decision.TargetPlatform)
	compositeCtx := WithCompositeRouteDecision(context.Background(), decision)
	compositeSelection, _, err := svc.SelectAccountWithSchedulerForCapability(
		compositeCtx, &groupComposite, "", "", "team-chat", nil,
		OpenAIUpstreamTransportAny, OpenAIEndpointCapabilityChatCompletions, false, false, false, decision.TargetPlatform,
	)
	require.NoError(t, err)
	require.NotNil(t, compositeSelection)
	require.NotNil(t, compositeSelection.Account)
	require.Equal(t, int64(7201), compositeSelection.Account.ID)
	if compositeSelection.ReleaseFunc != nil {
		defer compositeSelection.ReleaseFunc()
	}
}

func TestFactoryAcceptance_StaleGPTModelMappingIsNotSchedulableAndOpenAIGPTStillWorks(t *testing.T) {
	resetOpenAIAdvancedSchedulerSettingCacheForTest()
	staleGroup := int64(7501)
	claudeGroup := int64(7502)
	openAIGroup := int64(7503)
	stale := Account{
		ID:          7501,
		Name:        "factory-stale-gpt-mapping",
		Platform:    PlatformFactory,
		Type:        AccountTypeAPIKey,
		Concurrency: 1,
		Priority:    1,
		Status:      StatusActive,
		Schedulable: true,
		GroupIDs:    []int64{staleGroup},
		Credentials: map[string]any{
			"api_key": "fk-factory-acceptance-9101",
			"region":  "us",
			"model_mapping": map[string]any{
				"team-chat": "factory/gpt-5.5",
			},
		},
	}
	claude := Account{
		ID:          7502,
		Name:        "factory-claude-only",
		Platform:    PlatformFactory,
		Type:        AccountTypeAPIKey,
		Concurrency: 1,
		Priority:    1,
		Status:      StatusActive,
		Schedulable: true,
		GroupIDs:    []int64{claudeGroup},
		Credentials: map[string]any{"api_key": "fk-factory-acceptance-9101", "region": "us"},
	}
	openAI := Account{
		ID:          7503,
		Name:        "openai-gpt-platform",
		Platform:    PlatformOpenAI,
		Type:        AccountTypeAPIKey,
		Concurrency: 1,
		Priority:    1,
		Status:      StatusActive,
		Schedulable: true,
		GroupIDs:    []int64{openAIGroup},
		Credentials: map[string]any{"api_key": "sk-openai-platform"},
	}

	require.False(t, stale.IsModelSupported("team-chat"), "a stale GPT mapping must not make an alias schedulable")
	require.False(t, stale.IsModelSupported("factory/gpt-5.5"), "Factory no longer serves the GPT registry")
	require.True(t, claude.IsModelSupported("factory/claude-sonnet-4-6"))
	protocol, ok := claude.FactoryProtocolForModel("factory/claude-sonnet-4-6")
	require.True(t, ok)
	require.Equal(t, APIProtocolAnthropic, protocol)
	_, ok = stale.FactoryProtocolForModel("factory/gpt-5.5")
	require.False(t, ok, "stale GPT ids must no longer resolve to a Factory protocol")
	require.True(t, openAI.IsModelSupported("gpt-5.5"), "OpenAI platform GPT must remain supported")

	repo := schedulerGroupAwareOpenAIAccountRepo{schedulerTestOpenAIAccountRepo{accounts: []Account{stale, claude, openAI}}}
	cfg := &config.Config{}
	cfg.Gateway.Scheduling.LoadBatchEnabled = false
	svc := &OpenAIGatewayService{
		accountRepo:        repo,
		cache:              &schedulerTestGatewayCache{},
		cfg:                cfg,
		concurrencyService: NewConcurrencyService(schedulerTestConcurrencyCache{}),
	}

	selection, _, err := svc.SelectAccountWithSchedulerForCapability(
		context.Background(), &staleGroup, "", "", "team-chat", nil,
		OpenAIUpstreamTransportAny, OpenAIEndpointCapabilityChatCompletions, false, false, false, PlatformFactory,
	)
	require.ErrorIs(t, err, ErrNoAvailableAccounts)
	require.Nil(t, selection)

	selection, _, err = svc.SelectAccountWithSchedulerForCapability(
		context.Background(), &staleGroup, "", "", "factory/gpt-5.5", nil,
		OpenAIUpstreamTransportAny, OpenAIEndpointCapabilityResponses, false, false, false, PlatformFactory,
	)
	require.ErrorIs(t, err, ErrNoAvailableAccounts)
	require.Nil(t, selection)

	selection, _, err = svc.SelectAccountWithSchedulerForCapability(
		context.Background(), &claudeGroup, "", "", "factory/claude-sonnet-4-6", nil,
		OpenAIUpstreamTransportAny, OpenAIEndpointCapabilityResponses, false, false, false, PlatformFactory,
	)
	require.NoError(t, err)
	require.NotNil(t, selection)
	require.NotNil(t, selection.Account)
	require.Equal(t, int64(7502), selection.Account.ID)
	if selection.ReleaseFunc != nil {
		defer selection.ReleaseFunc()
	}

	selection, _, err = svc.SelectAccountWithSchedulerForCapability(
		context.Background(), &openAIGroup, "", "", "gpt-5.5", nil,
		OpenAIUpstreamTransportAny, OpenAIEndpointCapabilityResponses, false, false, false, PlatformOpenAI,
	)
	require.NoError(t, err)
	require.NotNil(t, selection)
	require.NotNil(t, selection.Account)
	require.Equal(t, int64(7503), selection.Account.ID)
	if selection.ReleaseFunc != nil {
		defer selection.ReleaseFunc()
	}
}

func TestFactoryAcceptance_RealCompositeSelectionForwardAndRecordUsageUsesNativePricing(t *testing.T) {
	resetOpenAIAdvancedSchedulerSettingCacheForTest()
	gin.SetMode(gin.TestMode)
	groupID := int64(7003)
	account := Account{
		ID:          7401,
		Name:        "factory-composite-priced",
		Platform:    PlatformFactory,
		Type:        AccountTypeAPIKey,
		Concurrency: 1,
		Priority:    1,
		Status:      StatusActive,
		Schedulable: true,
		GroupIDs:    []int64{groupID},
		Credentials: map[string]any{
			"api_key": "fk-factory-acceptance-9101",
			"region":  "us",
			"model_mapping": map[string]any{
				"team-chat": "factory/claude-sonnet-4-6",
			},
		},
	}
	wrongPlatform := Account{
		ID:          7402,
		Name:        "wrong-platform",
		Platform:    PlatformOpenAI,
		Type:        AccountTypeAPIKey,
		Concurrency: 1,
		Priority:    0,
		Status:      StatusActive,
		Schedulable: true,
		GroupIDs:    []int64{groupID},
		Credentials: map[string]any{"api_key": "sk-wrong-platform"},
	}
	upstream := &factoryAcceptanceTransport{responses: []*http.Response{factoryAnthropicToolStream()}}
	usageRepo := &openAIRecordUsageLogRepoStub{inserted: true}
	userRepo := &openAIRecordUsageUserRepoStub{}
	subRepo := &openAIRecordUsageSubRepoStub{}
	svc := newOpenAIRecordUsageServiceForTest(usageRepo, userRepo, subRepo, nil)
	svc.accountRepo = schedulerGroupAwareOpenAIAccountRepo{schedulerTestOpenAIAccountRepo{accounts: []Account{wrongPlatform, account}}}
	svc.cache = &schedulerTestGatewayCache{}
	svc.concurrencyService = NewConcurrencyService(schedulerTestConcurrencyCache{})
	svc.cfg.Gateway.Scheduling.LoadBatchEnabled = false
	svc.httpUpstream = upstream
	svc.resolver = NewModelPricingResolver(nil, svc.billingService)

	routeRepo := &factoryAcceptanceCompositeRouteRepo{routes: []CompositeModelRoute{{
		ID: 7003, GroupID: groupID, PublicModel: "team-chat", MatchType: CompositeRouteMatchExact,
		TargetPlatform: PlatformFactory, UpstreamModel: "factory/claude-sonnet-4-6", Endpoint: CompositeRouteEndpointChatCompletions,
		Priority: 100, Enabled: true,
	}}}
	decision, err := NewCompositeRouteResolver(routeRepo).Resolve(context.Background(), groupID, "team-chat", CompositeRouteEndpointChatCompletions)
	require.NoError(t, err)
	selectionCtx := WithCompositeRouteDecision(context.Background(), decision)
	selection, _, err := svc.SelectAccountWithSchedulerForCapability(
		selectionCtx, &groupID, "", "", "team-chat", nil,
		OpenAIUpstreamTransportAny, OpenAIEndpointCapabilityChatCompletions, false, false, false, decision.TargetPlatform,
	)
	require.NoError(t, err)
	require.NotNil(t, selection)
	require.NotNil(t, selection.Account)
	require.Equal(t, int64(7401), selection.Account.ID)
	if selection.ReleaseFunc != nil {
		defer selection.ReleaseFunc()
	}

	body := []byte(`{"model":"team-chat","messages":[{"role":"user","content":"price please"}],"stream":false}`)
	c, rec := factoryAcceptanceContext("/v1/chat/completions", body)
	result, err := svc.ForwardAsChatCompletions(selectionCtx, c, selection.Account, body, "", decision.UpstreamModel)
	require.NoError(t, err)
	require.NotNil(t, result)
	require.Equal(t, http.StatusOK, rec.Code)
	require.Len(t, upstream.requests, 1)
	require.Equal(t, "claude-sonnet-4-6", gjson.GetBytes(upstream.bodies[0], "model").String())
	require.Equal(t, "claude-sonnet-4-6", result.UpstreamModel)

	expected := expectedOpenAICost(t, svc, "claude-sonnet-4-6", result.Usage, 1.1)
	require.Greater(t, expected.TotalCost, 0.0)
	err = svc.RecordUsage(context.Background(), &OpenAIRecordUsageInput{
		Result:  result,
		APIKey:  &APIKey{ID: 9501},
		User:    &User{ID: 9601},
		Account: selection.Account,
	})
	require.NoError(t, err)
	require.NotNil(t, usageRepo.lastLog)
	require.Equal(t, "team-chat", usageRepo.lastLog.RequestedModel)
	require.NotNil(t, usageRepo.lastLog.UpstreamModel)
	require.Equal(t, "claude-sonnet-4-6", *usageRepo.lastLog.UpstreamModel)
	require.InDelta(t, expected.TotalCost, usageRepo.lastLog.TotalCost, 1e-12)
	require.InDelta(t, expected.ActualCost, usageRepo.lastLog.ActualCost, 1e-12)
	require.InDelta(t, expected.ActualCost, userRepo.lastAmount, 1e-12)
}

func TestFactoryAcceptance_GetAvailableModelsReturnsClaudeOnlyCatalog(t *testing.T) {
	resetGatewayHotpathStatsForTest()
	groupDefault := int64(8101)
	groupExplicit := int64(8102)
	defaultAccount := Account{
		ID:          8201,
		Platform:    PlatformFactory,
		Type:        AccountTypeAPIKey,
		Status:      StatusActive,
		Schedulable: true,
		Credentials: map[string]any{"api_key": "fk-factory-acceptance-9101", "region": "us"},
	}
	explicitAccount := Account{
		ID:          8202,
		Platform:    PlatformFactory,
		Type:        AccountTypeAPIKey,
		Status:      StatusActive,
		Schedulable: true,
		Credentials: map[string]any{
			"api_key": "fk-factory-acceptance-9101",
			"region":  "us",
			"model_mapping": map[string]any{
				"team-chat": "factory/claude-sonnet-4-6",
			},
		},
	}
	repo := &modelsListAccountRepoStub{byGroup: map[int64][]Account{
		groupDefault:  {defaultAccount},
		groupExplicit: {explicitAccount},
	}}
	svc := &GatewayService{
		accountRepo:        repo,
		modelsListCache:    gocache.New(time.Minute, time.Minute),
		modelsListCacheTTL: time.Minute,
	}

	defaultModels := svc.GetAvailableModels(context.Background(), &groupDefault, PlatformFactory)
	require.NotEmpty(t, defaultModels)
	require.ElementsMatch(t, DefaultFactoryModelIDs(), defaultModels)
	require.Contains(t, defaultModels, "factory/claude-sonnet-4-6")
	fableFound := false
	for _, model := range defaultModels {
		require.True(t, strings.HasPrefix(model, "factory/claude-"), "unexpected non-Claude model in Factory list: %s", model)
		if strings.Contains(model, "fable") {
			fableFound = true
		}
	}
	require.True(t, fableFound, "Factory Claude catalog must include a fable model")
	for _, stale := range []string{
		"factory/gpt-5.5",
		"factory/gpt-6.1-sol",
		"factory/glm-5.3",
		"factory/deepseek-v4.1-flash",
		"factory/grok-4.7",
		"factory/kimi-k3",
		"factory/minimax-m3",
		"factory/mistral-large-4",
		"factory/qwen3.8-max",
		"factory/nemotron-3-ultra",
	} {
		require.NotContains(t, defaultModels, stale)
	}

	explicitModels := svc.GetAvailableModels(context.Background(), &groupExplicit, PlatformFactory)
	require.Equal(t, []string{"team-chat"}, explicitModels)
}

func TestFactoryAcceptance_UpstreamHTTP400SecretEchoSanitizedInClientAndOps(t *testing.T) {
	gin.SetMode(gin.TestMode)
	secret := "fk-factory-echo-secret-9101"
	body := []byte(`{"model":"factory/claude-sonnet-4-6","input":"trigger sanitized error","stream":false}`)
	upstreamBody := `{"error":{"type":"invalid_request_error_` + secret + `","code":"` + secret + `","param":"` + secret + `","message":"upstream rejected ` + secret + `"}}`
	upstream := &factoryAcceptanceTransport{responses: []*http.Response{{
		StatusCode: http.StatusBadRequest,
		Header: http.Header{
			"Content-Type": []string{"application/json"},
			"x-request-id": []string{secret},
		},
		Body: io.NopCloser(strings.NewReader(upstreamBody)),
	}}}
	svc := factoryAcceptanceService(upstream)
	svc.cfg.Gateway.LogUpstreamErrorBody = true
	svc.cfg.Gateway.LogUpstreamErrorBodyMaxBytes = 4096
	account := factoryAcceptanceAccount("us", "")
	account.Credentials["api_key"] = secret
	c, rec := factoryAcceptanceContext("/v1/responses", body)

	result, err := svc.Forward(context.Background(), c, account, body)
	require.Error(t, err)
	require.Nil(t, result)
	require.Equal(t, http.StatusBadRequest, rec.Code)
	require.NotContains(t, rec.Body.String(), secret, "client error must not echo the Factory key")
	require.NotContains(t, strings.Join(rec.Header().Values("x-request-id"), ","), secret)

	for _, key := range []string{OpsUpstreamErrorMessageKey, OpsUpstreamErrorDetailKey} {
		if value, ok := c.Get(key); ok {
			text, _ := value.(string)
			require.NotContains(t, text, secret, "ops context field %s must be sanitized", key)
		}
	}

	if value, ok := c.Get(OpsUpstreamErrorsKey); ok {
		events, _ := value.([]*OpsUpstreamErrorEvent)
		require.NotEmpty(t, events)
		raw, marshalErr := json.Marshal(events)
		require.NoError(t, marshalErr)
		require.NotContains(t, string(raw), secret, "ops upstream events must sanitize detail and x-request-id")
	}
}

func factoryAssertNoSecretInSSESurface(t *testing.T, c *gin.Context, rec *httptest.ResponseRecorder, err error, secret string) {
	t.Helper()
	if err != nil {
		require.NotContains(t, err.Error(), secret, "returned stream error must be sanitized")
	}
	require.True(t, rec.Body.Len() > 0 || err != nil, "SSE error should produce a client signal or an error")
	require.NotContains(t, rec.Body.String(), secret, "SSE client frames must not echo the Factory key")
	require.NotContains(t, strings.Join(rec.Header().Values("x-request-id"), ","), secret)
	if streamErr, ok := GetOpsStreamError(c); ok {
		raw, marshalErr := json.Marshal(streamErr)
		require.NoError(t, marshalErr)
		require.NotContains(t, string(raw), secret, "ops stream error must sanitize upstream detail and request id")
	}
	if value, ok := c.Get(OpsUpstreamErrorsKey); ok {
		events, _ := value.([]*OpsUpstreamErrorEvent)
		raw, marshalErr := json.Marshal(events)
		require.NoError(t, marshalErr)
		require.NotContains(t, string(raw), secret, "ops upstream events must sanitize SSE error detail and request id")
	}
}

func TestFactoryAcceptance_UpstreamResponsesSSEErrorSecretSanitized(t *testing.T) {
	gin.SetMode(gin.TestMode)
	secret := "fk-factory-responses-sse-secret-9101"
	body := []byte(`{"model":"factory/claude-sonnet-4-6","input":"trigger header sanitize","stream":true}`)
	stream := factoryAnthropicErrorStream(secret)
	stream.Header.Set("x-request-id", secret)
	upstream := &factoryAcceptanceTransport{responses: []*http.Response{stream}}
	svc := factoryAcceptanceService(upstream)
	svc.cfg.Gateway.LogUpstreamErrorBody = true
	svc.cfg.Gateway.LogUpstreamErrorBodyMaxBytes = 4096
	account := factoryAcceptanceAccount("us", "")
	account.Credentials["api_key"] = secret
	c, rec := factoryAcceptanceContext("/v1/responses", body)

	result, err := svc.Forward(context.Background(), c, account, body)
	require.Len(t, upstream.requests, 1)
	require.Error(t, err)
	require.Contains(t, rec.Body.String(), `"type":"response.failed"`)
	payload := strings.TrimSpace(strings.TrimPrefix(rec.Body.String(), "event: response.failed\ndata: "))
	failed := gjson.Parse(payload)
	require.Equal(t, "failed", failed.Get("response.status").String())
	require.NotEmpty(t, failed.Get("response.id").String())
	require.Positive(t, failed.Get("response.created_at").Int())
	require.True(t, failed.Get("sequence_number").Exists())
	require.Equal(t, "[]", failed.Get("response.output").Raw)
	require.NotContains(t, rec.Body.String(), "response.completed")
	factoryAssertNoSecretInSSESurface(t, c, rec, err, secret)
	if result != nil {
		require.NotContains(t, result.UpstreamResponseModel, secret)
	}
}

func TestFactoryAcceptance_UpstreamAnthropicSSEErrorSecretEchoSanitized(t *testing.T) {
	gin.SetMode(gin.TestMode)
	secret := "fk-factory-anthropic-sse-secret-9101"
	body := []byte(`{"model":"factory/claude-sonnet-4-6","max_tokens":16,"messages":[{"role":"user","content":"stream error"}],"stream":true}`)
	upstream := &factoryAcceptanceTransport{responses: []*http.Response{factoryAnthropicErrorStream(secret)}}
	svc := factoryAcceptanceService(upstream)
	svc.cfg.Gateway.LogUpstreamErrorBody = true
	svc.cfg.Gateway.LogUpstreamErrorBodyMaxBytes = 4096
	account := factoryAcceptanceAccount("us", "")
	account.Credentials["api_key"] = secret
	c, rec := factoryAcceptanceContext("/v1/messages", body)

	_, err := svc.ForwardAsAnthropic(context.Background(), c, account, body, "", "")
	require.Len(t, upstream.requests, 1)
	factoryAssertNoSecretInSSESurface(t, c, rec, err, secret)
}

func TestFactoryAcceptance_UpstreamChatSSEErrorSecretSanitized(t *testing.T) {
	gin.SetMode(gin.TestMode)
	secret := "fk-factory-chat-sse-secret-9101"
	body := []byte(`{"model":"factory/claude-sonnet-4-6","messages":[{"role":"user","content":"stream error"}],"stream":true}`)
	stream := factoryAnthropicErrorStream(secret)
	stream.Header.Set("x-request-id", secret)
	upstream := &factoryAcceptanceTransport{responses: []*http.Response{stream}}
	svc := factoryAcceptanceService(upstream)
	svc.cfg.Gateway.LogUpstreamErrorBody = true
	svc.cfg.Gateway.LogUpstreamErrorBodyMaxBytes = 4096
	account := factoryAcceptanceAccount("us", "")
	account.Credentials["api_key"] = secret
	c, rec := factoryAcceptanceContext("/v1/chat/completions", body)

	result, err := svc.ForwardAsChatCompletions(context.Background(), c, account, body, "", "")
	require.Len(t, upstream.requests, 1)
	require.Error(t, err)
	require.Contains(t, rec.Body.String(), `"error":`)
	require.NotContains(t, rec.Body.String(), "[DONE]")
	factoryAssertNoSecretInSSESurface(t, c, rec, err, secret)
	if result != nil {
		require.NotContains(t, result.UpstreamResponseModel, secret)
	}
}

func TestFactoryAcceptance_ClaudeSSEFailurePreservesPartialUsage(t *testing.T) {
	gin.SetMode(gin.TestMode)
	for _, surface := range []string{"responses", "chat"} {
		t.Run(surface, func(t *testing.T) {
			secret := "fk-partial-stream-secret"
			stream := factoryAnthropicErrorStream(secret)
			prefix := "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_partial\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"claude-sonnet-4-6\",\"content\":[],\"usage\":{\"input_tokens\":11,\"output_tokens\":1}}}\n\nevent: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{},\"usage\":{\"output_tokens\":3}}\n\n"
			stream.Body = io.NopCloser(io.MultiReader(strings.NewReader(prefix), stream.Body))
			upstream := &factoryAcceptanceTransport{responses: []*http.Response{stream}}
			svc := factoryAcceptanceService(upstream)
			account := factoryAcceptanceAccount("us", "")
			account.Credentials["api_key"] = secret
			body := []byte(`{"model":"factory/claude-sonnet-4-6","input":"hi","messages":[{"role":"user","content":"hi"}],"stream":true}`)
			c, rec := factoryAcceptanceContext("/v1/responses", body)
			var result *OpenAIForwardResult
			var err error
			if surface == "responses" {
				result, err = svc.Forward(context.Background(), c, account, body)
			} else {
				result, err = svc.ForwardAsChatCompletions(context.Background(), c, account, body, "", "")
			}
			require.Error(t, err)
			require.NotNil(t, result)
			require.Equal(t, 11, result.Usage.InputTokens)
			require.Equal(t, 3, result.Usage.OutputTokens)
			require.Contains(t, rec.Body.String(), "upstream_error")
			require.NotContains(t, rec.Body.String(), "response.completed")
			require.NotContains(t, rec.Body.String(), "[DONE]")
			if surface == "responses" {
				require.Contains(t, rec.Body.String(), `"type":"response.failed"`)
				require.Contains(t, rec.Body.String(), `"id":"msg_partial"`)
			}
			factoryAssertNoSecretInSSESurface(t, c, rec, err, secret)
		})
	}
}

func factoryLiveFail(t *testing.T, label string, err error, secret string) {
	t.Helper()
	if err == nil {
		return
	}
	message := strings.ReplaceAll(err.Error(), secret, "fk-***")
	t.Fatalf("%s: %s", label, message)
}

func factoryLiveRequireNoSecret(t *testing.T, label, text, secret string) {
	t.Helper()
	if strings.Contains(text, secret) {
		t.Fatalf("%s contains the live Factory key", label)
	}
}

// TestFactoryLiveSmoke is skipped unless FACTORY_LIVE_KEY_FILE points to a
// mode-0600 file containing an authorized fk- key. It runs two auth-only whoami
// probes (without and with the explicit org) and exactly one small Claude
// Messages inference through the Fork gateway adapter. It uses only in-memory
// state and a real net/http transport: no database, listener, container,
// migration, or environment mutation. By default no credential is present, so
// the test skips and no paid call is made.
func TestFactoryLiveSmoke(t *testing.T) {
	keyPath := strings.TrimSpace(os.Getenv("FACTORY_LIVE_KEY_FILE"))
	if keyPath == "" {
		t.Skip("set FACTORY_LIVE_KEY_FILE to a mode-0600 fk- key file to run the authorized live smoke")
	}
	info, err := os.Stat(keyPath)
	if err != nil {
		t.Fatalf("live key file is unavailable")
	}
	if info.Mode().Perm() != 0600 {
		t.Fatalf("live key file must be mode 0600, got %04o", info.Mode().Perm())
	}
	if info.Size() <= 0 || info.Size() > 8192 {
		t.Fatal("live key file size is invalid")
	}
	raw, err := os.ReadFile(keyPath)
	if err != nil {
		t.Fatal("live key file is unreadable")
	}
	secret := strings.TrimSpace(string(raw))
	for i := range raw {
		raw[i] = 0
	}
	if !strings.HasPrefix(secret, "fk-") || len(secret) <= len("fk-") {
		t.Fatal("live key file does not contain a Factory fk- key")
	}
	region := strings.ToLower(strings.TrimSpace(os.Getenv("FACTORY_LIVE_REGION")))
	if region == "" {
		region = "us"
	}
	if region != "us" && region != "eu" {
		t.Fatal("FACTORY_LIVE_REGION must be us or eu")
	}
	orgID := strings.TrimSpace(os.Getenv("FACTORY_LIVE_ORG_ID"))
	if orgID == "" {
		t.Fatal("FACTORY_LIVE_ORG_ID is required for the with-org whoami probe")
	}
	const model = "factory/claude-sonnet-4-6"
	newAccount := func(withOrg bool) *Account {
		credentials := map[string]any{"api_key": secret, "region": region}
		if withOrg {
			credentials["factory_org_id"] = orgID
		}
		return &Account{
			ID:          99001,
			Name:        "factory-live-smoke",
			Platform:    PlatformFactory,
			Type:        AccountTypeAPIKey,
			Concurrency: 1,
			Status:      StatusActive,
			Schedulable: true,
			Credentials: credentials,
		}
	}
	noOrgAccount := newAccount(false)
	orgAccount := newAccount(true)
	protocol, ok := noOrgAccount.FactoryProtocolForModel(model)
	if !ok || protocol != APIProtocolAnthropic {
		t.Fatal("live smoke model must resolve to the Factory Anthropic Messages protocol")
	}
	cfg := factoryAcceptanceService(nil).cfg
	transport := newFactoryLiveHTTPUpstream()

	probeService := &AccountTestService{cfg: cfg, httpUpstream: transport}
	noOrgCtx, noOrgRec := factoryAcceptanceContext("/factory-live/whoami/no-org", nil)
	factoryLiveFail(t, "Factory whoami auth probe without org", probeService.testFactoryAccountConnection(noOrgCtx, noOrgAccount), secret)
	whoamiCalls, inferenceCalls := transport.counts()
	if whoamiCalls != 1 || inferenceCalls != 0 {
		t.Fatalf("no-org whoami call counts are wrong: whoami=%d inference=%d", whoamiCalls, inferenceCalls)
	}
	noOrgBody := noOrgRec.Body.String()
	factoryLiveRequireNoSecret(t, "no-org whoami client response", noOrgBody, secret)
	if !strings.Contains(noOrgBody, `"auth_only":true`) || !strings.Contains(noOrgBody, `"inference_tested":false`) {
		t.Fatal("no-org whoami probe did not report auth-only semantics")
	}

	orgCtx, orgRec := factoryAcceptanceContext("/factory-live/whoami/with-org", nil)
	factoryLiveFail(t, "Factory whoami auth probe with org", probeService.testFactoryAccountConnection(orgCtx, orgAccount), secret)
	whoamiCalls, inferenceCalls = transport.counts()
	if whoamiCalls != 2 || inferenceCalls != 0 {
		t.Fatalf("with-org whoami call counts are wrong: whoami=%d inference=%d", whoamiCalls, inferenceCalls)
	}
	orgBody := orgRec.Body.String()
	factoryLiveRequireNoSecret(t, "with-org whoami client response", orgBody, secret)
	if !strings.Contains(orgBody, `"auth_only":true`) || !strings.Contains(orgBody, `"inference_tested":false`) {
		t.Fatal("with-org whoami probe did not report auth-only semantics")
	}

	request := []byte(`{"model":"factory/claude-sonnet-4-6","messages":[{"role":"user","content":"Reply with exactly OK"}],"max_tokens":32,"stream":false}`)
	inferenceCtx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	c, rec := factoryAcceptanceContext("/v1/messages", request)
	svc := &OpenAIGatewayService{cfg: cfg, httpUpstream: transport}
	// This is intentionally a single call. A failure is reported, not retried
	// with another request or model.
	result, err := svc.ForwardAsAnthropic(inferenceCtx, c, noOrgAccount, request, "", "")
	factoryLiveFail(t, "Factory live Claude inference", err, secret)
	if result == nil {
		t.Fatal("Factory live inference returned no result")
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("Factory live inference returned HTTP %d", rec.Code)
	}
	if rec.Body.Len() == 0 {
		t.Fatal("Factory live inference returned an empty client response")
	}
	factoryLiveRequireNoSecret(t, "inference client response", rec.Body.String(), secret)
	for _, value := range rec.Header().Values("x-request-id") {
		factoryLiveRequireNoSecret(t, "inference x-request-id header", value, secret)
	}
	whoamiCalls, inferenceCalls = transport.counts()
	if whoamiCalls != 2 || inferenceCalls != 1 {
		t.Fatalf("live smoke must make exactly two whoami and one inference call, got whoami=%d inference=%d", whoamiCalls, inferenceCalls)
	}
	t.Logf("Factory live smoke passed: auth-only whoami without/with org; exactly one Claude inference; status=%d input_tokens=%d output_tokens=%d", rec.Code, result.Usage.InputTokens, result.Usage.OutputTokens)
}
