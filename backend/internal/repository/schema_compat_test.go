package repository

import (
	"context"
	"database/sql"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	sqlmock "github.com/DATA-DOG/go-sqlmock"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/Wei-Shaw/sub2api/migrations"
	"github.com/stretchr/testify/require"
)

func useSchemaCapabilities(t *testing.T, caps schemaCapabilities) {
	t.Helper()
	prev := schemaCaps.Load()
	schemaCaps.Store(&caps)
	t.Cleanup(func() { schemaCaps.Store(prev) })
}

func TestShouldDeferHotCutoverMigrations(t *testing.T) {
	require.False(t, shouldDeferHotCutoverMigrations(nil))
	require.False(t, shouldDeferHotCutoverMigrations(map[string]struct{}{}))

	applied248 := map[string]struct{}{"248_group_image_count_billing.sql": {}}
	require.True(t, shouldDeferHotCutoverMigrations(applied248))

	partial := map[string]struct{}{
		"248_group_image_count_billing.sql": {},
		mcpOAuthMigration:                   {},
	}
	require.True(t, shouldDeferHotCutoverMigrations(partial))

	complete := map[string]struct{}{
		"248_group_image_count_billing.sql": {},
		usageLogsAPIKeyCostIndexMigration:   {},
		mcpOAuthMigration:                   {},
		openAICacheWriteTTLMigration:        {},
	}
	require.False(t, shouldDeferHotCutoverMigrations(complete))
}

func TestEmbeddedHotCutoverMigrationsMatchDeferredNames(t *testing.T) {
	_, err := migrations.FS.Open("248_group_image_count_billing.sql")
	require.NoError(t, err)
	for name := range hotCutoverDeferredMigrations {
		_, err := migrations.FS.Open(name)
		require.NoError(t, err, name)
	}
}

func TestApplyMigrationsFS_ExistingSchemaSkipsUnapplied249And250(t *testing.T) {
	db, mock, err := sqlmock.New()
	require.NoError(t, err)
	defer func() { _ = db.Close() }()

	const appliedSQL = "SELECT 1;"
	const recordedMCPOAuth = "CREATE TABLE mcp_oauth_grants (id text);"
	prepareMigrationsBootstrapExpectationsApplied(mock, []string{
		"248_group_image_count_billing.sql",
		mcpOAuthMigration,
	})
	mock.ExpectQuery("SELECT checksum FROM schema_migrations WHERE filename = \\$1").
		WithArgs("248_group_image_count_billing.sql").
		WillReturnRows(sqlmock.NewRows([]string{"checksum"}).AddRow(migrationChecksum(appliedSQL)))
	mock.ExpectQuery("SELECT checksum FROM schema_migrations WHERE filename = \\$1").
		WithArgs(mcpOAuthMigration).
		WillReturnRows(sqlmock.NewRows([]string{"checksum"}).AddRow(migrationChecksum(recordedMCPOAuth)))
	mock.ExpectExec("SELECT pg_advisory_unlock\\(\\$1\\)").
		WithArgs(migrationsAdvisoryLockID).
		WillReturnResult(sqlmock.NewResult(0, 1))

	fsys := fstest.MapFS{
		"248_group_image_count_billing.sql": {Data: []byte(appliedSQL)},
		usageLogsAPIKeyCostIndexMigration: {Data: []byte(
			"CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_usage_logs_api_key_created_cost ON usage_logs (api_key_id, created_at) INCLUDE (actual_cost);",
		)},
		mcpOAuthMigration:            {Data: []byte(recordedMCPOAuth)},
		openAICacheWriteTTLMigration: {Data: []byte("ALTER TABLE usage_logs ADD COLUMN cache_creation_30m_tokens integer;")},
	}

	require.NoError(t, applyMigrationsFS(context.Background(), db, fsys))
	require.NoError(t, mock.ExpectationsWereMet())
}

func TestApplyMigrationsFS_FreshDatabaseStillApplies250(t *testing.T) {
	db, mock, err := sqlmock.New()
	require.NoError(t, err)
	defer func() { _ = db.Close() }()

	const migrationSQL = "ALTER TABLE usage_logs ADD COLUMN cache_creation_30m_tokens integer;"
	prepareMigrationsBootstrapExpectations(mock)
	mock.ExpectQuery("SELECT checksum FROM schema_migrations WHERE filename = \\$1").
		WithArgs(openAICacheWriteTTLMigration).
		WillReturnError(sql.ErrNoRows)
	mock.ExpectBegin()
	mock.ExpectExec("ALTER TABLE usage_logs ADD COLUMN cache_creation_30m_tokens integer").
		WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectExec("INSERT INTO schema_migrations \\(filename, checksum\\) VALUES \\(\\$1, \\$2\\)").
		WithArgs(openAICacheWriteTTLMigration, migrationChecksum(migrationSQL)).
		WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectCommit()
	mock.ExpectExec("SELECT pg_advisory_unlock\\(\\$1\\)").
		WithArgs(migrationsAdvisoryLockID).
		WillReturnResult(sqlmock.NewResult(0, 1))

	fsys := fstest.MapFS{
		openAICacheWriteTTLMigration: {Data: []byte(migrationSQL)},
	}
	require.NoError(t, applyMigrationsFS(context.Background(), db, fsys))
	require.NoError(t, mock.ExpectationsWereMet())
}

func TestInitializeRuntimeSchema_Existing248DoesNotRequire249Or250(t *testing.T) {
	prev := schemaCaps.Load()
	t.Cleanup(func() { schemaCaps.Store(prev) })

	db, mock, err := sqlmock.New()
	require.NoError(t, err)
	defer func() { _ = db.Close() }()

	const appliedSQL = "SELECT 1;"
	prepareMigrationsBootstrapExpectationsApplied(mock, []string{"248_group_image_count_billing.sql"})
	mock.ExpectQuery("SELECT checksum FROM schema_migrations WHERE filename = \\$1").
		WithArgs("248_group_image_count_billing.sql").
		WillReturnRows(sqlmock.NewRows([]string{"checksum"}).AddRow(migrationChecksum(appliedSQL)))
	mock.ExpectExec("SELECT pg_advisory_unlock\\(\\$1\\)").
		WithArgs(migrationsAdvisoryLockID).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectQuery("information_schema.columns").
		WillReturnRows(sqlmock.NewRows([]string{"usage_ttl", "cache_write_12h", "mcp"}).AddRow(false, false, false))

	fsys := fstest.MapFS{
		"248_group_image_count_billing.sql": {Data: []byte(appliedSQL)},
		usageLogsAPIKeyCostIndexMigration:   {Data: []byte("CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_usage_logs_api_key_created_cost ON usage_logs (api_key_id) INCLUDE (actual_cost);")},
		mcpOAuthMigration:                   {Data: []byte("CREATE TABLE mcp_oauth_grants (id text);")},
		openAICacheWriteTTLMigration:        {Data: []byte("ALTER TABLE usage_logs ADD COLUMN cache_creation_30m_tokens integer;")},
	}
	require.NoError(t, initializeRuntimeSchema(context.Background(), db, fsys))
	require.NoError(t, mock.ExpectationsWereMet())

	caps := schemaCaps.Load()
	require.NotNil(t, caps)
	require.False(t, caps.usageLogCacheTTLColumns)
	require.False(t, caps.channelCacheWrite12hPrice)
	require.False(t, caps.mcpOAuthTables)

	createdAt := time.Date(2026, 11, 11, 12, 0, 0, 0, time.UTC)
	log := &service.UsageLog{
		UserID:                 1,
		APIKeyID:               2,
		AccountID:              3,
		RequestID:              "req-248-compat",
		Model:                  "gpt-5",
		CacheCreation30mTokens: 9,
		CacheCreation12hTokens: 2390,
		CreatedAt:              createdAt,
	}
	prepared := prepareUsageLogInsert(log)
	require.Len(t, prepared.args, len(usageLogInsertArgTypes)-2)
	require.Equal(t, createdAt, prepared.args[len(prepared.args)-1])
	require.NotContains(t, prepared.args, 9)
	require.NotContains(t, prepared.args, 2390)

	var captured []string
	sqlDB, insertMock := captureUsageLogSQL(t, &captured)
	repo := &usageLogRepository{sql: sqlDB}
	insertMock.ExpectQuery("INSERT INTO usage_logs").
		WithArgs(anySliceToDriverValues(prepared.args)...).
		WillReturnRows(sqlmock.NewRows([]string{"id", "created_at"}).AddRow(int64(1), createdAt))
	inserted, err := repo.createSingle(context.Background(), sqlDB, log)
	require.NoError(t, err)
	require.True(t, inserted)
	require.Len(t, captured, 1)
	require.NotContains(t, captured[0], "cache_creation_30m_tokens")
	require.NotContains(t, captured[0], "cache_creation_12h_tokens")
	require.Contains(t, captured[0], "native_compaction_v2")
	require.Contains(t, captured[0], "created_at")
	assertUsageLogInsertShape(t, captured[0], len(prepared.args))

	query, args := buildUsageLogBestEffortInsertQuery([]usageLogInsertPrepared{prepared})
	require.NotContains(t, query, "cache_creation_30m_tokens")
	require.NotContains(t, query, "cache_creation_12h_tokens")
	require.Contains(t, query, "::timestamptz")
	require.Len(t, args, len(prepared.args))

	require.NotContains(t, usageLogSelectColumns(), "cache_creation_30m_tokens")
	require.NotContains(t, usageLogSelectColumns(), "cache_creation_12h_tokens")
	require.Contains(t, usageLogSelectColumns(), "created_at")
	scanner := &countScanner{}
	require.NoError(t, scanInto(scanner))
	require.Equal(t, len(strings.Split(usageLogSelectColumns(), ", ")), scanner.n)

	price := 1.25
	updateSQL, updateArgs := omitChannelCacheWrite12h(
		`UPDATE channel_model_pricing SET cache_write_price = $5, cache_write_1h_price = $6, cache_write_12h_price = $7, cache_read_price = $8 WHERE id = $17`,
		[]any{"m", "mode", 1, 2, 3, 4, &price, 5, "rest", 17},
		7,
	)
	require.NotContains(t, updateSQL, "cache_write_12h_price")
	require.Contains(t, updateSQL, "cache_read_price = $7")
	require.Contains(t, updateSQL, "WHERE id = $16")
	require.NotContains(t, updateArgs, &price)

	insertSQL, _ := omitChannelCacheWrite12h(
		`INSERT INTO channel_model_pricing (cache_write_price, cache_write_1h_price, cache_write_12h_price, cache_read_price) VALUES ($7, $8, $9, $10)`,
		[]any{1, 2, 3, 4, 5, 6, 7, 8, &price, 10},
		9,
	)
	require.NotContains(t, insertSQL, "cache_write_12h_price")
	require.Contains(t, insertSQL, "VALUES ($7, $8, $9)")

	repoOAuth := NewMCPOAuthRepository(nil, db)
	require.ErrorIs(t, repoOAuth.CreateAuthorization(context.Background(), &service.MCPOAuthGrant{}, &service.MCPOAuthCode{}, 1), service.ErrMCPOAuthUnavailable)
	require.NoError(t, revokeMCPGrants(context.Background(), db, 8, false, time.Now()))
}

func TestUsageLogSelectAndScanStayAlignedWhenCacheTTLColumnsExist(t *testing.T) {
	useSchemaCapabilities(t, schemaCapabilities{
		usageLogCacheTTLColumns:   true,
		channelCacheWrite12hPrice: true,
		mcpOAuthTables:            true,
	})
	require.Contains(t, usageLogSelectColumns(), "cache_creation_30m_tokens")
	require.Contains(t, usageLogSelectColumns(), "cache_creation_12h_tokens")
	scanner := &countScanner{}
	require.NoError(t, scanInto(scanner))
	require.Equal(t, len(strings.Split(usageLogSelectColumns(), ", ")), scanner.n)
	require.Equal(t, len(usageLogInsertArgTypes), len(activeUsageLogInsertArgTypes()))
}

func TestLatestMigrationBaselineExceptSkipsDeferredFiles(t *testing.T) {
	fsys := fstest.MapFS{
		"248_group_image_count_billing.sql": {Data: []byte("SELECT 248;")},
		openAICacheWriteTTLMigration:        {Data: []byte("SELECT 250;")},
	}
	version, _, _, err := latestMigrationBaselineExcept(fsys, hotCutoverDeferredMigrations)
	require.NoError(t, err)
	require.Equal(t, "248_group_image_count_billing", version)
}

func captureUsageLogSQL(t *testing.T, captured *[]string) (*sql.DB, sqlmock.Sqlmock) {
	t.Helper()
	matcher := sqlmock.QueryMatcherFunc(func(_, actualSQL string) error {
		*captured = append(*captured, actualSQL)
		return nil
	})
	db, mock, err := sqlmock.New(sqlmock.QueryMatcherOption(matcher))
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })
	return db, mock
}

func assertUsageLogInsertShape(t *testing.T, query string, want int) {
	t.Helper()
	shape := regexp.MustCompile(`(?s)INSERT INTO usage_logs \((.*?)\) VALUES \((.*?)\)`)
	match := shape.FindStringSubmatch(query)
	require.Len(t, match, 3, query)
	columns := 0
	for _, column := range strings.Split(match[1], ",") {
		if strings.TrimSpace(column) != "" {
			columns++
		}
	}
	require.Equal(t, want, columns)
	seen := map[int]struct{}{}
	for _, ph := range regexp.MustCompile(`\$(\d+)`).FindAllStringSubmatch(match[2], -1) {
		n, err := strconv.Atoi(ph[1])
		require.NoError(t, err)
		_, dup := seen[n]
		require.False(t, dup)
		seen[n] = struct{}{}
	}
	require.Len(t, seen, want)
}

type countScanner struct {
	n int
}

func (c *countScanner) Scan(dest ...any) error {
	c.n = len(dest)
	return nil
}

func scanInto(scanner interface{ Scan(...any) error }) error {
	_, err := scanUsageLog(scanner)
	return err
}
