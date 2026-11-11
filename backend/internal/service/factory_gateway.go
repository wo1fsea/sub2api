package service

import (
	"fmt"
	"net/http"

	factorypkg "github.com/Wei-Shaw/sub2api/internal/pkg/factory"
)

func prepareFactoryUpstream(account *Account, protocol string, body []byte) ([]byte, factorypkg.Credentials, factorypkg.Model, error) {
	if account == nil || !account.IsFactory() {
		return nil, factorypkg.Credentials{}, factorypkg.Model{}, fmt.Errorf("factory account is required")
	}
	if account.Type != AccountTypeAPIKey {
		return nil, factorypkg.Credentials{}, factorypkg.Model{}, fmt.Errorf("factory only supports API-key accounts")
	}
	credentials, err := factorypkg.ParseCredentials(account.Credentials, true)
	if err != nil {
		return nil, factorypkg.Credentials{}, factorypkg.Model{}, err
	}
	prepared, model, err := factorypkg.PrepareInferenceBody(factorypkg.Protocol(protocol), body)
	if err != nil {
		return nil, factorypkg.Credentials{}, factorypkg.Model{}, err
	}
	return prepared, credentials, model, nil
}

func applyFactoryRequestPolicy(req *http.Request, account *Account, protocol string, credentials factorypkg.Credentials, model factorypkg.Model) error {
	if err := factorypkg.ApplyRequestPolicy(req, credentials, model, factorypkg.Protocol(protocol)); err != nil {
		return err
	}
	*req = *req.WithContext(WithHTTPUpstreamRedirectsDisabled(req.Context()))
	return nil
}

func factoryEndpointURL(account *Account, protocol string) (string, error) {
	if account == nil || !account.IsFactory() {
		return "", fmt.Errorf("factory account is required")
	}
	credentials, err := factorypkg.ParseCredentials(account.Credentials, true)
	if err != nil {
		return "", err
	}
	endpoint, ok := factorypkg.EndpointURL(credentials.Region, factorypkg.Protocol(protocol))
	if !ok {
		return "", fmt.Errorf("unsupported Factory endpoint")
	}
	return endpoint, nil
}
