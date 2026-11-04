package service

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"
)

// QuotaWindowRecoveryService restores accounts that were pulled from scheduling
// by a temporary quota window once that window's stored resets_at has passed.
//
// The scheduler is one timer armed at the soonest exhausted resets_at (plus a
// short grace). It does not poll. A process restart performs a single scan of
// Factory accounts that already carry a quota-exhaustion signal and either
// restores them or arms the same timer. Other platforms can use the same path
// by persisting quota_windows / quota_block and calling NoteExhaustion.
type QuotaWindowRecoveryService struct {
	accounts  AccountRepository
	recoverer quotaWindowRecoverer
	fetch     func(context.Context, *Account) (QuotaWindowSnapshot, error)
	now       func() time.Time
	grace     time.Duration

	ctx    context.Context
	cancel context.CancelFunc

	mu             sync.Mutex
	deadlines      map[int64]time.Time
	pendingRefresh map[int64]string
	wake           chan struct{}

	startOnce sync.Once
	stopOnce  sync.Once
	wg        sync.WaitGroup
}

type quotaWindowRecoverer interface {
	RecoverAccountState(ctx context.Context, accountID int64, options AccountRecoveryOptions) (*SuccessfulTestRecoveryResult, error)
}

// NewQuotaWindowRecoveryService builds the scheduler. recoverer is normally the
// RateLimitService that owns RecoverAccountState. fetch may be nil, in which
// case Factory's billing-limits endpoint is used.
func NewQuotaWindowRecoveryService(accounts AccountRepository, recoverer quotaWindowRecoverer) *QuotaWindowRecoveryService {
	return &QuotaWindowRecoveryService{
		accounts:       accounts,
		recoverer:      recoverer,
		now:            time.Now,
		grace:          quotaWindowResetGrace,
		deadlines:      make(map[int64]time.Time),
		pendingRefresh: make(map[int64]string),
		wake:           make(chan struct{}, 1),
	}
}

// Start launches the timer loop and the one-shot startup scan.
func (s *QuotaWindowRecoveryService) Start() {
	if s == nil || s.accounts == nil {
		return
	}
	s.startOnce.Do(func() {
		s.ctx, s.cancel = context.WithCancel(context.Background())
		s.wg.Add(1)
		go s.loop()
		s.wg.Add(1)
		go s.bootstrap()
	})
}

// Stop cancels the timer loop and waits for it to exit.
func (s *QuotaWindowRecoveryService) Stop() {
	if s == nil {
		return
	}
	s.stopOnce.Do(func() {
		if s.cancel != nil {
			s.cancel()
		}
		s.wg.Wait()
	})
}

// NoteExhaustion records a quota-exhaustion block and asks the scheduler to
// refresh quota windows. It does not call upstream and does not re-enable
// scheduling: the caller has just marked the account unusable, and doing either
// on the request path would slow failover or undo the 402 in the same stack.
// The scheduler goroutine fetches windows and arms resets_at.
func (s *QuotaWindowRecoveryService) NoteExhaustion(ctx context.Context, account *Account, errorMessage string) {
	if s == nil || account == nil || account.ID <= 0 || s.accounts == nil {
		return
	}
	if ctx == nil {
		ctx = context.Background()
	}
	snap := parseQuotaWindowSnapshot(account.Extra)
	block := QuotaBlock{
		Active:             true,
		Source:             quotaExhaustionSource,
		Platform:           account.Platform,
		ClearedSchedulable: true,
		SetError:           true,
		ErrorMessage:       errorMessage,
	}
	if tightest, ok := TightestExhaustedWindow(snap.Windows, s.now()); ok {
		block.WindowID = tightest.ID
		block.ResetsAt = tightest.ResetsAt.UTC()
	}
	s.persistBlock(ctx, account, block)
	s.requestRefresh(account.ID)
}

func (s *QuotaWindowRecoveryService) graceOrDefault() time.Duration {
	if s.grace <= 0 {
		return time.Second
	}
	return s.grace
}

func cloneExtraMap(src map[string]any) map[string]any {
	if len(src) == 0 {
		return nil
	}
	dst := make(map[string]any, len(src))
	for key, value := range src {
		dst[key] = value
	}
	return dst
}

func (s *QuotaWindowRecoveryService) fetchWindows(ctx context.Context, account *Account) (QuotaWindowSnapshot, error) {
	if s.fetch != nil {
		return s.fetch(ctx, account)
	}
	if account != nil && account.IsFactory() {
		return fetchFactoryQuotaWindows(ctx, account)
	}
	return QuotaWindowSnapshot{}, errQuotaWindowFetchSkipped
}

var errQuotaWindowFetchSkipped = errors.New("quota window refresh is not configured for this platform")

func (s *QuotaWindowRecoveryService) persistWindows(ctx context.Context, account *Account, snap QuotaWindowSnapshot) {
	if s.accounts == nil || account == nil {
		return
	}
	if err := s.accounts.UpdateExtra(ctx, account.ID, map[string]any{QuotaWindowsExtraKey: snap}); err != nil {
		slog.Warn("quota_window_persist_failed", "account_id", account.ID, "error", err)
	}
}

func (s *QuotaWindowRecoveryService) persistBlock(ctx context.Context, account *Account, block QuotaBlock) {
	if s.accounts == nil || account == nil {
		return
	}
	if err := s.accounts.UpdateExtra(ctx, account.ID, map[string]any{QuotaBlockExtraKey: block}); err != nil {
		slog.Warn("quota_block_persist_failed", "account_id", account.ID, "error", err)
	}
}

func (s *QuotaWindowRecoveryService) bootstrap() {
	defer s.wg.Done()
	ctx := s.ctx
	if ctx == nil {
		return
	}
	accounts, err := s.accounts.ListByPlatform(ctx, PlatformFactory)
	if err != nil {
		slog.Warn("quota_window_bootstrap_failed", "error", err)
		return
	}
	for _, account := range accounts {
		if ctx.Err() != nil {
			return
		}
		if !quotaRecoveryCandidate(&account) {
			continue
		}
		s.evaluate(ctx, account.ID, true)
	}
}

func quotaRecoveryCandidate(account *Account) bool {
	if account == nil || !account.IsFactory() {
		return false
	}
	block, ok := parseQuotaBlock(account.Extra)
	if ok && block.Revoked {
		return false
	}
	if ok && block.Active && block.Source == quotaExhaustionSource {
		return true
	}
	return account.Status == StatusError && isQuotaExhaustionText(account.ErrorMessage)
}

func (s *QuotaWindowRecoveryService) requestRefresh(accountID int64) {
	if s == nil || accountID <= 0 {
		return
	}
	s.mu.Lock()
	if s.pendingRefresh == nil {
		s.pendingRefresh = map[int64]string{}
	}
	s.pendingRefresh[accountID] = ""
	s.mu.Unlock()
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

func (s *QuotaWindowRecoveryService) drainRefreshes() {
	s.mu.Lock()
	if len(s.pendingRefresh) == 0 {
		s.mu.Unlock()
		return
	}
	ids := make([]int64, 0, len(s.pendingRefresh))
	for id := range s.pendingRefresh {
		ids = append(ids, id)
		delete(s.pendingRefresh, id)
	}
	s.mu.Unlock()
	ctx := s.ctx
	if ctx == nil {
		ctx = context.Background()
	}
	for _, id := range ids {
		if ctx.Err() != nil {
			return
		}
		s.refreshAndArm(ctx, id)
	}
}

// refreshAndArm loads the account, refreshes quota windows when possible, and
// arms the reset timer. It never restores scheduling; that waits until the
// armed deadline so a refresh that races the 402 cannot undo it.
func (s *QuotaWindowRecoveryService) refreshAndArm(ctx context.Context, accountID int64) {
	account, err := s.accounts.GetByID(ctx, accountID)
	if err != nil || account == nil {
		slog.Warn("quota_window_load_failed", "account_id", accountID, "error", err)
		return
	}
	snap := parseQuotaWindowSnapshot(account.Extra)
	if fresh, fetchErr := s.fetchWindows(ctx, account); fetchErr != nil {
		slog.Warn("quota_window_fetch_failed", "account_id", accountID, "error", fetchErr)
	} else {
		snap = fresh
		s.persistWindows(ctx, account, snap)
		if tightest, ok := TightestExhaustedWindow(snap.Windows, s.now()); ok {
			if block, has := parseQuotaBlock(account.Extra); has && block.Active && !block.Revoked {
				block.WindowID = tightest.ID
				block.ResetsAt = tightest.ResetsAt.UTC()
				s.persistBlock(ctx, account, block)
			}
		}
		if reloaded, reloadErr := s.accounts.GetByID(ctx, accountID); reloadErr == nil && reloaded != nil {
			account = reloaded
		}
	}
	view := *account
	view.Extra = cloneExtraMap(account.Extra)
	if view.Extra == nil {
		view.Extra = map[string]any{}
	}
	view.Extra[QuotaWindowsExtraKey] = snap
	decision := DecideQuotaWindowRecovery(&view, s.now(), s.grace)
	switch decision.Action {
	case QuotaRecoveryWait:
		s.arm(accountID, decision.WakeAt)
	case QuotaRecoveryEnable:
		// The quota error was just recorded. Confirm after the grace instead of
		// restoring in this refresh.
		s.arm(accountID, s.now().Add(s.graceOrDefault()))
	default:
		s.disarm(accountID)
	}
}

func (s *QuotaWindowRecoveryService) loop() {
	defer s.wg.Done()
	for {
		s.drainRefreshes()
		delay, ok := s.nextDelay()
		var timer <-chan time.Time
		var stop func()
		if ok {
			clock := time.NewTimer(delay)
			timer = clock.C
			stop = func() {
				if !clock.Stop() {
					select {
					case <-clock.C:
					default:
					}
				}
			}
		}
		select {
		case <-s.ctx.Done():
			if stop != nil {
				stop()
			}
			return
		case <-s.wake:
			if stop != nil {
				stop()
			}
		case <-timer:
			s.fireDue()
		}
	}
}

func (s *QuotaWindowRecoveryService) nextDelay() (time.Duration, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var soonest time.Time
	for _, when := range s.deadlines {
		if soonest.IsZero() || when.Before(soonest) {
			soonest = when
		}
	}
	if soonest.IsZero() {
		return 0, false
	}
	delay := soonest.Sub(s.now())
	if delay < 0 {
		delay = 0
	}
	return delay, true
}

func (s *QuotaWindowRecoveryService) fireDue() {
	now := s.now()
	s.mu.Lock()
	due := make([]int64, 0, len(s.deadlines))
	for id, when := range s.deadlines {
		if !when.After(now) {
			due = append(due, id)
			delete(s.deadlines, id)
		}
	}
	s.mu.Unlock()
	for _, id := range due {
		if s.ctx.Err() != nil {
			return
		}
		s.evaluate(s.ctx, id, true)
	}
}

func (s *QuotaWindowRecoveryService) arm(accountID int64, when time.Time) {
	if s == nil || accountID <= 0 || when.IsZero() {
		return
	}
	s.mu.Lock()
	if s.deadlines == nil {
		s.deadlines = make(map[int64]time.Time)
	}
	s.deadlines[accountID] = when
	s.mu.Unlock()
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

func (s *QuotaWindowRecoveryService) disarm(accountID int64) {
	s.mu.Lock()
	delete(s.deadlines, accountID)
	s.mu.Unlock()
}

// evaluate applies the recovery decision for one account. allowEnable is false
// only for callers that must not undo a quota error they are still recording.
func (s *QuotaWindowRecoveryService) evaluate(ctx context.Context, accountID int64, allowEnable bool) {
	if s == nil || s.accounts == nil || accountID <= 0 {
		return
	}
	account, err := s.accounts.GetByID(ctx, accountID)
	if err != nil || account == nil {
		slog.Warn("quota_window_load_failed", "account_id", accountID, "error", err)
		return
	}
	snap := parseQuotaWindowSnapshot(account.Extra)
	if needsQuotaWindowRefresh(snap.Windows, s.now()) {
		if fresh, fetchErr := s.fetchWindows(ctx, account); fetchErr != nil {
			slog.Warn("quota_window_refresh_failed", "account_id", accountID, "error", fetchErr)
		} else {
			snap = fresh
			s.persistWindows(ctx, account, snap)
			if reloaded, reloadErr := s.accounts.GetByID(ctx, accountID); reloadErr == nil && reloaded != nil {
				account = reloaded
			}
		}
	}
	decision := DecideQuotaWindowRecovery(account, s.now(), s.grace)
	switch decision.Action {
	case QuotaRecoveryWait:
		s.arm(accountID, decision.WakeAt)
	case QuotaRecoveryEnable:
		if !allowEnable {
			s.arm(accountID, s.now().Add(s.graceOrDefault()))
			return
		}
		if err := s.restore(ctx, account, decision); err != nil {
			slog.Warn("quota_window_restore_failed", "account_id", accountID, "error", err)
			s.arm(accountID, s.now().Add(s.graceOrDefault()))
			return
		}
		s.disarm(accountID)
	default:
		s.disarm(accountID)
	}
}

func needsQuotaWindowRefresh(windows []QuotaWindow, now time.Time) bool {
	if len(windows) == 0 {
		return true
	}
	for _, window := range windows {
		if window.Utilization < quotaExhaustedUtilization {
			continue
		}
		if window.ResetsAt.IsZero() || !window.ResetsAt.After(now) {
			return true
		}
	}
	return false
}

func (s *QuotaWindowRecoveryService) restore(ctx context.Context, account *Account, decision QuotaRecoveryDecision) error {
	if s.recoverer != nil {
		if _, err := s.recoverer.RecoverAccountState(ctx, account.ID, AccountRecoveryOptions{}); err != nil {
			return err
		}
	}
	if decision.EnableSchedulable {
		if err := s.accounts.SetSchedulable(ctx, account.ID, true); err != nil {
			return err
		}
	}
	if err := s.accounts.UpdateExtra(ctx, account.ID, map[string]any{QuotaBlockExtraKey: nil}); err != nil {
		return err
	}
	slog.Info("quota_window_restored", "account_id", account.ID, "window_id", decision.WindowID, "schedulable", decision.EnableSchedulable)
	return nil
}
