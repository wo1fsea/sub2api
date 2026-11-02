package factory

import (
	"context"
	"strings"
	"testing"
)

func TestWhoamiRequestIsFixedAuthOnlyShape(t *testing.T) {
	req, err := NewWhoamiRequest(context.Background(), Credentials{APIKey: "fk-test", Region: RegionEU, OrgID: "fac_org"})
	if err != nil {
		t.Fatal(err)
	}
	if req.URL.String() != HostEU+"/api/cli/whoami" {
		t.Fatalf("URL = %s", req.URL)
	}
	if req.Header.Get("Authorization") != "Bearer fk-test" || req.Header.Get("X-Factory-Whoami-Extended") != "true" || req.Header.Get("X-Factory-Org-Id") != "fac_org" {
		t.Fatalf("headers = %#v", req.Header)
	}
	if req.Header.Get("X-Factory-Client") != "" || req.Header.Get("x-api-provider") != "" {
		t.Fatalf("whoami sent inference headers: %#v", req.Header)
	}
}

func TestDecodeWhoamiBoundedIdentityAndActionableMismatch(t *testing.T) {
	for _, body := range []string{"", "null", "{}", `{"orgId":"fac_org","region":"us"}`, `{"userId":"u","region":"moon"}`} {
		if _, err := DecodeWhoami([]byte(body)); err == nil {
			t.Fatalf("accepted malformed whoami body %q", body)
		}
	}
	result, err := DecodeWhoami([]byte(`{"userId":"user_1","orgId":"fac_org","region":"eu","premBaseHostV2":""}`))
	if err != nil {
		t.Fatal(err)
	}
	if result.Region != RegionEU || result.OrgID != "fac_org" {
		t.Fatalf("unexpected whoami: %#v", result)
	}
	if err := VerifyWhoami(result, Credentials{Region: RegionUS}); err == nil || !strings.Contains(err.Error(), "region") {
		t.Fatalf("region mismatch not actionable: %v", err)
	}
	if err := VerifyWhoami(result, Credentials{Region: RegionEU, OrgID: "fac_other"}); err == nil || !strings.Contains(err.Error(), "organization") {
		t.Fatalf("org mismatch not actionable: %v", err)
	}
	realGlobal, err := DecodeWhoami([]byte(`{"userId":"user_1","orgId":"7RpBf1pCiT53p7sNP8gu","inferenceRegion":"global","isEnterprise":false,"premBaseHostV2":"https://prem.factory.ai"}`))
	if err != nil {
		t.Fatal(err)
	}
	if realGlobal.Region != RegionUS || realGlobal.EnterpriseHost {
		t.Fatalf("real global whoami misclassified: %#v", realGlobal)
	}
	realEU, err := DecodeWhoami([]byte(`{"userId":"user_1","orgId":"7RpBf1pCiT53p7sNP8gu","inferenceRegion":"eu","isEnterprise":false,"premBaseHostV2":"https://prem.factory.ai/"}`))
	if err != nil {
		t.Fatal(err)
	}
	if realEU.Region != RegionEU || realEU.EnterpriseHost {
		t.Fatalf("real EU whoami misclassified: %#v", realEU)
	}
	if _, err := DecodeWhoami([]byte(`{"userId":"user_1","region":"us","inferenceRegion":"eu"}`)); err == nil {
		t.Fatal("contradictory whoami regions accepted")
	}
	enterprise, err := DecodeWhoami([]byte(`{"userId":"user_1","orgId":"fac_org","region":"us","premBaseHostV2":"enterprise.invalid"}`))
	if err != nil {
		t.Fatal(err)
	}
	if err := VerifyWhoami(enterprise, Credentials{Region: RegionUS}); err == nil || !strings.Contains(err.Error(), "enterprise") {
		t.Fatalf("enterprise host not actionable: %v", err)
	}
	if _, err := DecodeWhoami([]byte(`{"userId":"` + strings.Repeat("x", MaxWhoamiResponseBytes) + `"}`)); err == nil {
		t.Fatal("oversized whoami accepted")
	}
}
