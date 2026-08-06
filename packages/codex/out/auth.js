/**
 * ChatGPT / Codex OAuth tokens:
 *  1. VS Code SecretStorage (from Command Palette sign-in)
 *  2. ~/.codex/auth.json  (codex login)
 *  3. ~/.pi/agent/auth.json openai-codex (Pi /login)
 *
 * Refresh + optional persist back to source file / SecretStorage.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { debug, logAlways } from './debug.js';
import { loginWithBrowser, loginWithDeviceCode, CLIENT_ID } from './oauth.js';

const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const JWT_CLAIM = 'https://api.openai.com/auth';
const SECRET_KEY = 'openaiCodex.oauthTokens';

/**
 * @typedef {{
 *   access: string,
 *   refresh: string,
 *   accountId: string,
 *   expires?: number,
 *   source: 'secret' | 'codex-cli' | 'pi',
 *   path?: string,
 * }} CodexTokens
 */

/** @type {vscode.ExtensionContext | undefined} */
let extContext;

/**
 * @param {vscode.ExtensionContext} context
 */
export function setAuthContext(context) {
	extContext = context;
}

/**
 * @returns {string}
 */
export function defaultCodexAuthPath() {
	const cfg = vscode.workspace.getConfiguration('openaiCodex').get('codexAuthPath');
	if (typeof cfg === 'string' && cfg.trim()) return cfg.trim();
	return path.join(os.homedir(), '.codex', 'auth.json');
}

/**
 * @returns {string}
 */
export function defaultPiAuthPath() {
	const cfg = vscode.workspace.getConfiguration('openaiCodex').get('piAuthPath');
	if (typeof cfg === 'string' && cfg.trim()) return cfg.trim();
	return path.join(os.homedir(), '.pi', 'agent', 'auth.json');
}

/**
 * @param {string} token
 * @returns {number | undefined}
 */
export function jwtExp(token) {
	try {
		const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
		return typeof payload.exp === 'number' ? payload.exp : undefined;
	} catch {
		return undefined;
	}
}

/**
 * @param {string} token
 * @returns {string | undefined}
 */
export function accountIdFromJwt(token) {
	try {
		const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
		return payload?.[JWT_CLAIM]?.chatgpt_account_id;
	} catch {
		return undefined;
	}
}

/**
 * @returns {Promise<CodexTokens | null>}
 */
async function loadFromSecretStorage() {
	if (!extContext) return null;
	try {
		const raw = await extContext.secrets.get(SECRET_KEY);
		if (!raw) return null;
		const j = JSON.parse(raw);
		if (!j?.access || !j?.refresh) return null;
		const accountId = j.accountId || accountIdFromJwt(j.access);
		if (!accountId) return null;
		const expSec = jwtExp(j.access);
		return {
			access: j.access,
			refresh: j.refresh,
			accountId,
			expires:
				typeof j.expires === 'number'
					? j.expires
					: expSec
						? expSec * 1000
						: undefined,
			source: 'secret',
		};
	} catch {
		return null;
	}
}

/**
 * @param {{ access: string, refresh: string, expires: number, accountId: string }} tokens
 */
async function saveToSecretStorage(tokens) {
	if (!extContext) return;
	await extContext.secrets.store(
		SECRET_KEY,
		JSON.stringify({
			access: tokens.access,
			refresh: tokens.refresh,
			expires: tokens.expires,
			accountId: tokens.accountId,
		}),
	);
	logAlways('[auth] tokens stored in VS Code Secret Storage');
}

export async function clearSecretStorage() {
	if (!extContext) return;
	await extContext.secrets.delete(SECRET_KEY);
	logAlways('[auth] Secret Storage cleared');
}

/**
 * @param {string} filePath
 * @returns {CodexTokens | null}
 */
function loadFromCodexCli(filePath) {
	if (!fs.existsSync(filePath)) return null;
	try {
		const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
		const tokens = raw?.tokens;
		if (!tokens?.access_token || !tokens?.refresh_token) return null;
		const accountId = tokens.account_id || accountIdFromJwt(tokens.access_token);
		if (!accountId) return null;
		const exp = jwtExp(tokens.access_token);
		return {
			access: tokens.access_token,
			refresh: tokens.refresh_token,
			accountId,
			expires: exp ? exp * 1000 : undefined,
			source: 'codex-cli',
			path: filePath,
		};
	} catch (e) {
		debug('[auth] codex-cli parse failed', e instanceof Error ? e.message : e);
		return null;
	}
}

/**
 * @param {string} filePath
 * @returns {CodexTokens | null}
 */
function loadFromPi(filePath) {
	if (!fs.existsSync(filePath)) return null;
	try {
		const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
		const entry = raw?.['openai-codex'];
		if (!entry || entry.type !== 'oauth' || !entry.access || !entry.refresh) return null;
		const accountId = entry.accountId || accountIdFromJwt(entry.access);
		if (!accountId) return null;
		return {
			access: entry.access,
			refresh: entry.refresh,
			accountId,
			expires: typeof entry.expires === 'number' ? entry.expires : undefined,
			source: 'pi',
			path: filePath,
		};
	} catch (e) {
		debug('[auth] pi parse failed', e instanceof Error ? e.message : e);
		return null;
	}
}

/**
 * @returns {Promise<CodexTokens | null>}
 */
export async function loadTokens() {
	const pref = vscode.workspace.getConfiguration('openaiCodex').get('authPreference') || 'auto';
	const codexPath = defaultCodexAuthPath();
	const piPath = defaultPiAuthPath();

	const secret = await loadFromSecretStorage();
	const codex = () => loadFromCodexCli(codexPath);
	const pi = () => loadFromPi(piPath);

	if (pref === 'codex-cli') return codex() || secret || pi();
	if (pref === 'pi') return pi() || secret || codex();
	if (pref === 'secret') return secret || codex() || pi();

	// auto: secret first (palette sign-in), then files
	if (secret) {
		const ok = !secret.expires || secret.expires > Date.now() + 60_000;
		if (ok) return secret;
	}
	const a = codex();
	const b = pi();
	if (a && (!a.expires || a.expires > Date.now() + 60_000)) return a;
	if (b && (!b.expires || b.expires > Date.now() + 60_000)) return b;
	return secret || a || b;
}

/**
 * @param {string} refreshToken
 * @param {AbortSignal} [signal]
 */
export async function refreshAccessToken(refreshToken, signal) {
	const res = await fetch(TOKEN_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			grant_type: 'refresh_token',
			refresh_token: refreshToken,
			client_id: CLIENT_ID,
		}),
		signal,
	});
	if (!res.ok) {
		const text = await res.text().catch(() => '');
		throw new Error(`Token refresh failed (${res.status}): ${text.slice(0, 200)}`);
	}
	const json = await res.json();
	if (!json?.access_token || !json?.refresh_token || typeof json.expires_in !== 'number') {
		throw new Error('Token refresh response missing fields');
	}
	return {
		access: json.access_token,
		refresh: json.refresh_token,
		expires: Date.now() + json.expires_in * 1000,
	};
}

/**
 * @param {CodexTokens} current
 * @param {{ access: string, refresh: string, expires: number }} next
 */
export async function persistTokens(current, next) {
	const accountId = accountIdFromJwt(next.access) || current.accountId;

	// Always keep Secret Storage in sync after refresh/login
	await saveToSecretStorage({
		access: next.access,
		refresh: next.refresh,
		expires: next.expires,
		accountId,
	});

	if (current.source === 'secret' || !current.path) {
		return;
	}

	try {
		if (current.source === 'codex-cli') {
			const raw = fs.existsSync(current.path)
				? JSON.parse(fs.readFileSync(current.path, 'utf8'))
				: { auth_mode: 'chatgpt', tokens: {} };
			raw.auth_mode = raw.auth_mode || 'chatgpt';
			raw.tokens = {
				...(raw.tokens || {}),
				access_token: next.access,
				refresh_token: next.refresh,
				account_id: accountId,
				id_token: raw.tokens?.id_token,
			};
			raw.last_refresh = new Date().toISOString();
			fs.mkdirSync(path.dirname(current.path), { recursive: true });
			fs.writeFileSync(current.path, JSON.stringify(raw, null, 2), { mode: 0o600 });
		} else if (current.source === 'pi') {
			const raw = fs.existsSync(current.path)
				? JSON.parse(fs.readFileSync(current.path, 'utf8'))
				: {};
			raw['openai-codex'] = {
				type: 'oauth',
				access: next.access,
				refresh: next.refresh,
				expires: next.expires,
				accountId,
			};
			fs.mkdirSync(path.dirname(current.path), { recursive: true });
			fs.writeFileSync(current.path, JSON.stringify(raw, null, 2), { mode: 0o600 });
		}
		logAlways(`[auth] refreshed tokens written to ${current.path}`);
	} catch (e) {
		logAlways('[auth] failed to persist file tokens:', e instanceof Error ? e.message : e);
	}
}

/**
 * Also write a minimal ~/.codex/auth.json so other tools can reuse the session.
 * @param {{ access: string, refresh: string, expires: number, accountId: string }} tokens
 */
function writeCodexCliCompatFile(tokens) {
	const write =
		vscode.workspace.getConfiguration('openaiCodex').get('writeCodexAuthFile') !== false;
	if (!write) return;
	try {
		const filePath = defaultCodexAuthPath();
		const raw = fs.existsSync(filePath)
			? JSON.parse(fs.readFileSync(filePath, 'utf8'))
			: {};
		raw.auth_mode = 'chatgpt';
		raw.OPENAI_API_KEY = raw.OPENAI_API_KEY ?? null;
		raw.tokens = {
			...(raw.tokens || {}),
			access_token: tokens.access,
			refresh_token: tokens.refresh,
			account_id: tokens.accountId,
		};
		raw.last_refresh = new Date().toISOString();
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, JSON.stringify(raw, null, 2), { mode: 0o600 });
		logAlways('[auth] wrote compat', filePath);
	} catch (e) {
		logAlways('[auth] compat write failed:', e instanceof Error ? e.message : e);
	}
}

/**
 * @param {AbortSignal} [signal]
 * @returns {Promise<CodexTokens>}
 */
export async function getValidTokens(signal) {
	let tokens = await loadTokens();
	if (!tokens) {
		throw new Error(
			'Not signed in. Command Palette → “Codex: Sign in with ChatGPT” (or run codex login).',
		);
	}

	const expiring = !tokens.expires || tokens.expires < Date.now() + 120_000;
	if (expiring) {
		debug('[auth] refreshing (source=', tokens.source, ')');
		const next = await refreshAccessToken(tokens.refresh, signal);
		await persistTokens(tokens, next);
		tokens = {
			...tokens,
			access: next.access,
			refresh: next.refresh,
			expires: next.expires,
			accountId: accountIdFromJwt(next.access) || tokens.accountId,
			source: tokens.source === 'secret' ? 'secret' : tokens.source,
		};
	}

	return tokens;
}

/**
 * Interactive sign-in (browser or device code).
 * @returns {Promise<boolean>} true if signed in
 */
export async function signInInteractive() {
	const method = await vscode.window.showQuickPick(
		[
			{
				label: '$(globe) Browser sign-in',
				description: 'Opens ChatGPT login (recommended)',
				method: 'browser',
			},
			{
				label: '$(device-mobile) Device code',
				description: 'For remote / SSH / no local browser callback',
				method: 'device',
			},
		],
		{
			title: 'Codex: Sign in with ChatGPT',
			placeHolder: 'Choose how to authenticate',
		},
	);
	if (!method) return false;

	const controller = new AbortController();

	try {
		/** @type {{ access: string, refresh: string, expires: number }} */
		let next;

		if (method.method === 'browser') {
			await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: 'Codex: waiting for browser sign-in…',
					cancellable: true,
				},
				async (_progress, token) => {
					token.onCancellationRequested(() => controller.abort());
					next = await loginWithBrowser({
						openUrl: (url) => vscode.env.openExternal(vscode.Uri.parse(url)),
						signal: controller.signal,
					});
				},
			);
		} else {
			await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: 'Codex: device sign-in…',
					cancellable: true,
				},
				async (_progress, token) => {
					token.onCancellationRequested(() => controller.abort());
					next = await loginWithDeviceCode({
						signal: controller.signal,
						onUserCode: (info) => {
							void vscode.env.clipboard.writeText(info.userCode);
							void vscode.window
								.showInformationMessage(
									`Codex device code (copied): ${info.userCode}`,
									'Open verification page',
								)
								.then((btn) => {
									if (btn) {
										void vscode.env.openExternal(
											vscode.Uri.parse(info.verificationUri),
										);
									}
								});
						},
					});
				},
			);
		}

		if (!next) return false;

		const accountId = accountIdFromJwt(next.access);
		if (!accountId) {
			throw new Error('Signed in but could not read ChatGPT account id from token');
		}

		await saveToSecretStorage({
			access: next.access,
			refresh: next.refresh,
			expires: next.expires,
			accountId,
		});
		writeCodexCliCompatFile({
			access: next.access,
			refresh: next.refresh,
			expires: next.expires,
			accountId,
		});

		vscode.window.showInformationMessage(
			'Codex: signed in with ChatGPT. Open Chat → Codex (ChatGPT).',
		);
		return true;
	} catch (e) {
		if (controller.signal.aborted) {
			vscode.window.showWarningMessage('Codex sign-in cancelled.');
			return false;
		}
		const msg = e instanceof Error ? e.message : String(e);
		vscode.window.showErrorMessage(`Codex sign-in failed: ${msg}`);
		return false;
	}
}

/**
 * @returns {Promise<'signed-in' | 'refreshed' | 'signed-out' | 'ok' | 'missing' | 'error' | 'cancelled'>}
 */
export async function manageAuth() {
	const tokens = await loadTokens();

	const items = [
		{
			label: '$(sign-in) Sign in with ChatGPT…',
			description: tokens ? 'Replace current session' : 'Browser or device code',
			action: 'signin',
		},
		...(tokens
			? [
					{
						label: '$(refresh) Refresh OAuth token',
						action: 'refresh',
					},
					{
						label: '$(info) Status',
						description: `${tokens.source} · …${tokens.accountId.slice(-6)}`,
						action: 'status',
					},
					{
						label: '$(sign-out) Sign out (clear VS Code Secret Storage)',
						action: 'signout',
					},
				]
			: []),
	];

	const pick = await vscode.window.showQuickPick(items, {
		title: 'Codex (ChatGPT OAuth)',
	});
	if (!pick) return 'cancelled';

	if (pick.action === 'signin') {
		const ok = await signInInteractive();
		return ok ? 'signed-in' : 'cancelled';
	}

	if (pick.action === 'status') {
		vscode.window.showInformationMessage(await authStatusText());
		return 'ok';
	}

	if (pick.action === 'signout') {
		await clearSecretStorage();
		vscode.window.showInformationMessage(
			'Cleared VS Code Secret Storage. File-based codex/pi logins (if any) are unchanged.',
		);
		return 'signed-out';
	}

	if (pick.action === 'refresh' && tokens) {
		try {
			const next = await refreshAccessToken(tokens.refresh);
			await persistTokens(tokens, next);
			vscode.window.showInformationMessage('Codex OAuth token refreshed.');
			return 'refreshed';
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			vscode.window.showErrorMessage(`Codex refresh failed: ${msg}`);
			return 'error';
		}
	}

	return 'ok';
}

export async function authStatusText() {
	const t = await loadTokens();
	if (!t) {
		return 'Not signed in — use “Codex: Sign in with ChatGPT”';
	}
	const exp = t.expires ? new Date(t.expires).toISOString() : '?';
	const where =
		t.source === 'secret'
			? 'VS Code Secret Storage'
			: t.path || t.source;
	return `${t.source} · ${where} · exp ${exp} · account …${t.accountId.slice(-8)}`;
}
