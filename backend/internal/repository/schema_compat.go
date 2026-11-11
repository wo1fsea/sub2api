package repository

import (
	"context"
	"database/sql"
	"fmt"
	"io/fs"
	"regexp"
	"strconv"
	"strings"
	"sync/atomic"

	"github.com/Wei-Shaw/sub2api/internal/pkg/logger"
)

// schemaCapabilities records objects introduced by migrations 249 and 250.
// The live 0.2.19 database stops at 248_group_image_count_billing.sql, so a
// hot cutover must serve traffic without those objects. Fresh databases still
// apply the migrations and keep every capability enabled.
type schemaCapabilities struct {
	usageLogCacheTTLColumns   bool
	channelCacheWrite12hPrice bool
	mcpOAuthTables            bool
}

// Default to the full 0.2.21 column set so unit tests and any path that has
// not probed yet keep today's SQL. InitEnt probes before the server accepts
// traffic and narrows this when the live schema is still at 248.
var schemaCaps atomic.Pointer[schemaCapabilities]

func init() {
	schemaCaps.Store(&schemaCapabilities{
		usageLogCacheTTLColumns:   true,
		channelCacheWrite12hPrice: true,
		mcpOAuthTables:            true,
	})
}

func schemaHasUsageLogCacheTTLColumns() bool {
	caps := schemaCaps.Load()
	return caps != nil && caps.usageLogCacheTTLColumns
}

func schemaHasChannelCacheWrite12hPrice() bool {
	caps := schemaCaps.Load()
	return caps != nil && caps.channelCacheWrite12hPrice
}

func schemaHasMCPOAuthTables() bool {
	caps := schemaCaps.Load()
	return caps != nil && caps.mcpOAuthTables
}

const schemaCapabilityProbeSQL = `
SELECT
	(EXISTS (
		SELECT 1 FROM information_schema.columns
		WHERE table_schema = 'public' AND table_name = 'usage_logs' AND column_name = 'cache_creation_30m_tokens'
	) AND EXISTS (
		SELECT 1 FROM information_schema.columns
		WHERE table_schema = 'public' AND table_name = 'usage_logs' AND column_name = 'cache_creation_12h_tokens'
	)),
	(EXISTS (
		SELECT 1 FROM information_schema.columns
		WHERE table_schema = 'public' AND table_name = 'channel_model_pricing' AND column_name = 'cache_write_12h_price'
	) AND EXISTS (
		SELECT 1 FROM information_schema.columns
		WHERE table_schema = 'public' AND table_name = 'channel_pricing_intervals' AND column_name = 'cache_write_12h_price'
	) AND EXISTS (
		SELECT 1 FROM information_schema.columns
		WHERE table_schema = 'public' AND table_name = 'channel_account_stats_model_pricing' AND column_name = 'cache_write_12h_price'
	) AND EXISTS (
		SELECT 1 FROM information_schema.columns
		WHERE table_schema = 'public' AND table_name = 'channel_account_stats_pricing_intervals' AND column_name = 'cache_write_12h_price'
	)),
	(EXISTS (
		SELECT 1 FROM information_schema.tables
		WHERE table_schema = 'public' AND table_name = 'mcp_oauth_grants'
	) AND EXISTS (
		SELECT 1 FROM information_schema.tables
		WHERE table_schema = 'public' AND table_name = 'mcp_oauth_codes'
	) AND EXISTS (
		SELECT 1 FROM information_schema.tables
		WHERE table_schema = 'public' AND table_name = 'mcp_oauth_credentials'
	))
`

// initializeRuntimeSchema applies embedded migrations, then records which
// 249/250 objects actually exist. Existing databases that have not yet applied
// those files do not receive them here.
func initializeRuntimeSchema(ctx context.Context, db *sql.DB, fsys fs.FS) error {
	if err := applyMigrationsFS(ctx, db, fsys); err != nil {
		return err
	}
	return detectAndStoreSchemaCapabilities(ctx, db)
}

func detectAndStoreSchemaCapabilities(ctx context.Context, db *sql.DB) error {
	if db == nil {
		return fmt.Errorf("detect schema capabilities: nil sql db")
	}
	var usageTTL, cacheWrite12h, mcpTables bool
	if err := db.QueryRowContext(ctx, schemaCapabilityProbeSQL).Scan(&usageTTL, &cacheWrite12h, &mcpTables); err != nil {
		return fmt.Errorf("detect schema capabilities: %w", err)
	}
	schemaCaps.Store(&schemaCapabilities{
		usageLogCacheTTLColumns:   usageTTL,
		channelCacheWrite12hPrice: cacheWrite12h,
		mcpOAuthTables:            mcpTables,
	})
	if !usageTTL || !cacheWrite12h || !mcpTables {
		logger.LegacyPrintf(
			"repository.schema",
			"serving without post-248 schema objects: usage_log_cache_ttl=%t channel_cache_write_12h=%t mcp_oauth=%t",
			usageTTL, cacheWrite12h, mcpTables,
		)
	}
	return nil
}

var sqlPlaceholderRe = regexp.MustCompile(`\$(\d+)`)

// omitChannelCacheWrite12h drops cache_write_12h_price from a pricing statement
// and removes the matching argument. placeholder is the 1-based $N of that
// value; 0 means the statement only projects the column.
func omitChannelCacheWrite12h(query string, args []any, placeholder int) (string, []any) {
	if schemaHasChannelCacheWrite12hPrice() {
		return query, args
	}
	if placeholder > 0 {
		assignment := fmt.Sprintf("cache_write_12h_price = $%d, ", placeholder)
		if strings.Contains(query, assignment) {
			query = strings.Replace(query, assignment, "", 1)
			query = renumberPlaceholdersAbove(query, placeholder)
		} else {
			query = strings.ReplaceAll(query, ", cache_write_12h_price", "")
			query = dropIndexedPlaceholder(query, placeholder)
		}
		idx := placeholder - 1
		if idx >= 0 && idx < len(args) {
			next := make([]any, 0, len(args)-1)
			next = append(next, args[:idx]...)
			next = append(next, args[idx+1:]...)
			args = next
		}
		return query, args
	}
	return strings.ReplaceAll(query, ", cache_write_12h_price", ""), args
}

func dropIndexedPlaceholder(query string, index int) string {
	matches := sqlPlaceholderRe.FindAllStringSubmatchIndex(query, -1)
	start, end := -1, -1
	for _, match := range matches {
		n, err := strconv.Atoi(query[match[2]:match[3]])
		if err != nil || n != index {
			continue
		}
		start, end = match[0], match[1]
		break
	}
	if start < 0 {
		return query
	}
	if start >= 2 && query[start-2:start] == ", " {
		start -= 2
	} else if end+2 <= len(query) && query[end:end+2] == ", " {
		end += 2
	}
	return renumberPlaceholdersAbove(query[:start]+query[end:], index)
}

func renumberPlaceholdersAbove(query string, index int) string {
	return sqlPlaceholderRe.ReplaceAllStringFunc(query, func(token string) string {
		n, err := strconv.Atoi(token[1:])
		if err != nil || n <= index {
			return token
		}
		return "$" + strconv.Itoa(n-1)
	})
}

func appendIfChannelCacheWrite12h(dest []any, value any) []any {
	if schemaHasChannelCacheWrite12hPrice() {
		dest = append(dest, value)
	}
	return dest
}
