/**
 * xAI / Grok OAuth tokens — primary sources: Grok CLI then Pi.
 *
 *  1. ~/.grok/auth.json   (Grok CLI — key https://auth.x.ai::<client_id>)
 *  2. ~/.pi/agent/auth.json  → xai
 *  3. VS Code Secret Storage (Command Palette device sign-in)
 *  4. Optional XAI_API_KEY (pay-as-you-go API key, not OAuth)
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { debug, logAlways } from './debug.js';
import { XAI_CLIENT_ID, refreshXaiToken, loginWithDeviceCode } from './oauth.js';

const SECRET_KEY = 'xai.oauthTokens';
const GROK_AUTH_ENTRY = `https://auth.x.ai::${XAI_CLIENT_ID}`;

/**
 * @typedef {{
 *   access: string,
 *   refresh?: string,
 *   expires?: number,
 *   source: 'grok-cli' | 'pi' | 'secret' | 'api-key',
 *   path?: string,
 *   isApiKey?: boolean,
 * }} XaiTokens
 */

/** @type {vscode.ExtensionContext | undefined} */
let extContext;

/** @param {vscode.ExtensionContext} context */
export function setAuthContext(context) {
	extContext = context;
}

export function defaultGrokAuthPath() {
	return path.join(os.homedir(), '.grok', 'auth.json');
}

export function defaultPiAuthPath() {
	return path.join(os.homedir(), '.pi', 'agent', 'auth.json');
}

/**
 * @param {string} filePath
 * @returns {XaiTokens | null}
 */
function loadFromGrokCli(filePath) {
	if (!fs.existsSync(filePath)) return null;
	try {
		const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
		const entry = raw[GROK_AUTH_ENTRY] || Object.values(raw).find(
			(v) => v && typeof v === 'object' && (v.key || v.access_token) && v.refresh_token,
		);
		if (!entry) return null;
		const access = entry.key || entry.access_token;
		const refresh = entry.refresh_token || entry.refresh;
		if (!access || !refresh) return null;
		let expires;
		if (entry.expires_at) {
			const t = Date.parse(entry.expires_at);
			if (!Number.isNaN(t)) expires = t;
		} else if (typeof entry.expires === 'number') {
			expires = entry.expires;
		}
		return {
			access,
			refresh,
			expires,
			source: 'grok-cli',
			path: filePath,
		};
	} catch (e) {
		debug('[auth] grok-cli parse failed', e instanceof Error ? e.message : e);
		return null;
	}
}

/**
 * @param {string} filePath
 * @returns {XaiTokens | null}
 */
function loadFromPi(filePath) {
	if (!fs.existsSync(filePath)) return null;
	try {
		const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
		const entry = raw.xai;
		if (!entry || entry.type !== 'oauth' || !entry.access || !entry.refresh) return null;
		return {
			access: entry.access,
			refresh: entry.refresh,
			expires: typeof entry.expires === 'number' ? entry.expires : undefined,
			source: 'pi',
			path: filePath,
		};
	} catch (e) {
		debug('[auth] pi parse failed', e instanceof Error ? e.message : e);
		return null;
	}
}

async function loadFromSecret() {
	if (!extContext) return null;
	try {
		const raw = await extContext.secrets.get(SECRET_KEY);
		if (!raw) return null;
		const j = JSON.parse(raw);
		if (!j?.access) return null;
		return {
			access: j.access,
			refresh: j.refresh,
			expires: j.expires,
			source: 'secret',
			isApiKey: j.isApiKey === true,
		};
	} catch {
		return null;
	}
}

/**
 * @param {{ access: string, refresh?: string, expires?: number, isApiKey?: boolean }} tokens
 */
async function saveSecret(tokens) {
	if (!extContext) return;
	await extContext.secrets.store(SECRET_KEY, JSON.stringify(tokens));
	logAlways('[auth] stored in Secret Storage');
}

export async function clearSecret() {
	if (!extContext) return;
	await extContext.secrets.delete(SECRET_KEY);
}

/**
 * @returns {Promise<XaiTokens | null>}
 */
export async function loadTokens() {
	const pref = vscode.workspace.getConfiguration('xai').get('authPreference') || 'auto';
	const grok = () => loadFromGrokCli(defaultGrokAuthPath());
	const pi = () => loadFromPi(defaultPiAuthPath());
	const secret = await loadFromSecret();
	const envKey = process.env.XAI_API_KEY?.trim();
	const apiKey = envKey
		? { access: envKey, source: /** @type {const} */ ('api-key'), isApiKey: true }
		: null;

	if (pref === 'grok-cli') return grok() || secret || pi() || apiKey;
	if (pref === 'pi') return pi() || secret || grok() || apiKey;
	if (pref === 'secret') return secret || grok() || pi() || apiKey;

	// auto: Grok CLI → Pi → secret → API key (CLI first as requested)
	const a = grok();
	const b = pi();
	const pickFresh = (t) => t && (!t.expires || t.expires > Date.now() + 60_000);
	if (pickFresh(a)) return a;
	if (pickFresh(b)) return b;
	if (pickFresh(secret)) return secret;
	return a || b || secret || apiKey;
}

/**
 * @param {XaiTokens} current
 * @param {{ access: string, refresh: string, expires: number }} next
 */
export async function persistTokens(current, next) {
	await saveSecret({
		access: next.access,
		refresh: next.refresh,
		expires: next.expires,
	});

	if (current.source === 'grok-cli' && current.path) {
		try {
			const raw = fs.existsSync(current.path)
				? JSON.parse(fs.readFileSync(current.path, 'utf8'))
				: {};
			const prev = raw[GROK_AUTH_ENTRY] || {};
			raw[GROK_AUTH_ENTRY] = {
				...prev,
				key: next.access,
				refresh_token: next.refresh,
				expires_at: new Date(next.expires + 5 * 60 * 1000).toISOString(),
				oidc_issuer: 'https://auth.x.ai',
				oidc_client_id: XAI_CLIENT_ID,
				auth_mode: 'oidc',
			};
			fs.mkdirSync(path.dirname(current.path), { recursive: true });
			fs.writeFileSync(current.path, JSON.stringify(raw, null, 2), { mode: 0o600 });
			logAlways('[auth] wrote', current.path);
		} catch (e) {
			logAlways('[auth] grok-cli write failed', e instanceof Error ? e.message : e);
		}
	}

	if (current.source === 'pi' && current.path) {
		try {
			const raw = fs.existsSync(current.path)
				? JSON.parse(fs.readFileSync(current.path, 'utf8'))
				: {};
			raw.xai = {
				type: 'oauth',
				access: next.access,
				refresh: next.refresh,
				expires: next.expires,
			};
			fs.mkdirSync(path.dirname(current.path), { recursive: true });
			fs.writeFileSync(current.path, JSON.stringify(raw, null, 2), { mode: 0o600 });
			logAlways('[auth] wrote', current.path);
		} catch (e) {
			logAlways('[auth] pi write failed', e instanceof Error ? e.message : e);
		}
	}
}

/**
 * Write Grok CLI–compatible auth after palette login.
 * @param {{ access: string, refresh: string, expires: number }} tokens
 */
function writeGrokCliCompat(tokens) {
	if (vscode.workspace.getConfiguration('xai').get('writeGrokAuthFile') === false) return;
	try {
		const filePath = defaultGrokAuthPath();
		const raw = fs.existsSync(filePath)
			? JSON.parse(fs.readFileSync(filePath, 'utf8'))
			: {};
		const prev = raw[GROK_AUTH_ENTRY] || {};
		raw[GROK_AUTH_ENTRY] = {
			...prev,
			key: tokens.access,
			refresh_token: tokens.refresh,
			expires_at: new Date(tokens.expires + 5 * 60 * 1000).toISOString(),
			oidc_issuer: 'https://auth.x.ai',
			oidc_client_id: XAI_CLIENT_ID,
			auth_mode: 'oidc',
			create_time: prev.create_time || new Date().toISOString(),
		};
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, JSON.stringify(raw, null, 2), { mode: 0o600 });
		logAlways('[auth] compat wrote', filePath);
	} catch (e) {
		logAlways('[auth] compat write failed', e instanceof Error ? e.message : e);
	}
}

/**
 * @param {AbortSignal} [signal]
 * @returns {Promise<XaiTokens>}
 */
export async function getValidTokens(signal) {
	let tokens = await loadTokens();
	if (!tokens) {
		throw new Error(
			'Not signed in. Command Palette → “Grok: Sign in with SuperGrok / X Premium” (or grok login / Pi xai).',
		);
	}

	if (tokens.isApiKey || !tokens.refresh) {
		return tokens;
	}

	if (!tokens.expires || tokens.expires < Date.now() + 120_000) {
		debug('[auth] refreshing from', tokens.source);
		const next = await refreshXaiToken(tokens.refresh, signal);
		await persistTokens(tokens, next);
		tokens = {
			...tokens,
			access: next.access,
			refresh: next.refresh,
			expires: next.expires,
		};
	}
	return tokens;
}

export async function signInInteractive() {
	const controller = new AbortController();
	try {
		/** @type {{ access: string, refresh: string, expires: number } | undefined} */
		let next;
		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: 'Grok: device sign-in (SuperGrok / X Premium)…',
				cancellable: true,
			},
			async (_p, token) => {
				token.onCancellationRequested(() => controller.abort());
				next = await loginWithDeviceCode({
					signal: controller.signal,
					onUserCode: (info) => {
						void vscode.env.clipboard.writeText(info.userCode);
						void vscode.window
							.showInformationMessage(
								`Grok code (copied): ${info.userCode}`,
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
		if (!next) return false;
		await saveSecret(next);
		writeGrokCliCompat(next);
		vscode.window.showInformationMessage(
			'Grok: signed in. Open Chat → Grok (xAI).',
		);
		return true;
	} catch (e) {
		if (controller.signal.aborted) {
			vscode.window.showWarningMessage('Grok sign-in cancelled.');
			return false;
		}
		vscode.window.showErrorMessage(
			`Grok sign-in failed: ${e instanceof Error ? e.message : String(e)}`,
		);
		return false;
	}
}

export async function manageAuth() {
	const tokens = await loadTokens();
	const pick = await vscode.window.showQuickPick(
		[
			{
				label: '$(sign-in) Sign in with SuperGrok / X Premium…',
				action: 'signin',
			},
			...(tokens
				? [
						{ label: '$(refresh) Refresh OAuth token', action: 'refresh' },
						{
							label: '$(info) Status',
							description: `${tokens.source}`,
							action: 'status',
						},
						{
							label: '$(sign-out) Sign out (clear Secret Storage)',
							action: 'signout',
						},
					]
				: []),
		],
		{ title: 'Grok (xAI OAuth)' },
	);
	if (!pick) return 'cancelled';

	if (pick.action === 'signin') {
		return (await signInInteractive()) ? 'signed-in' : 'cancelled';
	}
	if (pick.action === 'status') {
		vscode.window.showInformationMessage(await authStatusText());
		return 'ok';
	}
	if (pick.action === 'signout') {
		await clearSecret();
		vscode.window.showInformationMessage(
			'Cleared Secret Storage. Grok CLI / Pi files unchanged.',
		);
		return 'signed-out';
	}
	if (pick.action === 'refresh' && tokens?.refresh) {
		try {
			const next = await refreshXaiToken(tokens.refresh);
			await persistTokens(tokens, next);
			vscode.window.showInformationMessage('Grok OAuth token refreshed.');
			return 'refreshed';
		} catch (e) {
			vscode.window.showErrorMessage(
				`Refresh failed: ${e instanceof Error ? e.message : String(e)}`,
			);
			return 'error';
		}
	}
	return 'ok';
}

export async function authStatusText() {
	const t = await loadTokens();
	if (!t) return 'Not signed in — use “Grok: Sign in with SuperGrok / X Premium”';
	const exp = t.expires ? new Date(t.expires).toISOString() : t.isApiKey ? 'api-key' : '?';
	const where = t.path || t.source;
	return `${t.source} · ${where} · exp ${exp}`;
}
