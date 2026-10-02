SELECT json_build_object(
  'enabledScheduledTests', (SELECT count(*) FROM scheduled_test_plans WHERE enabled),
  'enabledChannelMonitors', (SELECT count(*) FROM channel_monitors WHERE enabled),
  'enabledChannelMonitorV2Configs', (SELECT count(*) FROM channel_monitor_v2_config WHERE enabled),
  'backupScheduleEnabled', coalesce((SELECT (value::jsonb->>'enabled')::boolean FROM settings WHERE key='backup_schedule'), false),
  'activeBackupOperations', (SELECT count(*) FROM jsonb_array_elements(coalesce((SELECT value::jsonb FROM settings WHERE key='backup_records'), '[]'::jsonb)) r WHERE r->>'status' IN ('pending','running') OR r->>'restore_status'='running'),
  'schedulingThresholdOverrides', (SELECT count(*) FROM accounts WHERE deleted_at IS NULL AND credentials ? 'account_scheduling_threshold'),
  'rpmOverrides', (SELECT count(*) FROM accounts WHERE deleted_at IS NULL AND extra ? 'base_rpm'),
  'accountPlatforms', (SELECT coalesce(json_agg(t), '[]'::json) FROM (SELECT platform, type, count(*) AS count FROM accounts WHERE deleted_at IS NULL GROUP BY platform, type ORDER BY platform, type) t)
);
