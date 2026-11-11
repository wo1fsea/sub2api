package repository

import (
	"context"
	"crypto/rand"
	"encoding/json"

	dbent "github.com/Wei-Shaw/sub2api/ent"
	"github.com/Wei-Shaw/sub2api/internal/service"
)

// These are repository-managed fields. An ordinary extra edit must neither
// restore a previous credential generation nor inject a stale quota snapshot.
func stripFactoryUsageManagedExtra(extra map[string]any) map[string]any {
	if extra == nil {
		return nil
	}
	clean := make(map[string]any, len(extra))
	for k, v := range extra {
		if k != service.FactoryUsageSnapshotExtraKey && k != service.FactoryUsageGenerationExtraKey {
			clean[k] = v
		}
	}
	return clean
}

func initializeFactoryUsageExtra(account *service.Account) {
	account.Extra = stripFactoryUsageManagedExtra(account.Extra)
	if account.Platform == service.PlatformFactory && account.Type == service.AccountTypeAPIKey {
		if account.Extra == nil {
			account.Extra = map[string]any{}
		}
		account.Extra[service.FactoryUsageGenerationExtraKey] = rand.Text()
	}
}

// Called after the common account merge has acquired its row lock. Compare key
// identity in the database; never read the old key out or derive a persisted hash.
func mergeLockedFactoryUsageExtra(ctx context.Context, client *dbent.Client, account *service.Account, extra map[string]any) (map[string]any, error) {
	extra = stripFactoryUsageManagedExtra(extra)
	if account.Platform != service.PlatformFactory || account.Type != service.AccountTypeAPIKey {
		return extra, nil
	}
	credentials, err := json.Marshal(normalizeJSONMap(account.Credentials))
	if err != nil {
		return nil, err
	}
	rows, err := client.QueryContext(ctx, `SELECT
		platform='factory' AND type='apikey' AND credentials->'api_key' IS NOT DISTINCT FROM $2::jsonb->'api_key',
		extra->'factory_usage_generation', extra->'factory_usage_snapshot'
		FROM accounts WHERE id=$1 AND deleted_at IS NULL FOR NO KEY UPDATE`, account.ID, string(credentials))
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return nil, err
		}
		return nil, service.ErrAccountNotFound
	}
	var unchanged bool
	var generation, snapshot []byte
	if err := rows.Scan(&unchanged, &generation, &snapshot); err != nil {
		return nil, err
	}
	if extra == nil {
		extra = map[string]any{}
	}
	if unchanged {
		for key, raw := range map[string][]byte{service.FactoryUsageGenerationExtraKey: generation, service.FactoryUsageSnapshotExtraKey: snapshot} {
			value, present, err := decodeAccountExtraJSON(raw)
			if err != nil {
				return nil, err
			}
			if present {
				extra[key] = value
			}
		}
	} else {
		extra[service.FactoryUsageGenerationExtraKey] = rand.Text()
	}
	return extra, rows.Err()
}

// Compare-and-swap gates both successful samples and backoff writes. A response
// started with an old credential can never overwrite the new account's state.
func (r *accountRepository) UpdateFactoryUsageSnapshot(ctx context.Context, id int64, generation string, snapshot any) (bool, error) {
	if scoped := r.accountTransactionScope(ctx); scoped != r {
		return scoped.UpdateFactoryUsageSnapshot(ctx, id, generation, snapshot)
	}
	payload, err := json.Marshal(snapshot)
	if err != nil {
		return false, err
	}
	client := clientFromContext(ctx, r.client)
	result, err := client.ExecContext(ctx, `UPDATE accounts
		SET extra=jsonb_set(COALESCE(extra,'{}'::jsonb),'{factory_usage_snapshot}',$1::jsonb,true),updated_at=NOW()
		WHERE id=$2 AND deleted_at IS NULL AND platform='factory' AND type='apikey'
		AND COALESCE(extra->>'factory_usage_generation','')=$3`, string(payload), id, generation)
	if err != nil {
		return false, err
	}
	count, err := result.RowsAffected()
	return count == 1, err
}
