/**
 * xAI OAuth device-code flow — same client as Grok CLI and Pi.
 * Client: b1a00492-073a-47ea-816f-4c329264a828
 * Device: https://auth.x.ai/oauth2/device/code
 * Token:  https://auth.x.ai/oauth2/token
 */
import { debug, logAlways } from './debug.js';

export const XAI_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
const XAI_SCOPE = 'openid profile email offline_access grok-cli:access api:access';
const DEVICE_CODE_URL = 'https://auth.x.ai/oauth2/device/code';
const TOKEN_URL = 'https://auth.x.ai/oauth2/token';
const REFRESH_SKEW_MS = 5 * 60 * 1000;
const DEFAULT_TOKEN_LIFETIME_S = 3600;

/**
 * @param {string} url
 * @param {Record<string, string>} fields
 * @param {AbortSignal} [signal]
 */
async function postForm(url, fields, signal) {
	const res = await fetch(url, {
		method: 'POST',
		headers: {
			Accept: 'application/json',
			'Content-Type': 'application/x-www-form-urlencoded',
		},
		body: new URLSearchParams(fields),
		signal,
	});
	let body = {};
	try {
		body = await res.json();
	} catch {
		/* ignore */
	}
	return { ok: res.ok, status: res.status, body };
}

/**
 * @param {object} body
 * @param {string} [previousRefresh]
 * @returns {{ access: string, refresh: string, expires: number }}
 */
function credentialsFromTokenResponse(body, previousRefresh) {
	const access = body.access_token;
	if (typeof access !== 'string' || !access) {
		throw new Error('xAI token response missing access_token');
	}
	const refresh =
		typeof body.refresh_token === 'string' && body.refresh_token
			? body.refresh_token
			: previousRefresh;
	if (!refresh) throw new Error('xAI token response missing refresh_token');
	const expiresIn =
		typeof body.expires_in === 'number' && body.expires_in > 0
			? body.expires_in
			: DEFAULT_TOKEN_LIFETIME_S;
	return {
		access,
		refresh,
		expires: Date.now() + expiresIn * 1000 - REFRESH_SKEW_MS,
	};
}

/**
 * @param {string} refreshToken
 * @param {AbortSignal} [signal]
 */
export async function refreshXaiToken(refreshToken, signal) {
	const res = await postForm(
		TOKEN_URL,
		{
			grant_type: 'refresh_token',
			client_id: XAI_CLIENT_ID,
			refresh_token: refreshToken,
		},
		signal,
	);
	if (!res.ok) {
		const detail = [res.body.error, res.body.error_description].filter(Boolean).join(': ');
		throw new Error(
			`xAI token refresh failed (HTTP ${res.status})${detail ? `: ${detail}` : ''}`,
		);
	}
	return credentialsFromTokenResponse(res.body, refreshToken);
}

/**
 * Device-code login (official Grok CLI / Pi path).
 * @param {{
 *   onUserCode: (info: { userCode: string, verificationUri: string }) => void,
 *   signal?: AbortSignal,
 * }} opts
 */
export async function loginWithDeviceCode(opts) {
	const { onUserCode, signal } = opts;
	const start = await postForm(
		DEVICE_CODE_URL,
		{
			client_id: XAI_CLIENT_ID,
			scope: XAI_SCOPE,
			referrer: 'vscode-grok-provider',
		},
		signal,
	);
	if (!start.ok) {
		const detail = [start.body.error, start.body.error_description]
			.filter(Boolean)
			.join(': ');
		throw new Error(
			`xAI device authorization failed (HTTP ${start.status})${detail ? `: ${detail}` : ''}`,
		);
	}

	const deviceCode = start.body.device_code;
	const userCode = start.body.user_code;
	const verificationUri =
		start.body.verification_uri_complete || start.body.verification_uri;
	if (!deviceCode || !userCode || !verificationUri) {
		throw new Error('Invalid xAI device code response');
	}
	if (!String(verificationUri).startsWith('https://')) {
		throw new Error('Untrusted verification URI');
	}

	const intervalSeconds =
		typeof start.body.interval === 'number' && start.body.interval > 0
			? start.body.interval
			: 5;
	const expiresInSeconds =
		typeof start.body.expires_in === 'number' ? start.body.expires_in : 900;

	onUserCode({ userCode, verificationUri });
	logAlways('[oauth] device code issued, waiting for user…');
	debug('[oauth] verification', verificationUri);

	const deadline = Date.now() + expiresInSeconds * 1000;
	let sleepMs = intervalSeconds * 1000;

	// RFC 8628: wait before first poll
	await new Promise((r) => setTimeout(r, sleepMs));

	while (Date.now() < deadline) {
		if (signal?.aborted) throw new Error('Sign-in cancelled');

		const poll = await postForm(
			TOKEN_URL,
			{
				grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
				client_id: XAI_CLIENT_ID,
				device_code: deviceCode,
			},
			signal,
		);

		if (poll.ok) {
			return credentialsFromTokenResponse(poll.body);
		}

		const err = poll.body.error;
		if (err === 'authorization_pending') {
			await new Promise((r) => setTimeout(r, sleepMs));
			continue;
		}
		if (err === 'slow_down') {
			sleepMs = Math.min(sleepMs * 1.5, 15_000);
			await new Promise((r) => setTimeout(r, sleepMs));
			continue;
		}
		if (err === 'access_denied' || err === 'authorization_denied') {
			throw new Error('xAI device authorization was denied');
		}
		if (err === 'expired_token') {
			throw new Error('xAI device code expired');
		}
		const detail = [err, poll.body.error_description].filter(Boolean).join(': ');
		throw new Error(
			`xAI device poll failed (HTTP ${poll.status})${detail ? `: ${detail}` : ''}`,
		);
	}

	throw new Error('xAI device sign-in timed out');
}
