import { readFileSync } from 'node:fs';
import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import worker from '../src/index';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
const schemaSql = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');

describe('high score worker', () => {
	beforeEach(async () => {
		await env.DB.exec('DROP TABLE IF EXISTS scores; DROP TABLE IF EXISTS Customers;');
		await env.DB.exec(schemaSql);
	});

	it('submits a score and returns the current leaderboard', async () => {
		const request = createScoreRequest('http://example.com/scores', {
			ip: '203.0.113.10',
			name: '  Alice   ',
			score: 8,
			buildVersion: '0.1.0',
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);

		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			submittedEntry: {
				name: 'Alice',
				score: 8,
			},
			entries: [
				{
					name: 'Alice',
					score: 8,
				},
			],
		});
	});

	it('orders the leaderboard by highest score first', async () => {
		await SELF.fetch('https://example.com/scores', {
			method: 'POST',
			headers: createHeaders('203.0.113.11'),
			body: JSON.stringify({ name: 'Low', score: 3, buildVersion: '0.1.0' }),
		});
		await SELF.fetch('https://example.com/scores', {
			method: 'POST',
			headers: createHeaders('203.0.113.12'),
			body: JSON.stringify({ name: 'High', score: 9, buildVersion: '0.1.0' }),
		});

		const response = await SELF.fetch('https://example.com/scores');
		const payload = (await response.json()) as { entries: Array<{ name: string; score: number }> };

		expect(response.status).toBe(200);
		expect(payload.entries.map((entry) => ({ name: entry.name, score: entry.score }))).toEqual([
			{ name: 'High', score: 9 },
			{ name: 'Low', score: 3 },
		]);
	});

	it('rejects invalid names with the Unity error code', async () => {
		const response = await SELF.fetch('https://example.com/scores', {
			method: 'POST',
			headers: createHeaders('203.0.113.13'),
			body: JSON.stringify({ name: 'Bad!Name', score: 4, buildVersion: '0.1.0' }),
		});

		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toEqual({ error: 'invalid_name' });
	});

	it('rejects identical recent duplicates before the general rate limit', async () => {
		const body = JSON.stringify({ name: 'Repeat', score: 7, buildVersion: '0.1.0' });
		const headers = createHeaders('203.0.113.14');

		const firstResponse = await SELF.fetch('https://example.com/scores', {
			method: 'POST',
			headers,
			body,
		});
		const secondResponse = await SELF.fetch('https://example.com/scores', {
			method: 'POST',
			headers,
			body,
		});

		expect(firstResponse.status).toBe(200);
		expect(secondResponse.status).toBe(429);
		await expect(secondResponse.json()).resolves.toEqual({ error: 'duplicate_recent' });
	});

	it('rate limits different back-to-back submissions from the same IP', async () => {
		const headers = createHeaders('203.0.113.15');

		const firstResponse = await SELF.fetch('https://example.com/scores', {
			method: 'POST',
			headers,
			body: JSON.stringify({ name: 'First', score: 5, buildVersion: '0.1.0' }),
		});
		const secondResponse = await SELF.fetch('https://example.com/scores', {
			method: 'POST',
			headers,
			body: JSON.stringify({ name: 'Second', score: 6, buildVersion: '0.1.0' }),
		});

		expect(firstResponse.status).toBe(200);
		expect(secondResponse.status).toBe(429);
		await expect(secondResponse.json()).resolves.toEqual({ error: 'rate_limited' });
	});
});

function createScoreRequest(
	url: string,
	options: { buildVersion: string; ip: string; name: string; score: number },
): Request {
	return new IncomingRequest(url, {
		method: 'POST',
		headers: createHeaders(options.ip),
		body: JSON.stringify({
			name: options.name,
			score: options.score,
			buildVersion: options.buildVersion,
		}),
	});
}

function createHeaders(ip: string): HeadersInit {
	return {
		Accept: 'application/json',
		'CF-Connecting-IP': ip,
		'Content-Type': 'application/json',
	};
}
