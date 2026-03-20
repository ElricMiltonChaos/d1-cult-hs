type LeaderboardEnv = Env & {
	CORS_ALLOW_ORIGIN?: string;
	DAILY_SUBMISSION_BUDGET?: string;
	DUPLICATE_WINDOW_SECONDS?: string;
	IP_HASH_SALT?: string;
	LEADERBOARD_LIMIT?: string;
	LEADERBOARD_MAX_NAME_LENGTH?: string;
	SUBMISSION_RATE_LIMIT_SECONDS?: string;
};

type HighScoreSubmitRequest = {
	name?: unknown;
	score?: unknown;
	buildVersion?: unknown;
};

type HighScoreEntry = {
	id: string;
	name: string;
	score: number;
	createdAtUtc: string;
};

type HighScoreRow = {
	id: string;
	name: string;
	score: number;
	created_at_utc: string;
};

type RuntimeSettings = {
	corsAllowOrigin: string;
	dailySubmissionBudget: number;
	duplicateWindowSeconds: number;
	ipHashSalt: string;
	leaderboardLimit: number;
	maxNameLength: number;
	submissionRateLimitSeconds: number;
};

const DEFAULT_CORS_ALLOW_ORIGIN = '*';
const DEFAULT_DAILY_SUBMISSION_BUDGET = 250;
const DEFAULT_DUPLICATE_WINDOW_SECONDS = 300;
const DEFAULT_LEADERBOARD_LIMIT = 100;
const DEFAULT_MAX_NAME_LENGTH = 12;
const DEFAULT_SUBMISSION_RATE_LIMIT_SECONDS = 10;
const MAX_BUILD_VERSION_LENGTH = 64;
const MAX_LEADERBOARD_LIMIT = 100;
const ALLOWED_NAME_REGEX = /^[\p{L}\p{N} _-]+$/u;
const WHITESPACE_REGEX = /\s+/gu;

export default {
	async fetch(request, env): Promise<Response> {
		const runtimeEnv = env as LeaderboardEnv;
		const settings = getRuntimeSettings(runtimeEnv);
		const url = new URL(request.url);

		if (request.method === 'OPTIONS') {
			return new Response(null, {
				status: 204,
				headers: buildCorsHeaders(settings),
			});
		}

		try {
			if (url.pathname === '/') {
				return jsonResponse(
					{
						service: 'cult-highscores',
						endpoints: ['/scores'],
					},
					200,
					settings,
				);
			}

			if (url.pathname === '/scores') {
				if (request.method === 'GET') {
					return handleGetScores(url, runtimeEnv, settings);
				}

				if (request.method === 'POST') {
					return handlePostScore(request, runtimeEnv, settings);
				}

				return errorResponse('invalid_method', 405, settings);
			}

			return errorResponse('not_found', 404, settings);
		} catch (error) {
			console.error('Leaderboard request failed.', error);
			return errorResponse(resolveServerErrorCode(error), 503, settings);
		}
	},
} satisfies ExportedHandler<LeaderboardEnv>;

async function handleGetScores(url: URL, env: LeaderboardEnv, settings: RuntimeSettings): Promise<Response> {
	const limit = clampLeaderboardLimit(url.searchParams.get('limit'), settings.leaderboardLimit);
	const entries = await fetchLeaderboardEntries(env, limit);
	return jsonResponse({ entries }, 200, settings);
}

async function handlePostScore(request: Request, env: LeaderboardEnv, settings: RuntimeSettings): Promise<Response> {
	const payload = await parseJsonRequest(request);
	if (!payload.ok) {
		return errorResponse('invalid_request', 400, settings);
	}

	const normalized = normalizeSubmission(payload.value, settings.maxNameLength);
	if (!normalized.ok) {
		return errorResponse(normalized.error, 400, settings);
	}

	const clientIpHash = await hashClientIdentifier(resolveClientIp(request), settings.ipHashSalt);
	const now = new Date();
	const nowEpochMs = now.getTime();
	const createdAtUtc = now.toISOString();
	const submissionDayUtc = createdAtUtc.slice(0, 10);

	const dailyBudgetUsed = await countDailySubmissions(env, submissionDayUtc);
	if (dailyBudgetUsed >= settings.dailySubmissionBudget) {
		return errorResponse('leaderboard_full_today', 429, settings);
	}

	const duplicateCutoff = nowEpochMs - settings.duplicateWindowSeconds * 1000;
	if (await hasRecentDuplicate(env, clientIpHash, normalized.nameKey, normalized.score, duplicateCutoff)) {
		return errorResponse('duplicate_recent', 429, settings);
	}

	const rateLimitCutoff = nowEpochMs - settings.submissionRateLimitSeconds * 1000;
	if (await hasRecentSubmission(env, clientIpHash, rateLimitCutoff)) {
		return errorResponse('rate_limited', 429, settings);
	}

	const submittedEntry: HighScoreEntry = {
		id: crypto.randomUUID(),
		name: normalized.displayName,
		score: normalized.score,
		createdAtUtc,
	};

	const rateLimitBucket = buildTimeBucket(nowEpochMs, settings.submissionRateLimitSeconds);
	const duplicateBucket = buildTimeBucket(nowEpochMs, settings.duplicateWindowSeconds);

	try {
		await env.DB.prepare(
			`INSERT INTO scores (
				id,
				name,
				normalized_name,
				score,
				build_version,
				created_at_utc,
				created_at_epoch_ms,
				ip_hash,
				rate_limit_bucket,
				duplicate_bucket,
				submission_day_utc
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)
			.bind(
				submittedEntry.id,
				submittedEntry.name,
				normalized.nameKey,
				submittedEntry.score,
				normalized.buildVersion,
				submittedEntry.createdAtUtc,
				nowEpochMs,
				clientIpHash,
				rateLimitBucket,
				duplicateBucket,
				submissionDayUtc,
			)
			.run();
	} catch (error) {
		console.error('Failed to insert leaderboard score.', error);
		const errorCode = resolveInsertErrorCode(error);
		const status = errorCode === 'duplicate_recent' || errorCode === 'rate_limited' ? 429 : 503;
		return errorResponse(errorCode, status, settings);
	}

	const entries = await fetchLeaderboardEntries(env, settings.leaderboardLimit);
	return jsonResponse({ submittedEntry, entries }, 200, settings);
}

async function fetchLeaderboardEntries(env: LeaderboardEnv, limit: number): Promise<HighScoreEntry[]> {
	const statement = env.DB.prepare(
		`SELECT id, name, score, created_at_utc
		FROM scores
		ORDER BY score DESC, created_at_epoch_ms ASC
		LIMIT ?`
	).bind(limit);
	const result = await statement.all<HighScoreRow>();
	return (result.results ?? []).map(mapHighScoreRow);
}

async function countDailySubmissions(env: LeaderboardEnv, submissionDayUtc: string): Promise<number> {
	const result = await env.DB.prepare(
		`SELECT COUNT(*) AS total
		FROM scores
		WHERE submission_day_utc = ?`
	)
		.bind(submissionDayUtc)
		.all<{ total: number }>();

	return toSafeInteger(result.results?.[0]?.total);
}

async function hasRecentDuplicate(
	env: LeaderboardEnv,
	clientIpHash: string,
	normalizedName: string,
	score: number,
	cutoffEpochMs: number,
): Promise<boolean> {
	const result = await env.DB.prepare(
		`SELECT 1 AS found
		FROM scores
		WHERE ip_hash = ?
			AND normalized_name = ?
			AND score = ?
			AND created_at_epoch_ms >= ?
		LIMIT 1`
	)
		.bind(clientIpHash, normalizedName, score, cutoffEpochMs)
		.all<{ found: number }>();

	return (result.results?.length ?? 0) > 0;
}

async function hasRecentSubmission(env: LeaderboardEnv, clientIpHash: string, cutoffEpochMs: number): Promise<boolean> {
	const result = await env.DB.prepare(
		`SELECT 1 AS found
		FROM scores
		WHERE ip_hash = ?
			AND created_at_epoch_ms >= ?
		LIMIT 1`
	)
		.bind(clientIpHash, cutoffEpochMs)
		.all<{ found: number }>();

	return (result.results?.length ?? 0) > 0;
}

async function parseJsonRequest(request: Request): Promise<{ ok: true; value: HighScoreSubmitRequest } | { ok: false }> {
	try {
		const value = (await request.json()) as HighScoreSubmitRequest;
		if (value && typeof value === 'object') {
			return { ok: true, value };
		}
	} catch {
	}

	return { ok: false };
}

function normalizeSubmission(
	payload: HighScoreSubmitRequest,
	maxNameLength: number,
):
	| { ok: true; buildVersion: string; displayName: string; nameKey: string; score: number }
	| { ok: false; error: string } {
	if (typeof payload.name !== 'string') {
		return { ok: false, error: 'invalid_name' };
	}

	const displayName = collapseWhitespace(payload.name);
	if (!displayName) {
		return { ok: false, error: 'invalid_name' };
	}

	if (displayName.length > maxNameLength) {
		return { ok: false, error: 'name_too_long' };
	}

	if (!ALLOWED_NAME_REGEX.test(displayName)) {
		return { ok: false, error: 'invalid_name' };
	}

	if (!Number.isInteger(payload.score) || Number(payload.score) < 0) {
		return { ok: false, error: 'invalid_score' };
	}

	return {
		ok: true,
		buildVersion: normalizeBuildVersion(payload.buildVersion),
		displayName,
		nameKey: displayName,
		score: Number(payload.score),
	};
}

function collapseWhitespace(value: string): string {
	return value.trim().replace(WHITESPACE_REGEX, ' ');
}

function normalizeBuildVersion(value: unknown): string {
	if (typeof value !== 'string') {
		return 'dev';
	}

	const trimmed = value.trim();
	if (!trimmed) {
		return 'dev';
	}

	return trimmed.slice(0, MAX_BUILD_VERSION_LENGTH);
}

function clampLeaderboardLimit(rawLimit: string | null, defaultLimit: number): number {
	if (!rawLimit) {
		return defaultLimit;
	}

	const parsed = Number.parseInt(rawLimit, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		return defaultLimit;
	}

	return Math.min(parsed, defaultLimit);
}

function buildTimeBucket(nowEpochMs: number, windowSeconds: number): string {
	const safeWindowMs = Math.max(1, windowSeconds) * 1000;
	return String(Math.floor(nowEpochMs / safeWindowMs));
}

function getRuntimeSettings(env: LeaderboardEnv): RuntimeSettings {
	return {
		corsAllowOrigin: (env.CORS_ALLOW_ORIGIN ?? DEFAULT_CORS_ALLOW_ORIGIN).trim() || DEFAULT_CORS_ALLOW_ORIGIN,
		dailySubmissionBudget: resolvePositiveInt(env.DAILY_SUBMISSION_BUDGET, DEFAULT_DAILY_SUBMISSION_BUDGET),
		duplicateWindowSeconds: resolvePositiveInt(env.DUPLICATE_WINDOW_SECONDS, DEFAULT_DUPLICATE_WINDOW_SECONDS),
		ipHashSalt: env.IP_HASH_SALT ?? '',
		leaderboardLimit: resolvePositiveInt(env.LEADERBOARD_LIMIT, DEFAULT_LEADERBOARD_LIMIT, MAX_LEADERBOARD_LIMIT),
		maxNameLength: resolvePositiveInt(env.LEADERBOARD_MAX_NAME_LENGTH, DEFAULT_MAX_NAME_LENGTH, DEFAULT_MAX_NAME_LENGTH),
		submissionRateLimitSeconds: resolvePositiveInt(
			env.SUBMISSION_RATE_LIMIT_SECONDS,
			DEFAULT_SUBMISSION_RATE_LIMIT_SECONDS,
		),
	};
}

function resolvePositiveInt(rawValue: string | undefined, fallbackValue: number, maxValue = Number.MAX_SAFE_INTEGER): number {
	if (!rawValue) {
		return fallbackValue;
	}

	const parsed = Number.parseInt(rawValue, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		return fallbackValue;
	}

	return Math.min(parsed, maxValue);
}

function resolveClientIp(request: Request): string {
	const forwarded = request.headers.get('CF-Connecting-IP') ?? request.headers.get('X-Forwarded-For') ?? '';
	if (forwarded.trim()) {
		return forwarded.split(',')[0]?.trim() ?? 'unknown';
	}

	return 'unknown';
}

async function hashClientIdentifier(value: string, salt: string): Promise<string> {
	const bytes = new TextEncoder().encode(`${salt}:${value}`);
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function mapHighScoreRow(row: HighScoreRow): HighScoreEntry {
	return {
		id: row.id,
		name: row.name,
		score: toSafeInteger(row.score),
		createdAtUtc: row.created_at_utc,
	};
}

function toSafeInteger(value: unknown): number {
	if (typeof value === 'number' && Number.isFinite(value)) {
		return Math.trunc(value);
	}

	if (typeof value === 'string' && value.trim()) {
		const parsed = Number.parseInt(value, 10);
		if (Number.isFinite(parsed)) {
			return parsed;
		}
	}

	return 0;
}

function resolveInsertErrorCode(error: unknown): string {
	const message = stringifyError(error).toLowerCase();
	if (message.includes('scores.ip_hash, scores.normalized_name, scores.score, scores.duplicate_bucket')) {
		return 'duplicate_recent';
	}

	if (message.includes('scores.ip_hash, scores.rate_limit_bucket')) {
		return 'rate_limited';
	}

	return resolveServerErrorCode(error);
}

function resolveServerErrorCode(error: unknown): string {
	const message = stringifyError(error).toLowerCase();
	if (message.includes('budget') || message.includes('quota') || message.includes('limit exceeded')) {
		return 'request_budget_exceeded';
	}

	return 'request_budget_exceeded';
}

function stringifyError(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}

	return String(error ?? '');
}

function errorResponse(error: string, status: number, settings: RuntimeSettings): Response {
	return jsonResponse({ error }, status, settings);
}

function jsonResponse(payload: unknown, status: number, settings: RuntimeSettings): Response {
	return new Response(JSON.stringify(payload), {
		status,
		headers: {
			'Access-Control-Allow-Headers': 'Content-Type, Accept',
			'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
			'Access-Control-Allow-Origin': settings.corsAllowOrigin,
			'Cache-Control': 'no-store',
			'Content-Type': 'application/json; charset=utf-8',
		},
	});
}

function buildCorsHeaders(settings: RuntimeSettings): HeadersInit {
	return {
		'Access-Control-Allow-Headers': 'Content-Type, Accept',
		'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
		'Access-Control-Allow-Origin': settings.corsAllowOrigin,
		'Access-Control-Max-Age': '86400',
		'Cache-Control': 'no-store',
	};
}
