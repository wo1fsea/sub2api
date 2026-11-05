//go:build unit

package service

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/config"
	"github.com/stretchr/testify/require"
)

type quotaRecoveryRepo struct {
	mockAccountRepoForGemini
	mu              sync.Mutex
	account         *Account
	clearErrorCalls int
	setSchedulable  []bool
	setErrorCalls   int
}

func (r *quotaRecoveryRepo) GetByID(context.Context, int64) (*Account, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.account == nil {
		return nil, errors.New("missing")
	}
	clone := *r.account
	clone.Extra = cloneExtraMap(r.account.Extra)
	return &clone, nil
}

func (r *quotaRecoveryRepo) ListByPlatform(_ context.Context, platform string) ([]Account, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.account == nil || r.account.Platform != platform {
		return nil, nil
	}
	clone := *r.account
	clone.Extra = cloneExtraMap(r.account.Extra)
	return []Account{clone}, nil
}

func (r *quotaRecoveryRepo) SetError(_ context.Context, id int64, errorMsg string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.account == nil || r.account.ID != id {
		return errors.New("missing")
	}
	r.setErrorCalls++
	r.account.Status = StatusError
	r.account.ErrorMessage = errorMsg
	r.account.Schedulable = false
	return nil
}

func (r *quotaRecoveryRepo) ClearError(_ context.Context, id int64) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.account == nil || r.account.ID != id {
		return errors.New("missing")
	}
	r.clearErrorCalls++
	r.account.Status = StatusActive
	r.account.ErrorMessage = ""
	return nil
}

func (r *quotaRecoveryRepo) SetSchedulable(_ context.Context, id int64, schedulable bool) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.account == nil || r.account.ID != id {
		return errors.New("missing")
	}
	r.setSchedulable = append(r.setSchedulable, schedulable)
	r.account.Schedulable = schedulable
	return nil
}

func (r *quotaRecoveryRepo) UpdateExtra(_ context.Context, id int64, updates map[string]any) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.account == nil || r.account.ID != id {
		return errors.New("missing")
	}
	raw, err := json.Marshal(updates)
	if err != nil {
		return err
	}
	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return err
	}
	if r.account.Extra == nil {
		r.account.Extra = map[string]any{}
	}
	for key, value := range decoded {
		r.account.Extra[key] = value
	}
	return nil
}

func newQuotaRecoveryService(repo *quotaRecoveryRepo, fetch func(context.Context, *Account) (QuotaWindowSnapshot, error)) (*QuotaWindowRecoveryService, *RateLimitService) {
	rateLimit := NewRateLimitService(repo, nil, &config.Config{}, nil, nil)
	svc := NewQuotaWindowRecoveryService(repo, rateLimit)
	svc.fetch = fetch
	svc.grace = 0
	rateLimit.SetQuotaWindowRecovery(svc)
	return svc, rateLimit
}

func TestQuotaWindowRecovery_ExhaustedWindowResetReenables(t *testing.T) {
	now := time.Now().UTC()
	repo := &quotaRecoveryRepo{account: factoryQuotaAccount(now.Add(-time.Minute), 100, true)}
	svc, _ := newQuotaRecoveryService(repo, func(context.Context, *Account) (QuotaWindowSnapshot, error) {
		return QuotaWindowSnapshot{}, errors.New("refresh unavailable")
	})

	svc.evaluate(context.Background(), repo.account.ID, true)

	require.Equal(t, StatusActive, repo.account.Status)
	require.Empty(t, repo.account.ErrorMessage)
	require.True(t, repo.account.Schedulable)
	require.Equal(t, []bool{true}, repo.setSchedulable)
	require.Equal(t, 1, repo.clearErrorCalls)
	_, stillBlocked := parseQuotaBlock(repo.account.Extra)
	require.False(t, stillBlocked)
}

func TestQuotaWindowRecovery_StillExhaustedDoesNotReenable(t *testing.T) {
	now := time.Now().UTC()
	repo := &quotaRecoveryRepo{account: factoryQuotaAccount(now.Add(2*time.Hour), 100, true)}
	svc, _ := newQuotaRecoveryService(repo, func(context.Context, *Account) (QuotaWindowSnapshot, error) {
		t.Fatal("must not refresh a window that is still in the future")
		return QuotaWindowSnapshot{}, nil
	})

	svc.evaluate(context.Background(), repo.account.ID, true)

	require.Equal(t, StatusError, repo.account.Status)
	require.False(t, repo.account.Schedulable)
	require.Empty(t, repo.setSchedulable)
	require.Zero(t, repo.clearErrorCalls)
	svc.mu.Lock()
	wake := svc.deadlines[repo.account.ID]
	svc.mu.Unlock()
	require.True(t, wake.Equal(now.Add(2*time.Hour)) || wake.After(now.Add(time.Hour)))
}

func TestQuotaWindowRecovery_RefreshStillExhaustedReschedules(t *testing.T) {
	now := time.Now().UTC()
	repo := &quotaRecoveryRepo{account: factoryQuotaAccount(now.Add(-time.Minute), 100, true)}
	next := now.Add(3 * time.Hour)
	svc, _ := newQuotaRecoveryService(repo, func(context.Context, *Account) (QuotaWindowSnapshot, error) {
		return QuotaWindowSnapshot{Platform: PlatformFactory, FetchedAt: now, Windows: []QuotaWindow{{
			ID: "standard:5h", Pool: "standard", Name: "5h", Utilization: 100, Exhausted: true, ResetsAt: next,
		}}}, nil
	})

	svc.evaluate(context.Background(), repo.account.ID, true)

	require.Equal(t, StatusError, repo.account.Status)
	require.False(t, repo.account.Schedulable)
	require.Empty(t, repo.setSchedulable)
	svc.mu.Lock()
	wake := svc.deadlines[repo.account.ID]
	svc.mu.Unlock()
	require.True(t, wake.Equal(next))
}

func TestQuotaWindowRecovery_ManualAndUnrelatedStayOff(t *testing.T) {
	now := time.Now().UTC()
	recovered := QuotaWindowSnapshot{Windows: []QuotaWindow{{
		ID: "standard:5h", Utilization: 0, ResetsAt: now.Add(-time.Hour),
	}}}
	manual := &Account{
		ID: 13, Platform: PlatformFactory, Status: StatusActive, Schedulable: false,
		Extra: map[string]any{QuotaWindowsExtraKey: recovered},
	}
	unrelated := &Account{
		ID: 13, Platform: PlatformFactory, Status: StatusError, Schedulable: false,
		ErrorMessage: "Organization disabled (400): organization has been disabled",
		Extra:        map[string]any{QuotaWindowsExtraKey: recovered},
	}
	for _, account := range []*Account{manual, unrelated} {
		repo := &quotaRecoveryRepo{account: account}
		svc, _ := newQuotaRecoveryService(repo, func(context.Context, *Account) (QuotaWindowSnapshot, error) {
			t.Fatal("must not refresh an account that is not quota-blocked")
			return QuotaWindowSnapshot{}, nil
		})
		svc.evaluate(context.Background(), account.ID, true)
		require.False(t, repo.account.Schedulable)
		require.Empty(t, repo.setSchedulable)
		require.Zero(t, repo.clearErrorCalls)
		require.Equal(t, account.Status, repo.account.Status)
	}
}

func TestQuotaWindowRecovery_RecoverStateThenSchedulable(t *testing.T) {
	now := time.Now().UTC()
	repo := &quotaRecoveryRepo{account: factoryQuotaAccount(now.Add(-time.Minute), 0, false)}
	svc, rateLimit := newQuotaRecoveryService(repo, func(context.Context, *Account) (QuotaWindowSnapshot, error) {
		return QuotaWindowSnapshot{}, errors.New("refresh unavailable")
	})

	result, err := rateLimit.RecoverAccountState(context.Background(), repo.account.ID, AccountRecoveryOptions{})
	require.NoError(t, err)
	require.True(t, result.ClearedError)
	require.Equal(t, StatusActive, repo.account.Status)
	require.Empty(t, repo.account.ErrorMessage)
	require.False(t, repo.account.Schedulable, "recover-state clears the error and leaves schedulable false")

	svc.evaluate(context.Background(), repo.account.ID, true)

	require.True(t, repo.account.Schedulable)
	require.Equal(t, []bool{true}, repo.setSchedulable)
}

func TestQuotaWindowRecovery_TimerFiresAtReset(t *testing.T) {
	resetAt := time.Now().Add(150 * time.Millisecond)
	repo := &quotaRecoveryRepo{account: factoryQuotaAccount(resetAt, 100, true)}
	svc, _ := newQuotaRecoveryService(repo, func(context.Context, *Account) (QuotaWindowSnapshot, error) {
		return QuotaWindowSnapshot{}, errors.New("refresh unavailable")
	})
	svc.Start()
	t.Cleanup(svc.Stop)

	require.Eventually(t, func() bool {
		repo.mu.Lock()
		defer repo.mu.Unlock()
		return repo.account.Schedulable && repo.account.Status == StatusActive && repo.account.ErrorMessage == ""
	}, 3*time.Second, 20*time.Millisecond)
}

func TestHandleUpstreamError_Factory402ArmsQuotaRecovery(t *testing.T) {
	resetAt := time.Now().Add(2 * time.Hour).UTC()
	repo := &quotaRecoveryRepo{account: &Account{
		ID: 13, Platform: PlatformFactory, Type: AccountTypeAPIKey, Status: StatusActive, Schedulable: true,
		Credentials: map[string]any{"api_key": "fk-testkey", "region": "us"},
	}}
	var fetched atomic.Int64
	svc, rateLimit := newQuotaRecoveryService(repo, func(context.Context, *Account) (QuotaWindowSnapshot, error) {
		fetched.Add(1)
		return QuotaWindowSnapshot{Platform: PlatformFactory, FetchedAt: time.Now().UTC(), Windows: []QuotaWindow{{
			ID: "standard:5h", Pool: "standard", Name: "5h", Utilization: 100, Exhausted: true, ResetsAt: resetAt,
		}}}, nil
	})
	svc.Start()
	t.Cleanup(svc.Stop)

	// The live repo account is updated by the scheduler goroutine. The request
	// snapshot must not share that Extra map, or NoteExhaustion races the refresh.
	request := *repo.account
	request.Extra = cloneExtraMap(repo.account.Extra)
	disabled := rateLimit.HandleUpstreamError(context.Background(), &request, http.StatusPaymentRequired, nil,
		[]byte(`{"error":{"message":"Standard usage limit reached. 5h limit"}}`))
	require.True(t, disabled)
	require.Equal(t, 1, repo.setErrorCalls)
	require.Equal(t, StatusError, repo.account.Status)
	require.False(t, repo.account.Schedulable)
	require.Contains(t, repo.account.ErrorMessage, "5h limit")
	require.Empty(t, repo.setSchedulable, "recording the 402 must not re-enable on the request path")

	require.Eventually(t, func() bool {
		repo.mu.Lock()
		defer repo.mu.Unlock()
		block, ok := parseQuotaBlock(repo.account.Extra)
		if !ok || !block.Active || block.Revoked || !block.ClearedSchedulable || block.WindowID != "standard:5h" {
			return false
		}
		svc.mu.Lock()
		wake := svc.deadlines[13]
		svc.mu.Unlock()
		return fetched.Load() >= 1 && !wake.IsZero() && wake.After(time.Now().Add(time.Hour))
	}, 3*time.Second, 20*time.Millisecond)
}

func TestHandleUpstreamError_Factory402UnrelatedBillingDoesNotArm(t *testing.T) {
	repo := &quotaRecoveryRepo{account: &Account{
		ID: 13, Platform: PlatformFactory, Type: AccountTypeAPIKey, Status: StatusActive, Schedulable: true,
	}}
	_, rateLimit := newQuotaRecoveryService(repo, func(context.Context, *Account) (QuotaWindowSnapshot, error) {
		t.Fatal("non-quota 402 must not fetch quota windows")
		return QuotaWindowSnapshot{}, nil
	})
	disabled := rateLimit.HandleUpstreamError(context.Background(), repo.account, http.StatusPaymentRequired, nil,
		[]byte(`{"error":{"message":"card was declined"}}`))
	require.True(t, disabled)
	require.Equal(t, StatusError, repo.account.Status)
	require.False(t, repo.account.Schedulable)
	_, ok := parseQuotaBlock(repo.account.Extra)
	require.False(t, ok)
}

func TestSetAccountSchedulable_RevokesQuotaAutoRestore(t *testing.T) {
	now := time.Now().UTC()
	repo := &quotaRecoveryRepo{account: factoryQuotaAccount(now.Add(-time.Minute), 0, false)}
	admin := &adminServiceImpl{accountRepo: repo}

	updated, err := admin.SetAccountSchedulable(context.Background(), repo.account.ID, false)
	require.NoError(t, err)
	require.False(t, updated.Schedulable)
	block, ok := parseQuotaBlock(updated.Extra)
	require.True(t, ok)
	require.True(t, block.Revoked)
	require.Equal(t, QuotaRecoverySkip, DecideQuotaWindowRecovery(updated, now, 0).Action)
}
