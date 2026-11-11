package service

import (
	"fmt"
	"net/http"
	"strings"

	factorypkg "github.com/Wei-Shaw/sub2api/internal/pkg/factory"
	"github.com/gin-gonic/gin"
	"github.com/tidwall/gjson"
)

const APIProtocolUnsupported = "unsupported"

func DefaultFactoryModelIDs() []string { return factorypkg.PublicModelIDs() }

func (a *Account) FactoryNativeModel(requested string) (string, bool) {
	if a == nil || !a.IsFactory() {
		return "", false
	}
	return factorypkg.NativeModelID(requested)
}

func (a *Account) FactoryProtocolForModel(requested string) (string, bool) {
	if a == nil || !a.IsFactory() {
		return "", false
	}
	model, ok := factorypkg.ResolveModel(strings.TrimSpace(requested))
	if !ok {
		return "", false
	}
	return string(model.Protocol), true
}

func (a *Account) FactoryRegion() string {
	if a == nil {
		return factorypkg.RegionUS
	}
	return strings.ToLower(strings.TrimSpace(a.GetCredential("region")))
}

func (a *Account) FactoryOrgID() string {
	if a == nil {
		return ""
	}
	return strings.TrimSpace(a.GetCredential("factory_org_id"))
}

func (a *Account) factoryHasExplicitModelMapping() bool {
	if a == nil || a.Credentials == nil {
		return false
	}
	return len(stringMappingFromRaw(a.Credentials["model_mapping"])) > 0
}

func (a *Account) factoryMappingAdmitsNative(native string) bool {
	if a == nil || a.Credentials == nil {
		return false
	}
	for _, target := range stringMappingFromRaw(a.Credentials["model_mapping"]) {
		if resolved, ok := factorypkg.NativeModelID(target); ok && resolved == native {
			return true
		}
	}
	return false
}

func writeFactoryUnsupportedModelError(c *gin.Context, surface string) error {
	message := "model is not supported by Factory"
	switch surface {
	case "anthropic":
		writeAnthropicError(c, http.StatusBadRequest, "invalid_request_error", message)
	case "responses":
		writeResponsesError(c, http.StatusBadRequest, "invalid_request_error", message)
	default:
		writeChatCompletionsError(c, http.StatusBadRequest, "invalid_request_error", message)
	}
	return fmt.Errorf("factory unsupported model")
}

func rejectFactoryOriginalFastIntent(c *gin.Context, body []byte, surface string) error {
	fast := strings.EqualFold(strings.TrimSpace(gjson.GetBytes(body, "speed").String()), "fast")
	if strings.EqualFold(strings.TrimSpace(gjson.GetBytes(body, "service_tier").String()), "priority") {
		fast = true
	}
	if model := strings.TrimSpace(gjson.GetBytes(body, "model").String()); factorypkg.IsFastOrGeminiID(model) {
		fast = true
	}
	if c != nil && c.Request != nil {
		for key, values := range c.Request.Header {
			if !strings.EqualFold(key, "anthropic-beta") {
				continue
			}
			for _, value := range values {
				if strings.Contains(strings.ToLower(value), "fast-mode") {
					fast = true
				}
			}
		}
	}
	if !fast {
		return nil
	}
	message := "Factory Fast Mode is not supported"
	switch surface {
	case "anthropic":
		writeAnthropicError(c, http.StatusBadRequest, "invalid_request_error", message)
	case "responses":
		writeResponsesError(c, http.StatusBadRequest, "invalid_request_error", message)
	default:
		writeChatCompletionsError(c, http.StatusBadRequest, "invalid_request_error", message)
	}
	return fmt.Errorf("factory fast mode is not supported")
}
