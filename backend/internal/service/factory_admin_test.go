//go:build unit

package service

import (
	"context"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/pkg/pagination"
	"github.com/stretchr/testify/require"
)

type factoryAdminRepoStub struct {
	AccountRepository
	accounts        map[int64]*Account
	listData        []Account
	createCalls     int
	updateCalls     int
	bulkUpdateCalls int
	bulkUpdateIDs   []int64
	bulkUpdates     []AccountBulkUpdate
	lastCreated     *Account
	lastUpdate      *Account
	listPlatform    string
	listAccountType string
}

func cloneFactoryAdminAccount(account *Account) *Account {
	if account == nil {
		return nil
	}
	clone := *account
	clone.Credentials = make(map[string]any, len(account.Credentials))
	for key, value := range account.Credentials {
		clone.Credentials[key] = value
	}
	clone.Extra = make(map[string]any, len(account.Extra))
	for key, value := range account.Extra {
		clone.Extra[key] = value
	}
	return &clone
}

func newFactoryAdminRepo(accounts ...*Account) *factoryAdminRepoStub {
	repo := &factoryAdminRepoStub{accounts: map[int64]*Account{}}
	for _, account := range accounts {
		repo.accounts[account.ID] = account
	}
	return repo
}

func (r *factoryAdminRepoStub) Create(_ context.Context, account *Account) error {
	r.createCalls++
	if account.ID == 0 {
		account.ID = 1
	}
	r.lastCreated = cloneFactoryAdminAccount(account)
	r.accounts[account.ID] = cloneFactoryAdminAccount(account)
	return nil
}

func (r *factoryAdminRepoStub) GetByID(_ context.Context, id int64) (*Account, error) {
	account := r.accounts[id]
	if account == nil {
		return nil, ErrAccountNotFound
	}
	return cloneFactoryAdminAccount(account), nil
}

func (r *factoryAdminRepoStub) Update(_ context.Context, account *Account) error {
	r.updateCalls++
	r.lastUpdate = cloneFactoryAdminAccount(account)
	r.accounts[account.ID] = cloneFactoryAdminAccount(account)
	return nil
}

func (r *factoryAdminRepoStub) GetByIDs(_ context.Context, ids []int64) ([]*Account, error) {
	result := make([]*Account, 0, len(ids))
	for _, id := range ids {
		if account := r.accounts[id]; account != nil {
			result = append(result, cloneFactoryAdminAccount(account))
		}
	}
	return result, nil
}

func (r *factoryAdminRepoStub) BulkUpdate(_ context.Context, ids []int64, updates AccountBulkUpdate) (int64, error) {
	r.bulkUpdateCalls++
	r.bulkUpdateIDs = append([]int64{}, ids...)
	r.bulkUpdates = append(r.bulkUpdates, updates)
	return int64(len(ids)), nil
}

func (r *factoryAdminRepoStub) ListWithFilters(_ context.Context, _ pagination.PaginationParams, platform, accountType, status, search string, groupID int64, privacyMode string) ([]Account, *pagination.PaginationResult, error) {
	r.listPlatform = platform
	r.listAccountType = accountType
	return r.listData, &pagination.PaginationResult{Total: int64(len(r.listData))}, nil
}

func factoryAdminCredentials() map[string]any {
	return map[string]any{
		"api_key":        "fk-existing",
		"region":         "eu",
		"factory_org_id": "org-existing",
		"model_mapping":  map[string]any{"factory/claude-opus-5-5": "claude-opus-5-5"},
	}
}

func factoryAdminAccount(id int64) *Account {
	return &Account{
		ID:          id,
		Name:        "Factory key",
		Platform:    PlatformFactory,
		Type:        AccountTypeAPIKey,
		Status:      StatusActive,
		Credentials: factoryAdminCredentials(),
		Extra:       map[string]any{},
	}
}

func TestFactoryAdminCreateAccountNormalizesStrictCredentials(t *testing.T) {
	repo := newFactoryAdminRepo()
	svc := &adminServiceImpl{accountRepo: repo}
	created, err := svc.CreateAccount(context.Background(), &CreateAccountInput{
		Name:                 "factory strict",
		Platform:             PlatformFactory,
		Type:                 AccountTypeAPIKey,
		SkipDefaultGroupBind: true,
		Credentials: map[string]any{
			"api_key":        " fk-create_123 ",
			"region":         "US",
			"factory_org_id": " org-create_1 ",
			"model_mapping":  map[string]any{"factory/claude-opus-5-5": "claude-opus-5-5"},
		},
	})
	require.NoError(t, err)
	require.NotNil(t, created)
	require.Equal(t, 1, repo.createCalls)
	require.Equal(t, map[string]any{
		"api_key":        "fk-create_123",
		"region":         "us",
		"factory_org_id": "org-create_1",
		"model_mapping":  map[string]any{"factory/claude-opus-5-5": "claude-opus-5-5"},
	}, created.Credentials)
}

func TestFactoryAdminCreateAccountRejectsInvalidCredentials(t *testing.T) {
	tests := []struct {
		name    string
		creds   map[string]any
		wantErr string
	}{
		{name: "missing api key", creds: map[string]any{"region": "us"}, wantErr: "api_key is required"},
		{name: "non fk key", creds: map[string]any{"api_key": "sk-live"}, wantErr: "fk- key"},
		{name: "invalid region", creds: map[string]any{"api_key": "fk-valid", "region": "apac"}, wantErr: "region must be us or eu"},
		{name: "invalid org", creds: map[string]any{"api_key": "fk-valid", "factory_org_id": "org with space"}, wantErr: "factory_org_id must not contain whitespace"},
		{name: "invalid mapping target", creds: map[string]any{"api_key": "fk-valid", "model_mapping": map[string]any{"alias": "not-factory"}}, wantErr: "not a supported Factory model"},
		{name: "generic base url", creds: map[string]any{"api_key": "fk-valid", "base_url": "https://evil.example"}, wantErr: "unsupported Factory credential key"},
		{name: "auth token field", creds: map[string]any{"api_key": "fk-valid", "access_token": "token"}, wantErr: "unsupported Factory credential key"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			repo := newFactoryAdminRepo()
			svc := &adminServiceImpl{accountRepo: repo}
			_, err := svc.CreateAccount(context.Background(), &CreateAccountInput{
				Name:                 "invalid factory",
				Platform:             PlatformFactory,
				Type:                 AccountTypeAPIKey,
				SkipDefaultGroupBind: true,
				Credentials:          tt.creds,
			})
			require.ErrorContains(t, err, tt.wantErr)
			require.Zero(t, repo.createCalls)
		})
	}
}

func TestFactoryAdminCreateAccountRejectsNonAPIKeyType(t *testing.T) {
	repo := newFactoryAdminRepo()
	svc := &adminServiceImpl{accountRepo: repo}
	_, err := svc.CreateAccount(context.Background(), &CreateAccountInput{
		Name:                 "factory oauth",
		Platform:             PlatformFactory,
		Type:                 AccountTypeOAuth,
		SkipDefaultGroupBind: true,
		Credentials:          factoryAdminCredentials(),
	})
	require.ErrorContains(t, err, "only support apikey")
	require.Zero(t, repo.createCalls)
}

func TestFactoryAdminUpdateAccountPreservesKeyAndPartialFields(t *testing.T) {
	tests := []struct {
		name        string
		incoming    map[string]any
		wantRegion  string
		wantOrg     string
		wantMapping any
	}{
		{name: "blank key keeps existing key", incoming: map[string]any{"api_key": "   ", "region": "us"}, wantRegion: "us", wantOrg: "org-existing", wantMapping: map[string]any{"factory/claude-opus-5-5": "claude-opus-5-5"}},
		{name: "omitted key keeps existing key", incoming: map[string]any{"factory_org_id": "org-updated"}, wantRegion: "eu", wantOrg: "org-updated", wantMapping: map[string]any{"factory/claude-opus-5-5": "claude-opus-5-5"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			repo := newFactoryAdminRepo(factoryAdminAccount(21))
			svc := &adminServiceImpl{accountRepo: repo}
			updated, err := svc.UpdateAccount(context.Background(), 21, &UpdateAccountInput{Credentials: tt.incoming})
			require.NoError(t, err)
			require.Equal(t, 1, repo.updateCalls)
			require.Equal(t, "fk-existing", updated.Credentials["api_key"])
			require.Equal(t, tt.wantRegion, updated.Credentials["region"])
			require.Equal(t, tt.wantOrg, updated.Credentials["factory_org_id"])
			require.Equal(t, tt.wantMapping, updated.Credentials["model_mapping"])
		})
	}
}

func TestFactoryAdminUpdateAccountExplicitlyClearsOrgAndMapping(t *testing.T) {
	repo := newFactoryAdminRepo(factoryAdminAccount(22))
	svc := &adminServiceImpl{accountRepo: repo}
	updated, err := svc.UpdateAccount(context.Background(), 22, &UpdateAccountInput{Credentials: map[string]any{
		"api_key":        "",
		"factory_org_id": "",
		"model_mapping":  map[string]any{},
	}})
	require.NoError(t, err)
	require.Equal(t, 1, repo.updateCalls)
	require.Equal(t, "fk-existing", updated.Credentials["api_key"])
	require.Equal(t, "eu", updated.Credentials["region"])
	require.NotContains(t, updated.Credentials, "factory_org_id")
	require.NotContains(t, updated.Credentials, "model_mapping")
}

func TestFactoryAdminUpdateAccountRejectsInvalidChangesBeforeWrite(t *testing.T) {
	tests := []struct {
		name    string
		input   *UpdateAccountInput
		wantErr string
	}{
		{name: "type change", input: &UpdateAccountInput{Type: AccountTypeOAuth}, wantErr: "only support apikey"},
		{name: "invalid mapping target", input: &UpdateAccountInput{Credentials: map[string]any{"model_mapping": map[string]any{"alias": "not-factory"}}}, wantErr: "not a supported Factory model"},
		{name: "unsupported credential field", input: &UpdateAccountInput{Credentials: map[string]any{"base_url": "https://evil.example"}}, wantErr: "unsupported Factory credential key"},
		{name: "invalid replacement key", input: &UpdateAccountInput{Credentials: map[string]any{"api_key": "sk-invalid"}}, wantErr: "fk- key"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			repo := newFactoryAdminRepo(factoryAdminAccount(23))
			svc := &adminServiceImpl{accountRepo: repo}
			_, err := svc.UpdateAccount(context.Background(), 23, tt.input)
			require.ErrorContains(t, err, tt.wantErr)
			require.Zero(t, repo.updateCalls)
			require.Equal(t, "fk-existing", repo.accounts[23].Credentials["api_key"])
			require.Equal(t, "org-existing", repo.accounts[23].Credentials["factory_org_id"])
		})
	}
}

func TestFactoryAdminBulkUpdateFactoryPartialCredentials(t *testing.T) {
	repo := newFactoryAdminRepo(factoryAdminAccount(31), factoryAdminAccount(32))
	svc := &adminServiceImpl{accountRepo: repo}
	result, err := svc.BulkUpdateAccounts(context.Background(), &BulkUpdateAccountsInput{
		AccountIDs: []int64{31, 32},
		Credentials: map[string]any{
			"region":         "US",
			"factory_org_id": " org-new ",
		},
	})
	require.NoError(t, err)
	require.Equal(t, 2, result.Success)
	require.Equal(t, []int64{31, 32}, result.SuccessIDs)
	require.Equal(t, 1, repo.bulkUpdateCalls)
	require.Equal(t, []int64{31, 32}, repo.bulkUpdateIDs)
	require.Equal(t, map[string]any{"region": "us", "factory_org_id": "org-new"}, repo.bulkUpdates[0].Credentials)
}

func TestFactoryAdminBulkUpdateOmitsBlankKeyFromPartialUpdate(t *testing.T) {
	repo := newFactoryAdminRepo(factoryAdminAccount(35), factoryAdminAccount(36))
	svc := &adminServiceImpl{accountRepo: repo}
	result, err := svc.BulkUpdateAccounts(context.Background(), &BulkUpdateAccountsInput{
		AccountIDs: []int64{35, 36},
		Credentials: map[string]any{
			"api_key": "   ",
			"region":  "us",
		},
	})
	require.NoError(t, err)
	require.Equal(t, 2, result.Success)
	require.Equal(t, 1, repo.bulkUpdateCalls)
	require.Equal(t, map[string]any{"region": "us"}, repo.bulkUpdates[0].Credentials)
	require.NotContains(t, repo.bulkUpdates[0].Credentials, "api_key")
}

func TestFactoryAdminBulkUpdateExplicitlyClearsOrgAndMapping(t *testing.T) {
	repo := newFactoryAdminRepo(factoryAdminAccount(33), factoryAdminAccount(34))
	svc := &adminServiceImpl{accountRepo: repo}
	result, err := svc.BulkUpdateAccounts(context.Background(), &BulkUpdateAccountsInput{
		AccountIDs: []int64{33, 34},
		Credentials: map[string]any{
			"factory_org_id": "",
			"model_mapping":  map[string]any{},
		},
	})
	require.NoError(t, err)
	require.Equal(t, 2, result.Success)
	require.Equal(t, 1, repo.bulkUpdateCalls)
	require.Equal(t, map[string]any{
		"factory_org_id": "",
		"model_mapping":  map[string]any{},
	}, repo.bulkUpdates[0].Credentials)
}

func TestFactoryAdminBulkUpdateResolvesFilterTargets(t *testing.T) {
	repo := newFactoryAdminRepo(factoryAdminAccount(51), factoryAdminAccount(52))
	repo.listData = []Account{*factoryAdminAccount(51), *factoryAdminAccount(52)}
	svc := &adminServiceImpl{accountRepo: repo}
	result, err := svc.BulkUpdateAccounts(context.Background(), &BulkUpdateAccountsInput{
		Filters:     &BulkUpdateAccountFilters{Platform: PlatformFactory, Type: AccountTypeAPIKey},
		Credentials: map[string]any{"region": "eu"},
	})
	require.NoError(t, err)
	require.Equal(t, 2, result.Success)
	require.Equal(t, PlatformFactory, repo.listPlatform)
	require.Equal(t, AccountTypeAPIKey, repo.listAccountType)
	require.Equal(t, []int64{51, 52}, repo.bulkUpdateIDs)
	require.Equal(t, map[string]any{"region": "eu"}, repo.bulkUpdates[0].Credentials)
}

func TestFactoryAdminBulkUpdateLeavesBedrockRegionCredentialsUnchanged(t *testing.T) {
	bedrock := &Account{
		ID:          41,
		Name:        "bedrock",
		Platform:    PlatformAnthropic,
		Type:        AccountTypeBedrock,
		Status:      StatusActive,
		Credentials: map[string]any{"aws_region": "us-east-1", "api_key": "bedrock-key"},
		Extra:       map[string]any{},
	}
	repo := newFactoryAdminRepo(bedrock)
	svc := &adminServiceImpl{accountRepo: repo}
	result, err := svc.BulkUpdateAccounts(context.Background(), &BulkUpdateAccountsInput{
		AccountIDs:  []int64{41},
		Credentials: map[string]any{"aws_region": "eu-west-1"},
	})
	require.NoError(t, err)
	require.Equal(t, 1, result.Success)
	require.Equal(t, 1, repo.bulkUpdateCalls)
	require.Equal(t, map[string]any{"aws_region": "eu-west-1"}, repo.bulkUpdates[0].Credentials)
}

func TestFactoryAdminBulkUpdateValidatesAllTargetsBeforeWrite(t *testing.T) {
	tests := []struct {
		name    string
		targets []*Account
		input   map[string]any
		wantErr string
	}{
		{
			name: "second target is not apikey",
			targets: func() []*Account {
				second := factoryAdminAccount(62)
				second.Type = AccountTypeOAuth
				return []*Account{factoryAdminAccount(61), second}
			}(),
			input:   map[string]any{"region": "us"},
			wantErr: "only supports apikey",
		},
		{
			name:    "invalid effective mapping",
			targets: []*Account{factoryAdminAccount(63), factoryAdminAccount(64)},
			input:   map[string]any{"model_mapping": map[string]any{"alias": "not-factory"}},
			wantErr: "not a supported Factory model",
		},
		{
			name:    "unsupported credential field",
			targets: []*Account{factoryAdminAccount(67), factoryAdminAccount(68)},
			input:   map[string]any{"base_url": "https://evil.example"},
			wantErr: "unsupported Factory credential key",
		},
		{
			name: "factory-only field in mixed batch",
			targets: []*Account{factoryAdminAccount(65), {
				ID: 66, Name: "anthropic", Platform: PlatformAnthropic, Type: AccountTypeAPIKey,
				Status: StatusActive, Credentials: map[string]any{"api_key": "sk-test"}, Extra: map[string]any{},
			}},
			input:   map[string]any{"region": "eu"},
			wantErr: "region supports only Factory targets in a mixed bulk update",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			repo := newFactoryAdminRepo(tt.targets...)
			svc := &adminServiceImpl{accountRepo: repo}
			ids := make([]int64, 0, len(tt.targets))
			for _, target := range tt.targets {
				ids = append(ids, target.ID)
			}
			result, err := svc.BulkUpdateAccounts(context.Background(), &BulkUpdateAccountsInput{
				AccountIDs:  ids,
				Credentials: tt.input,
			})
			require.Nil(t, result)
			require.ErrorContains(t, err, tt.wantErr)
			require.Zero(t, repo.bulkUpdateCalls, "validation must finish before any bulk write")
		})
	}
}

func TestFactoryAdminBulkUpdateRejectsMissingTargetBeforeWrite(t *testing.T) {
	repo := newFactoryAdminRepo(factoryAdminAccount(71))
	svc := &adminServiceImpl{accountRepo: repo}
	result, err := svc.BulkUpdateAccounts(context.Background(), &BulkUpdateAccountsInput{
		AccountIDs:  []int64{71, 72},
		Credentials: map[string]any{"region": "us"},
	})
	require.Nil(t, result)
	require.Error(t, err)
	require.Zero(t, repo.bulkUpdateCalls, "missing targets must not bypass Factory validation")
}
