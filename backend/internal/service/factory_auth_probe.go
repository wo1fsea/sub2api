package service

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	factorypkg "github.com/Wei-Shaw/sub2api/internal/pkg/factory"
	"github.com/gin-gonic/gin"
)

const factoryWhoamiTimeout = 10 * time.Second

func (s *AccountTestService) testFactoryAccountConnection(c *gin.Context, account *Account) error {
	if account == nil {
		return s.sendErrorAndEnd(c, "Factory account is required")
	}
	credentials, err := factorypkg.ParseCredentials(account.Credentials, true)
	if err != nil {
		return s.sendErrorAndEnd(c, "Invalid Factory API-key credentials")
	}
	if s.httpUpstream == nil {
		return s.sendErrorAndEnd(c, "Factory whoami transport is unavailable")
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), factoryWhoamiTimeout)
	defer cancel()
	req, err := factorypkg.NewWhoamiRequest(ctx, credentials)
	if err != nil {
		return s.sendErrorAndEnd(c, "Invalid Factory authentication probe")
	}
	req = req.WithContext(WithHTTPUpstreamRedirectsDisabled(req.Context()))
	proxyURL := ""
	if account.ProxyID != nil && account.Proxy != nil {
		proxyURL = account.Proxy.URL()
	}
	resp, err := s.httpUpstream.Do(req, proxyURL, account.ID, account.Concurrency)
	if err != nil {
		return s.sendErrorAndEnd(c, "Factory whoami request failed")
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return s.sendErrorAndEnd(c, fmt.Sprintf("Factory whoami failed with HTTP %d", resp.StatusCode))
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, factorypkg.MaxWhoamiResponseBytes+1))
	if err != nil || len(body) > factorypkg.MaxWhoamiResponseBytes {
		return s.sendErrorAndEnd(c, "Factory whoami returned an oversized or unreadable response")
	}
	result, err := factorypkg.DecodeWhoami(body)
	if err != nil {
		return s.sendErrorAndEnd(c, err.Error())
	}
	if err := factorypkg.VerifyWhoami(result, credentials); err != nil {
		return s.sendErrorAndEnd(c, err.Error())
	}
	s.sendEvent(c, TestEvent{Type: "test_start", Model: "factory/whoami"})
	org := result.OrgID
	if org == "" {
		org = "none"
	}
	text := fmt.Sprintf("Factory API key authenticated with whoami. Region: %s. Active organization: %s. Inference was not tested.", result.Region, org)
	s.sendEvent(c, TestEvent{Type: "content", Text: text, Data: map[string]any{"region": result.Region, "org_id": result.OrgID, "auth_only": true, "inference_tested": false}})
	s.sendEvent(c, TestEvent{Type: "test_complete", Success: true})
	return nil
}

func sanitizeFactoryWhoamiError(err error) string {
	if err == nil {
		return ""
	}
	message := strings.TrimSpace(err.Error())
	if len(message) > 300 {
		message = message[:300]
	}
	return message
}
