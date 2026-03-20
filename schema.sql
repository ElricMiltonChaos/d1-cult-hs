DROP TABLE IF EXISTS Customers;

CREATE TABLE IF NOT EXISTS scores (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	normalized_name TEXT NOT NULL,
	score INTEGER NOT NULL CHECK (score >= 0),
	build_version TEXT NOT NULL,
	created_at_utc TEXT NOT NULL,
	created_at_epoch_ms INTEGER NOT NULL,
	ip_hash TEXT NOT NULL,
	rate_limit_bucket TEXT NOT NULL,
	duplicate_bucket TEXT NOT NULL,
	submission_day_utc TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_scores_leaderboard
	ON scores (score DESC, created_at_epoch_ms ASC);

CREATE INDEX IF NOT EXISTS idx_scores_day
	ON scores (submission_day_utc);

CREATE INDEX IF NOT EXISTS idx_scores_recent_by_ip
	ON scores (ip_hash, created_at_epoch_ms DESC);

CREATE UNIQUE INDEX IF NOT EXISTS ux_scores_rate_limit_bucket
	ON scores (ip_hash, rate_limit_bucket);

CREATE UNIQUE INDEX IF NOT EXISTS ux_scores_duplicate_bucket
	ON scores (ip_hash, normalized_name, score, duplicate_bucket);
