/**
 * ChatGPT / Codex OAuth for machines without Codex CLI or Pi.
 *
 * - Browser PKCE: localhost:1455/auth/callback (same client as Codex CLI)
 * - Device code: https://auth.openai.com/codex/device (SSH / no browser callback)
 */
import * as http from 'node:http';
import * as crypto from 'node:crypto';
import { debug, logAlways } from './debug.js';

export const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const AUTH_BASE = 'https://auth.openai.com';
const AUTHORIZE_URL = `${AUTH_BASE}/oauth/authorize`;
const TOKEN_URL = `${AUTH_BASE}/oauth/token`;
const REDIRECT_URI = 'http://localhost:1455/auth/callback';
const SCOPE = 'openid profile email offline_access';

const DEVICE_USER_CODE_URL = `${AUTH_BASE}/api/accounts/deviceauth/usercode`;
const DEVICE_TOKEN_URL = `${AUTH_BASE}/api/accounts/deviceauth/token`;
const DEVICE_VERIFICATION_URI = `${AUTH_BASE}/codex/device`;
const DEVICE_REDIRECT_URI = `${AUTH_BASE}/deviceauth/callback`;
const DEVICE_TIMEOUT_S = 15 * 60;

/**
 * @returns {Promise<{ verifier: string, challenge: string }>}
 */
async function generatePKCE() {
	const verifierBytes = crypto.randomBytes(32);
	const verifier = verifierBytes
		.toString('base64url')
		.replace(/=/g, '');
	const challenge = crypto.createHash('sha256').update(verifier).digest('base64url').replace(/=/g, '');
	return { verifier, challenge };
}

function successHtml() {
	return `<!doctype html><html><body style="font-family:system-ui;padding:2rem">
<h1>Signed in</h1>
<p>OpenAI / Codex authentication completed. You can close this window and return to VS Code.</p>
</body></html>`;
}

function errorHtml(msg) {
	return `<!doctype html><html><body style="font-family:system-ui;padding:2rem">
<h1>Sign-in error</h1>
<p>${String(msg).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</p>
</body></html>`;
}

/**
 * @param {string} code
 * @param {string} verifier
 * @param {string} redirectUri
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ access: string, refresh: string, expires: number }>}
 */
export async function exchangeAuthorizationCode(code, verifier, redirectUri, signal) {
	const res = await fetch(TOKEN_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			grant_type: 'authorization_code',
			client_id: CLIENT_ID,
			code,
			code_verifier: verifier,
			redirect_uri: redirectUri,
		}),
		signal,
	});
	if (!res.ok) {
		const text = await res.text().catch(() => '');
		throw new Error(`Token exchange failed (${res.status}): ${text.slice(0, 300)}`);
	}
	const json = await res.json();
	if (!json?.access_token || !json?.refresh_token || typeof json.expires_in !== 'number') {
		throw new Error('Token exchange response missing fields');
	}
	return {
		access: json.access_token,
		refresh: json.refresh_token,
		expires: Date.now() + json.expires_in * 1000,
	};
}

/**
 * Browser OAuth with local callback on port 1455.
 * @param {{ openUrl: (url: string) => Thenable<void>, signal?: AbortSignal }} opts
 * @returns {Promise<{ access: string, refresh: string, expires: number }>}
 */
export async function loginWithBrowser(opts) {
	const { openUrl, signal } = opts;
	const { verifier, challenge } = await generatePKCE();
	const state = crypto.randomBytes(16).toString('hex');

	const authUrl = new URL(AUTHORIZE_URL);
	authUrl.searchParams.set('response_type', 'code');
	authUrl.searchParams.set('client_id', CLIENT_ID);
	authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
	authUrl.searchParams.set('scope', SCOPE);
	authUrl.searchParams.set('code_challenge', challenge);
	authUrl.searchParams.set('code_challenge_method', 'S256');
	authUrl.searchParams.set('state', state);
	authUrl.searchParams.set('id_token_add_organizations', 'true');
	authUrl.searchParams.set('codex_cli_simplified_flow', 'true');
	authUrl.searchParams.set('originator', 'vscode-codex-provider');

	/** @type {(v: { code: string } | null) => void} */
	let settle;
	const codePromise = new Promise((resolve) => {
		settle = resolve;
	});

	const server = http.createServer((req, res) => {
		try {
			const u = new URL(req.url || '', 'http://localhost');
			if (u.pathname !== '/auth/callback') {
				res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
				res.end(errorHtml('Callback route not found.'));
				return;
			}
			if (u.searchParams.get('state') !== state) {
				res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
				res.end(errorHtml('State mismatch. Try signing in again.'));
				settle?.(null);
				return;
			}
			const code = u.searchParams.get('code');
			if (!code) {
				res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
				res.end(errorHtml('Missing authorization code.'));
				settle?.(null);
				return;
			}
			res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
			res.end(successHtml());
			settle?.({ code });
		} catch {
			res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
			res.end(errorHtml('Internal error.'));
			settle?.(null);
		}
	});

	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(1455, '127.0.0.1', () => resolve(undefined));
	});

	const onAbort = () => {
		settle?.(null);
		try {
			server.close();
		} catch {
			/* ignore */
		}
	};
	signal?.addEventListener('abort', onAbort, { once: true });

	try {
		logAlways('[oauth] Opening browser for ChatGPT login…');
		debug('[oauth] authorize', authUrl.toString());
		await openUrl(authUrl.toString());

		const result = await Promise.race([
			codePromise,
			new Promise((_, rej) =>
				setTimeout(() => rej(new Error('Sign-in timed out (10 minutes)')), 10 * 60_000),
			),
		]);

		if (!result?.code) {
			throw new Error('Sign-in cancelled or failed');
		}

		return await exchangeAuthorizationCode(result.code, verifier, REDIRECT_URI, signal);
	} finally {
		signal?.removeEventListener('abort', onAbort);
		try {
			server.close();
		} catch {
			/* ignore */
		}
	}
}

/**
 * Device-code flow for remote / no-callback environments.
 * @param {{
 *   onUserCode: (info: { userCode: string, verificationUri: string }) => void,
 *   signal?: AbortSignal,
 * }} opts
 * @returns {Promise<{ access: string, refresh: string, expires: number }>}
 */
export async function loginWithDeviceCode(opts) {
	const { onUserCode, signal } = opts;

	const startRes = await fetch(DEVICE_USER_CODE_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ client_id: CLIENT_ID }),
		signal,
	});
	if (!startRes.ok) {
		const text = await startRes.text().catch(() => '');
		throw new Error(`Device code request failed (${startRes.status}): ${text.slice(0, 200)}`);
	}
	const start = await startRes.json();
	const intervalSeconds = Number(start.interval) || 5;
	if (!start.device_auth_id || !start.user_code) {
		throw new Error('Invalid device code response');
	}

	onUserCode({
		userCode: start.user_code,
		verificationUri: DEVICE_VERIFICATION_URI,
	});

	const deadline = Date.now() + DEVICE_TIMEOUT_S * 1000;
	let sleepMs = Math.max(1, intervalSeconds) * 1000;

	while (Date.now() < deadline) {
		if (signal?.aborted) throw new Error('Sign-in cancelled');

		await new Promise((r) => setTimeout(r, sleepMs));

		const pollRes = await fetch(DEVICE_TOKEN_URL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				device_auth_id: start.device_auth_id,
				user_code: start.user_code,
			}),
			signal,
		});

		if (pollRes.ok) {
			const json = await pollRes.json();
			if (!json?.authorization_code || !json?.code_verifier) {
				throw new Error('Invalid device auth token response');
			}
			return exchangeAuthorizationCode(
				json.authorization_code,
				json.code_verifier,
				DEVICE_REDIRECT_URI,
				signal,
			);
		}

		const body = await pollRes.text().catch(() => '');
		let errorCode;
		try {
			const j = JSON.parse(body);
			const err = j?.error;
			errorCode = typeof err === 'object' ? err?.code : err;
		} catch {
			/* ignore */
		}

		if (
			pollRes.status === 403 ||
			pollRes.status === 404 ||
			errorCode === 'deviceauth_authorization_pending'
		) {
			continue;
		}
		if (errorCode === 'slow_down') {
			sleepMs = Math.min(sleepMs * 1.5, 15_000);
			continue;
		}
		throw new Error(
			`Device auth failed (${pollRes.status})${body ? `: ${body.slice(0, 200)}` : ''}`,
		);
	}

	throw new Error('Device sign-in timed out');
}
