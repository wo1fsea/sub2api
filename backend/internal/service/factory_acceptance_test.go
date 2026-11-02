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

func factoryResponsesJSON() *http.Response {
	return &http.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Content-Type": []string{"application/json"}, "x-request-id": []string{"rid_factory_acceptance"}},
		Body: io.NopCloser(strings.NewReader(`{
"id":"resp_factory_1","object":"response","created_at":1,"status":"completed","model":"gpt-5.5",
"output":[
{"id":"msg_factory_1","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":"found Ω","annotations":[]}]},
{"id":"fc_factory_1","type":"function_call","status":"completed","call_id":"call_factory_1","name":"lookup","arguments":"{\"q\":\"Ω\"}"}
],
"usage":{"input_tokens":19,"input_tokens_details":{"cached_tokens":4},"output_tokens":8,"output_tokens_details":{"reasoning_tokens":2},"total_tokens":27}
}`)),
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

func factoryChatJSON() *http.Response {
	return &http.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Content-Type": []string{"application/json"}, "x-request-id": []string{"rid_factory_chat"}},
		Body: io.NopCloser(strings.NewReader(`{
"id":"chatcmpl_factory_1","object":"chat.completion","created":1,"model":"glm-5.3",
"choices":[{"index":0,"message":{"role":"assistant","content":"found Ω","tool_calls":[{"id":"call_factory_chat_1","type":"function","function":{"name":"lookup","arguments":"{\"q\":\"Ω\"}"}}]},"finish_reason":"tool_calls"}],
"usage":{"prompt_tokens":17,"completion_tokens":6,"total_tokens":23,"prompt_tokens_details":{"cached_tokens":3}}
}`)),
	}
}

func factoryResponsesStream() *http.Response {
	sse := strings.Join([]string{
		`event: response.output_text.delta`,
		`data: {"type":"response.output_text.delta","sequence_number":0,"delta":"stream Ω"}`,
		"",
		`event: response.completed`,
		`data: {"type":"response.completed","sequence_number":1,"response":{"id":"resp_factory_stream","object":"response","model":"gpt-5.5","status":"completed","usage":{"input_tokens":5,"output_tokens":3,"input_tokens_details":{"cached_tokens":2},"total_tokens":8}}}`,
		"",
		"",
	}, "\n")
	return &http.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Content-Type": []string{"text/event-stream"}, "x-request-id": []string{"rid_factory_stream"}},
		Body:       io.NopCloser(strings.NewReader(sse)),
	}
}

func factoryResponsesToolStream() *http.Response {
	sse := strings.Join([]string{
		`event: response.output_item.added`,
		`data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"fc_factory_1","call_id":"call_factory_1","name":"lookup","arguments":"","status":"in_progress"}}`,
		"",
		`event: response.function_call_arguments.delta`,
		`data: {"type":"response.function_call_arguments.delta","item_id":"fc_factory_1","output_index":0,"delta":"{\"q\":\"Ω\"}"}`,
		"",
		`event: response.output_item.done`,
		`data: {"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","id":"fc_factory_1","call_id":"call_factory_1","name":"lookup","arguments":"{\"q\":\"Ω\"}","status":"completed"}}`,
		"",
		`event: response.output_text.delta`,
		`data: {"type":"response.output_text.delta","output_index":1,"delta":"found Ω"}`,
		"",
		`event: response.completed`,
		`data: {"type":"response.completed","response":{"id":"resp_factory_cross","object":"response","model":"gpt-5.5","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"found Ω"}]},{"type":"function_call","id":"fc_factory_1","call_id":"call_factory_1","name":"lookup","arguments":"{\"q\":\"Ω\"}"}],"usage":{"input_tokens":19,"output_tokens":8,"input_tokens_details":{"cached_tokens":4},"total_tokens":27}}}`,
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

func factoryResponsesErrorStream(secret string) *http.Response {
	sse := strings.Join([]string{
		`event: response.created`,
		`data: {"type":"response.created","response":{"id":"resp_factory_error_stream","object":"response","model":"gpt-5.5","status":"in_progress"}}`,
		"",
		`event: response.failed`,
		`data: {"type":"response.failed","response":{"id":"resp_factory_error_stream","object":"response","model":"gpt-5.5","status":"failed","error":{"type":"server_error","code":"server_error","message":"upstream failed with ` + secret + `"}}}`,
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

func factoryChatErrorStream(secret string) *http.Response {
	sse := strings.Join([]string{
		`data: {"id":"chatcmpl_factory_error","object":"chat.completion.chunk","model":"glm-5.3","choices":[],"error":{"type":"server_error","message":"upstream failed with ` + secret + `"}}`,
		"",
		`data: [DONE]`,
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

func TestFactoryAcceptance_ForwardResponsesSameProtocolPreservesToolsAndUsage(t *testing.T) {
	gin.SetMode(gin.TestMode)
	body := []byte(`{
"model":"factory/gpt-5.5",
"instructions":"PRESERVE_ME_SYSTEM_Ω",
"input":[{"role":"user","content":[{"type":"input_text","text":"PRESERVE_ME_INPUT_λ"}]}],
"tools":[{"type":"function","name":"lookup","description":"PRESERVE_ME_TOOL","parameters":{"type":"object","properties":{"q":{"type":"string"}},"required":["q"]}}],
"stream":false
}`)
	upstream := &factoryAcceptanceTransport{responses: []*http.Response{factoryResponsesJSON()}}
	svc := factoryAcceptanceService(upstream)
	c, rec := factoryAcceptanceContext("/v1/responses", body)

	result, err := svc.Forward(context.Background(), c, factoryAcceptanceAccount("us", ""), body)
	require.NoError(t, err)
	require.NotNil(t, result)
	require.Len(t, upstream.requests, 1)

	req := upstream.requests[0]
	require.Equal(t, http.MethodPost, req.Method)
	require.Equal(t, "https://api.factory.ai/api/llm/o/v1/responses", req.URL.String())
	require.Equal(t, "Bearer fk-factory-acceptance-9101", req.Header.Get("Authorization"))
	require.Equal(t, "cli", req.Header.Get("X-Factory-Client"))
	require.Equal(t, "org-bHuLtG1fGmYk5YaOihAAXFBw", req.Header.Get("OpenAI-Platform"))
	require.Equal(t, "openai", req.Header.Get("x-api-provider"))
	require.Equal(t, "registry_default", req.Header.Get("x-provider-routing-source"))
	require.NotEmpty(t, req.Header.Get("x-session-id"))
	require.NotEmpty(t, req.Header.Get("x-assistant-message-id"))
	require.Empty(t, req.Header.Get("X-Factory-Org-Id"))
	require.Equal(t, "gpt-5.5", gjson.GetBytes(upstream.bodies[0], "model").String())
	sent := string(upstream.bodies[0])
	require.Contains(t, sent, "You are Droid, an AI software engineering agent built by Factory.")
	require.Contains(t, sent, "PRESERVE_ME_SYSTEM_Ω")
	require.Contains(t, sent, "PRESERVE_ME_INPUT_λ")
	require.Contains(t, sent, "PRESERVE_ME_TOOL")
	require.NotContains(t, sent, "caller-must-not-leak")

	require.Equal(t, 19, result.Usage.InputTokens)
	require.Equal(t, 8, result.Usage.OutputTokens)
	require.Equal(t, 4, result.Usage.CacheReadInputTokens)
	require.Contains(t, rec.Body.String(), "call_factory_1")
	require.Contains(t, rec.Body.String(), "found Ω")
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

func TestFactoryAcceptance_ForwardAsChatCompletionsNativePreservesToolsAndUsage(t *testing.T) {
	gin.SetMode(gin.TestMode)
	body := []byte(`{
"model":"factory/glm-5.3",
"messages":[{"role":"system","content":"PRESERVE_CHAT_SYSTEM_Ω"},{"role":"user","content":"PRESERVE_CHAT_INPUT_λ"}],
"tools":[{"type":"function","function":{"name":"lookup","description":"PRESERVE_CHAT_TOOL","parameters":{"type":"object","properties":{"q":{"type":"string"}},"required":["q"]}}}],
"stream":false
}`)
	upstream := &factoryAcceptanceTransport{responses: []*http.Response{factoryChatJSON()}}
	svc := factoryAcceptanceService(upstream)
	c, rec := factoryAcceptanceContext("/v1/chat/completions", body)

	result, err := svc.ForwardAsChatCompletions(context.Background(), c, factoryAcceptanceAccount("us", ""), body, "", "")
	require.NoError(t, err)
	require.NotNil(t, result)
	require.Len(t, upstream.requests, 1)

	req := upstream.requests[0]
	require.Equal(t, "https://api.factory.ai/api/llm/o/v1/chat/completions", req.URL.String())
	require.Equal(t, "Bearer fk-factory-acceptance-9101", req.Header.Get("Authorization"))
	require.Equal(t, "glm-5.3", gjson.GetBytes(upstream.bodies[0], "model").String())
	sent := string(upstream.bodies[0])
	require.Contains(t, sent, "You are Droid, an AI software engineering agent built by Factory.")
	require.Contains(t, sent, "PRESERVE_CHAT_SYSTEM_Ω")
	require.Contains(t, sent, "PRESERVE_CHAT_INPUT_λ")
	require.Contains(t, sent, "PRESERVE_CHAT_TOOL")
	require.NotContains(t, sent, "caller-must-not-leak")

	require.Equal(t, 17, result.Usage.InputTokens)
	require.Equal(t, 6, result.Usage.OutputTokens)
	require.Equal(t, 3, result.Usage.CacheReadInputTokens)
	require.Contains(t, rec.Body.String(), "call_factory_chat_1")
	require.Contains(t, rec.Body.String(), "found Ω")
}

func TestFactoryAcceptance_ForwardAsAnthropicCrossProtocolUsesRegistryResponsesRoute(t *testing.T) {
	gin.SetMode(gin.TestMode)
	body := []byte(`{
"model":"factory/gpt-5.5",
"max_tokens":128,
"system":"PRESERVE_CROSS_SYSTEM_Ω",
"tools":[{"name":"lookup","description":"PRESERVE_CROSS_TOOL","input_schema":{"type":"object","properties":{"q":{"type":"string"}},"required":["q"]}}],
"messages":[{"role":"user","content":[{"type":"text","text":"PRESERVE_CROSS_INPUT_λ"}]}],
"stream":false
}`)
	upstream := &factoryAcceptanceTransport{responses: []*http.Response{factoryResponsesToolStream()}}
	svc := factoryAcceptanceService(upstream)
	c, rec := factoryAcceptanceContext("/v1/messages", body)

	result, err := svc.ForwardAsAnthropic(context.Background(), c, factoryAcceptanceAccount("us", ""), body, "", "")
	require.NoError(t, err)
	require.NotNil(t, result)
	require.Len(t, upstream.requests, 1)

	req := upstream.requests[0]
	require.Equal(t, "https://api.factory.ai/api/llm/o/v1/responses", req.URL.String())
	require.Equal(t, "Bearer fk-factory-acceptance-9101", req.Header.Get("Authorization"))
	require.Equal(t, "gpt-5.5", gjson.GetBytes(upstream.bodies[0], "model").String())
	sent := string(upstream.bodies[0])
	require.Contains(t, sent, "PRESERVE_CROSS_SYSTEM_Ω")
	require.Contains(t, sent, "PRESERVE_CROSS_INPUT_λ")
	require.Contains(t, sent, "PRESERVE_CROSS_TOOL")
	require.Contains(t, sent, "You are Droid, an AI software engineering agent built by Factory.")

	require.Equal(t, 19, result.Usage.InputTokens)
	require.Equal(t, 8, result.Usage.OutputTokens)
	require.Equal(t, 4, result.Usage.CacheReadInputTokens)
	responseBody := rec.Body.String()
	require.Contains(t, responseBody, "call_factory_1")
	require.Contains(t, responseBody, "found Ω")
}

func TestFactoryAcceptance_ForwardResponsesStreamingPreservesDeltaAndUsage(t *testing.T) {
	gin.SetMode(gin.TestMode)
	body := []byte(`{"model":"factory/gpt-5.5","input":"stream please","stream":true}`)
	upstream := &factoryAcceptanceTransport{responses: []*http.Response{factoryResponsesStream()}}
	svc := factoryAcceptanceService(upstream)
	c, rec := factoryAcceptanceContext("/v1/responses", body)

	result, err := svc.Forward(context.Background(), c, factoryAcceptanceAccount("us", ""), body)
	require.NoError(t, err)
	require.NotNil(t, result)
	require.True(t, result.Stream)
	require.Equal(t, 5, result.Usage.InputTokens)
	require.Equal(t, 3, result.Usage.OutputTokens)
	require.Equal(t, 2, result.Usage.CacheReadInputTokens)
	require.Len(t, upstream.requests, 1)
	require.Equal(t, "https://api.factory.ai/api/llm/o/v1/responses", upstream.requests[0].URL.String())
	responseBody := rec.Body.String()
	require.Contains(t, responseBody, "response.output_text.delta")
	require.Contains(t, responseBody, "stream Ω")
	require.Contains(t, responseBody, "response.completed")
}

func TestFactoryAcceptance_ForwardAsChatCompletionsCrossProtocolUsesRegistryResponsesRoute(t *testing.T) {
	gin.SetMode(gin.TestMode)
	body := []byte(`{
"model":"factory/gpt-5.5",
"messages":[{"role":"system","content":"PRESERVE_CHAT_CROSS_SYSTEM_Ω"},{"role":"user","content":"PRESERVE_CHAT_CROSS_INPUT_λ"}],
"tools":[{"type":"function","function":{"name":"lookup","description":"PRESERVE_CHAT_CROSS_TOOL","parameters":{"type":"object","properties":{"q":{"type":"string"}},"required":["q"]}}}],
"stream":false
}`)
	upstream := &factoryAcceptanceTransport{responses: []*http.Response{factoryResponsesToolStream()}}
	svc := factoryAcceptanceService(upstream)
	c, rec := factoryAcceptanceContext("/v1/chat/completions", body)

	result, err := svc.ForwardAsChatCompletions(context.Background(), c, factoryAcceptanceAccount("us", ""), body, "", "")
	require.NoError(t, err)
	require.NotNil(t, result)
	require.Len(t, upstream.requests, 1)
	require.Equal(t, "https://api.factory.ai/api/llm/o/v1/responses", upstream.requests[0].URL.String())
	require.Equal(t, "gpt-5.5", gjson.GetBytes(upstream.bodies[0], "model").String())
	sent := string(upstream.bodies[0])
	require.Contains(t, sent, "PRESERVE_CHAT_CROSS_SYSTEM_Ω")
	require.Contains(t, sent, "PRESERVE_CHAT_CROSS_INPUT_λ")
	require.Contains(t, sent, "PRESERVE_CHAT_CROSS_TOOL")
	require.Contains(t, sent, "You are Droid, an AI software engineering agent built by Factory.")
	require.Equal(t, 19, result.Usage.InputTokens)
	require.Equal(t, 8, result.Usage.OutputTokens)
	require.Equal(t, 4, result.Usage.CacheReadInputTokens)
	responseBody := rec.Body.String()
	require.Contains(t, responseBody, "call_factory_1")
	require.Contains(t, responseBody, "found Ω")
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
	body := []byte(`{"model":"factory/gpt-5.5","input":"credential check","stream":false}`)
	upstream := &factoryAcceptanceTransport{responses: []*http.Response{factoryResponsesJSON()}}
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
	require.Equal(t, "https://api.eu.factory.ai/api/llm/o/v1/responses", req.URL.String())
	require.Equal(t, "Bearer fk-factory-acceptance-9101", req.Header.Get("Authorization"))
	require.Equal(t, "fac_org_acceptance", req.Header.Get("X-Factory-Org-Id"))
	require.Equal(t, "cli", req.Header.Get("X-Factory-Client"))
	require.Empty(t, req.Header.Get("X-Api-Key"))
	require.Empty(t, req.Header.Get("Cookie"))
	require.NotContains(t, string(upstream.bodies[0]), "caller-must-not-leak")
}

func TestFactoryAcceptance_RejectsUnsupportedModelsAndFastIntentWithoutUpstreamCall(t *testing.T) {
	gin.SetMode(gin.TestMode)
	cases := []struct {
		name  string
		model string
		extra string
		path  string
	}{
		{name: "gemini", model: "factory/gemini-3.1-pro-preview"},
		{name: "fast id", model: "factory/gpt-5.5-fast"},
		{name: "auto", model: "factory/auto"},
		{name: "unknown", model: "factory/not-a-real-model"},
		{name: "responses fast intent", model: "factory/gpt-5.5", extra: `,"service_tier":"priority"`},
		{name: "unsupported compact path", model: "factory/gpt-5.5", path: "/v1/responses/compact"},
	}
	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			body := []byte(`{"model":"` + tt.model + `","input":"must not leave` + tt.extra + `,"stream":false}`)
			upstream := &factoryAcceptanceTransport{}
			svc := factoryAcceptanceService(upstream)
			path := tt.path
			if path == "" {
				path = "/v1/responses"
			}
			c, rec := factoryAcceptanceContext(path, body)

			result, err := svc.Forward(context.Background(), c, factoryAcceptanceAccount("us", ""), body)
			require.Error(t, err)
			require.Nil(t, result)
			require.Empty(t, upstream.requests, "unsupported Factory model/intent must not reach the transport")
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

func TestFactoryAcceptance_RejectsAnthropicCrossProtocolFastIntentWithoutUpstreamCall(t *testing.T) {
	gin.SetMode(gin.TestMode)
	body := []byte(`{"model":"factory/gpt-5.5","max_tokens":32,"speed":"fast","messages":[{"role":"user","content":"fast across protocols"}],"stream":false}`)
	upstream := &factoryAcceptanceTransport{}
	svc := factoryAcceptanceService(upstream)
	c, _ := factoryAcceptanceContext("/v1/messages", body)

	result, err := svc.ForwardAsAnthropic(context.Background(), c, factoryAcceptanceAccount("us", ""), body, "", "")
	require.Error(t, err)
	require.Nil(t, result)
	require.Empty(t, upstream.requests, "Messages Fast intent must be rejected before a Responses conversion can drop it")
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
	body := []byte(`{"model":"factory/gpt-5.5","input":"must not leave","stream":false}`)
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
	body := []byte(`{"model":"factory/gpt-5.5","input":"hostile state check","stream":false}`)
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
			upstream := &factoryAcceptanceTransport{responses: []*http.Response{factoryResponsesJSON()}}
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
			require.Equal(t, "https://api.factory.ai/api/llm/o/v1/responses", req.URL.String())
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
			PublicModel:    "factory/deepseek-v4.1-flash",
			MatchType:      CompositeRouteMatchExact,
			TargetPlatform: PlatformFactory,
			UpstreamModel:  "deepseek-v4.1-flash",
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
			UpstreamModel:  "factory/deepseek-v4.1-flash",
			Endpoint:       CompositeRouteEndpointChatCompletions,
			Priority:       100,
			Enabled:        true,
		},
	}}
	resolver := NewCompositeRouteResolver(repo)

	canonical, err := resolver.Resolve(context.Background(), 7, "factory/deepseek-v4.1-flash", CompositeRouteEndpointChatCompletions)
	require.NoError(t, err)
	require.True(t, canonical.Matched)
	require.Equal(t, CompositeRouteSourceExplicit, canonical.Source)
	require.Equal(t, PlatformFactory, canonical.TargetPlatform)
	require.Equal(t, "deepseek-v4.1-flash", canonical.UpstreamModel)

	alias, err := resolver.Resolve(context.Background(), 7, "team-chat", CompositeRouteEndpointChatCompletions)
	require.NoError(t, err)
	require.True(t, alias.Matched)
	require.Equal(t, PlatformFactory, alias.TargetPlatform)
	require.Equal(t, "factory/deepseek-v4.1-flash", alias.UpstreamModel)

	account := factoryAcceptanceAccount("us", "")
	native, matched := account.ResolveMappedModel(alias.UpstreamModel)
	require.True(t, matched)
	require.Equal(t, "deepseek-v4.1-flash", native, "pricing must receive the actual native model")

	platform, ok := DetectModelPlatform("factory/deepseek-v4.1-flash")
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

	c, rec := factoryAcceptanceContext("/v1/responses/input_tokens", []byte(`{"model":"factory/gpt-5.5","input":"count me"}`))
	err := svc.ForwardResponsesInputTokens(context.Background(), c, account, []byte(`{"model":"factory/gpt-5.5","input":"count me"}`))
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
				"team-chat": "factory/gpt-5.5",
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
		context.Background(), &groupNative, "", "", "factory/gpt-5.5", nil,
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
		TargetPlatform: PlatformFactory, UpstreamModel: "factory/gpt-5.5", Endpoint: CompositeRouteEndpointChatCompletions,
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
				"team-chat": "factory/gpt-5.5",
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
	upstream := &factoryAcceptanceTransport{responses: []*http.Response{factoryResponsesToolStream()}}
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
		TargetPlatform: PlatformFactory, UpstreamModel: "factory/gpt-5.5", Endpoint: CompositeRouteEndpointChatCompletions,
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
	require.Equal(t, "gpt-5.5", gjson.GetBytes(upstream.bodies[0], "model").String())
	require.Equal(t, "gpt-5.5", result.UpstreamModel)

	expected := expectedOpenAICost(t, svc, "gpt-5.5", result.Usage, 1.1)
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
	require.Equal(t, "gpt-5.5", *usageRepo.lastLog.UpstreamModel)
	require.InDelta(t, expected.TotalCost, usageRepo.lastLog.TotalCost, 1e-12)
	require.InDelta(t, expected.ActualCost, usageRepo.lastLog.ActualCost, 1e-12)
	require.InDelta(t, expected.ActualCost, userRepo.lastAmount, 1e-12)
}

func TestFactoryAcceptance_GetAvailableModelsReachesFactoryDefaultAndExplicitMappings(t *testing.T) {
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
				"team-chat": "factory/gpt-5.5",
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
	require.Contains(t, defaultModels, "factory/gpt-5.5")
	require.Contains(t, defaultModels, "factory/deepseek-v4.1-flash")
	for _, model := range defaultModels {
		require.True(t, strings.HasPrefix(model, "factory/"), "unexpected model in Factory list: %s", model)
		require.NotContains(t, strings.ToLower(model), "gemini")
		require.NotContains(t, strings.ToLower(model), "-fast")
		require.NotContains(t, strings.ToLower(model), "/auto")
		require.NotContains(t, strings.ToLower(model), "not-a-real-model")
	}

	explicitModels := svc.GetAvailableModels(context.Background(), &groupExplicit, PlatformFactory)
	require.Equal(t, []string{"team-chat"}, explicitModels)
}

func TestFactoryAcceptance_UpstreamHTTP400SecretEchoSanitizedInClientAndOps(t *testing.T) {
	gin.SetMode(gin.TestMode)
	secret := "fk-factory-echo-secret-9101"
	body := []byte(`{"model":"factory/gpt-5.5","input":"trigger sanitized error","stream":false}`)
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

func TestFactoryAcceptance_UpstreamSSEErrorSecretEchoSanitized(t *testing.T) {
	gin.SetMode(gin.TestMode)
	secret := "fk-factory-sse-secret-9101"
	body := []byte(`{"model":"factory/gpt-5.5","input":"trigger stream error","stream":true}`)
	upstream := &factoryAcceptanceTransport{responses: []*http.Response{factoryResponsesErrorStream(secret)}}
	svc := factoryAcceptanceService(upstream)
	svc.cfg.Gateway.LogUpstreamErrorBody = true
	svc.cfg.Gateway.LogUpstreamErrorBodyMaxBytes = 4096
	account := factoryAcceptanceAccount("us", "")
	account.Credentials["api_key"] = secret
	c, rec := factoryAcceptanceContext("/v1/responses", body)

	result, err := svc.Forward(context.Background(), c, account, body)
	require.Len(t, upstream.requests, 1)
	if err != nil {
		require.NotContains(t, err.Error(), secret, "returned stream error must be sanitized")
	}
	require.True(t, rec.Body.Len() > 0 || err != nil, "the SSE error case should produce a client signal or error")
	require.NotContains(t, rec.Body.String(), secret, "SSE client frames must not echo the Factory key")
	require.NotContains(t, strings.Join(rec.Header().Values("x-request-id"), ","), secret)
	if result != nil {
		require.NotContains(t, result.UpstreamResponseModel, secret)
	}
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

func TestFactoryAcceptance_UpstreamChatSSEErrorSecretEchoSanitized(t *testing.T) {
	gin.SetMode(gin.TestMode)
	secret := "fk-factory-chat-sse-secret-9101"
	body := []byte(`{"model":"factory/glm-5.3","messages":[{"role":"user","content":"stream error"}],"stream":true}`)
	upstream := &factoryAcceptanceTransport{responses: []*http.Response{factoryChatErrorStream(secret)}}
	svc := factoryAcceptanceService(upstream)
	svc.cfg.Gateway.LogUpstreamErrorBody = true
	svc.cfg.Gateway.LogUpstreamErrorBodyMaxBytes = 4096
	account := factoryAcceptanceAccount("us", "")
	account.Credentials["api_key"] = secret
	c, rec := factoryAcceptanceContext("/v1/chat/completions", body)

	_, err := svc.ForwardAsChatCompletions(context.Background(), c, account, body, "", "")
	require.Len(t, upstream.requests, 1)
	factoryAssertNoSecretInSSESurface(t, c, rec, err, secret)
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
// probes (without and with the explicit org) and exactly one small Chat
// inference through the Fork gateway adapter. It uses only in-memory state and
// a real net/http transport: no database, listener, container, migration, or
// environment mutation.
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
	const model = "factory/deepseek-v4.1-flash"
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
	if !ok || protocol != APIProtocolChatCompletions {
		t.Fatal("live smoke model must resolve to the Factory Chat Completions protocol")
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

	path := "/v1/chat/completions"
	request := []byte(`{"model":"factory/deepseek-v4.1-flash","messages":[{"role":"user","content":"Reply with exactly OK"}],"max_tokens":32,"reasoning_effort":"none","stream":false}`)
	inferenceCtx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	c, rec := factoryAcceptanceContext(path, request)
	svc := &OpenAIGatewayService{cfg: cfg, httpUpstream: transport}
	// This is intentionally a single call. A failure is reported, not retried
	// with another request or model.
	result, err := svc.ForwardAsChatCompletions(inferenceCtx, c, noOrgAccount, request, "", "")
	factoryLiveFail(t, "Factory live Chat inference", err, secret)
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
	t.Logf("Factory live smoke passed: auth-only whoami without/with org; exactly one Chat inference; status=%d input_tokens=%d output_tokens=%d", rec.Code, result.Usage.InputTokens, result.Usage.OutputTokens)
}
