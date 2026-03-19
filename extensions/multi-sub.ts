/**
 * Multi-Subscription extension for pi.
 *
 * Register additional OAuth subscription accounts for any supported provider.
 * Each extra account gets its own provider name, /login entry, and cloned models.
 *
 * Features:
 *   - /subs: manage subscriptions (add, remove, login, logout, status)
 *   - /pool: define provider pools with auto-rotation on rate limit errors
 *   - Project-level pool config: .pi/multi-pass.json overrides global pools
 *   - MULTI_SUB env var for scripting
 *
 * Pool auto-rotation: group subscriptions into pools. When the active sub
 * hits a rate limit or error, automatically switch to the next available
 * sub in the pool and retry. Keeps the same model ID, just rotates the
 * provider/account.
 *
 * Config files:
 *   Global:  ~/.pi/agent/multi-pass.json  (subscriptions + default pools)
 *   Project: .pi/multi-pass.json          (pool overrides + subscription filtering)
 *
 * Project-level config can:
 *   - Define project-specific pools (override global pools)
 *   - Restrict which subscriptions are usable via "allowedSubs"
 *   - Leave pools empty to inherit global pools
 *
 * Supported providers:
 *   - anthropic          (Claude Pro/Max)
 *   - openai-codex       (ChatGPT Plus/Pro Codex)
 *   - github-copilot     (GitHub Copilot)
 *   - google-gemini-cli  (Google Cloud Code Assist)
 *   - google-antigravity (Antigravity)
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	AgentEndEvent,
} from "@mariozechner/pi-coding-agent";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import {
	anthropicOAuthProvider,
	loginAnthropic,
	refreshAnthropicToken,
	openaiCodexOAuthProvider,
	loginOpenAICodex,
	refreshOpenAICodexToken,
	githubCopilotOAuthProvider,
	loginGitHubCopilot,
	refreshGitHubCopilotToken,
	getGitHubCopilotBaseUrl,
	normalizeDomain,
	geminiCliOAuthProvider,
	loginGeminiCli,
	refreshGoogleCloudToken,
	antigravityOAuthProvider,
	loginAntigravity,
	refreshAntigravityToken,
	type OAuthCredentials,
	type OAuthLoginCallbacks,
	type OAuthProviderInterface,
} from "@mariozechner/pi-ai/oauth";
import { getModels, type Api, type Model } from "@mariozechner/pi-ai";

// ==========================================================================
// Provider templates
// ==========================================================================

type CopilotCredentials = OAuthCredentials & { enterpriseUrl?: string };
type GeminiCredentials = OAuthCredentials & { projectId?: string };

interface ProviderTemplate {
	displayName: string;
	builtinOAuth: OAuthProviderInterface;
	usesCallbackServer?: boolean;
	buildOAuth(index: number): Omit<OAuthProviderInterface, "id">;
	buildModifyModels?(providerName: string): OAuthProviderInterface["modifyModels"];
}

const PROVIDER_TEMPLATES: Record<string, ProviderTemplate> = {
	anthropic: {
		displayName: "Anthropic (Claude Pro/Max)",
		builtinOAuth: anthropicOAuthProvider,
		buildOAuth(index: number) {
			return {
				name: `Anthropic #${index}`,
				async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
					return loginAnthropic({
						onAuth: callbacks.onAuth,
						onPrompt: callbacks.onPrompt,
						onProgress: callbacks.onProgress,
						onManualCodeInput: callbacks.onManualCodeInput,
					});
				},
				async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
					return refreshAnthropicToken(credentials.refresh);
				},
				getApiKey(credentials: OAuthCredentials): string {
					return credentials.access;
				},
			};
		},
	},

	"openai-codex": {
		displayName: "ChatGPT Plus/Pro (Codex)",
		builtinOAuth: openaiCodexOAuthProvider,
		usesCallbackServer: true,
		buildOAuth(index: number) {
			return {
				name: `ChatGPT Codex #${index}`,
				usesCallbackServer: true,
				async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
					return loginOpenAICodex({
						onAuth: callbacks.onAuth,
						onPrompt: callbacks.onPrompt,
						onProgress: callbacks.onProgress,
						onManualCodeInput: callbacks.onManualCodeInput,
					});
				},
				async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
					return refreshOpenAICodexToken(credentials.refresh);
				},
				getApiKey(credentials: OAuthCredentials): string {
					return credentials.access;
				},
			};
		},
	},

	"github-copilot": {
		displayName: "GitHub Copilot",
		builtinOAuth: githubCopilotOAuthProvider,
		buildOAuth(index: number) {
			return {
				name: `GitHub Copilot #${index}`,
				async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
					return loginGitHubCopilot({
						onAuth: (url: string, instructions?: string) =>
							callbacks.onAuth({ url, instructions }),
						onPrompt: callbacks.onPrompt,
						onProgress: callbacks.onProgress,
						signal: callbacks.signal,
					});
				},
				async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
					const creds = credentials as CopilotCredentials;
					return refreshGitHubCopilotToken(creds.refresh, creds.enterpriseUrl);
				},
				getApiKey(credentials: OAuthCredentials): string {
					return credentials.access;
				},
			};
		},
		buildModifyModels(providerName: string) {
			return (models: Model<Api>[], credentials: OAuthCredentials): Model<Api>[] => {
				const creds = credentials as CopilotCredentials;
				const domain = creds.enterpriseUrl
					? (normalizeDomain(creds.enterpriseUrl) ?? undefined)
					: undefined;
				const baseUrl = getGitHubCopilotBaseUrl(creds.access, domain);
				return models.map((m) =>
					m.provider === providerName ? { ...m, baseUrl } : m,
				);
			};
		},
	},

	"google-gemini-cli": {
		displayName: "Google Cloud Code Assist",
		builtinOAuth: geminiCliOAuthProvider,
		usesCallbackServer: true,
		buildOAuth(index: number) {
			return {
				name: `Google Cloud Code Assist #${index}`,
				usesCallbackServer: true,
				async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
					return loginGeminiCli(
						callbacks.onAuth,
						callbacks.onProgress,
						callbacks.onManualCodeInput,
					);
				},
				async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
					const creds = credentials as GeminiCredentials;
					if (!creds.projectId) throw new Error("Missing projectId");
					return refreshGoogleCloudToken(creds.refresh, creds.projectId);
				},
				getApiKey(credentials: OAuthCredentials): string {
					const creds = credentials as GeminiCredentials;
					return JSON.stringify({ token: creds.access, projectId: creds.projectId });
				},
			};
		},
	},

	"google-antigravity": {
		displayName: "Antigravity",
		builtinOAuth: antigravityOAuthProvider,
		usesCallbackServer: true,
		buildOAuth(index: number) {
			return {
				name: `Antigravity #${index}`,
				usesCallbackServer: true,
				async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
					return loginAntigravity(
						callbacks.onAuth,
						callbacks.onProgress,
						callbacks.onManualCodeInput,
					);
				},
				async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
					const creds = credentials as GeminiCredentials;
					if (!creds.projectId) throw new Error("Missing projectId");
					return refreshAntigravityToken(creds.refresh, creds.projectId);
				},
				getApiKey(credentials: OAuthCredentials): string {
					const creds = credentials as GeminiCredentials;
					return JSON.stringify({ token: creds.access, projectId: creds.projectId });
				},
			};
		},
	},
};

const SUPPORTED_PROVIDERS = Object.keys(PROVIDER_TEMPLATES);

// ==========================================================================
// Config persistence (~/.pi/agent/multi-pass.json)
// ==========================================================================

interface SubEntry {
	provider: string;
	index: number;
	label?: string;
}

interface PoolConfig {
	/** Pool name (user-defined) */
	name: string;
	/** Base provider type, e.g. "openai-codex" */
	baseProvider: string;
	/** Provider names in rotation order. Includes the original (e.g. "openai-codex")
	 *  and extras (e.g. "openai-codex-2", "openai-codex-3") */
	members: string[];
	/** Whether auto-rotation is enabled */
	enabled: boolean;
}

interface MultiPassConfig {
	subscriptions: SubEntry[];
	pools: PoolConfig[];
}

/** Project-level config (.pi/multi-pass.json) */
interface ProjectConfig {
	/** Override pools for this project. If set, replaces global pools. */
	pools?: PoolConfig[];
	/** Restrict which subscriptions can be used. Provider names (e.g. "openai-codex-2").
	 *  If set, only these subs (plus the originals) are available in this project.
	 *  If not set, all global subs are available. */
	allowedSubs?: string[];
}

/** Effective config after merging global + project */
interface EffectiveConfig {
	subscriptions: SubEntry[];
	pools: PoolConfig[];
	/** Which project config was loaded from, if any */
	projectConfigPath?: string;
}

function globalConfigPath(): string {
	return join(getAgentDir(), "multi-pass.json");
}

function projectConfigPath(cwd: string): string {
	return join(cwd, ".pi", "multi-pass.json");
}

function loadGlobalConfig(): MultiPassConfig {
	const path = globalConfigPath();
	if (!existsSync(path)) return { subscriptions: [], pools: [] };
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8"));
		return {
			subscriptions: raw.subscriptions || [],
			pools: raw.pools || [],
		};
	} catch {
		return { subscriptions: [], pools: [] };
	}
}

function loadProjectConfig(cwd: string): ProjectConfig | undefined {
	const path = projectConfigPath(cwd);
	if (!existsSync(path)) return undefined;
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as ProjectConfig;
	} catch {
		return undefined;
	}
}

function loadEffectiveConfig(cwd: string): EffectiveConfig {
	const global = loadGlobalConfig();
	const project = loadProjectConfig(cwd);

	if (!project) {
		return { subscriptions: global.subscriptions, pools: global.pools };
	}

	// Subscriptions are always global, but filter if allowedSubs is set
	let subs = global.subscriptions;
	if (project.allowedSubs && project.allowedSubs.length > 0) {
		const allowed = new Set(project.allowedSubs);
		subs = global.subscriptions.filter((s) => allowed.has(subProviderName(s)));
	}

	// Pools: project overrides global if defined
	const pools = project.pools !== undefined ? project.pools : global.pools;

	return {
		subscriptions: subs,
		pools,
		projectConfigPath: projectConfigPath(cwd),
	};
}

function saveGlobalConfig(config: MultiPassConfig): void {
	const path = globalConfigPath();
	const dir = dirname(path);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(path, JSON.stringify(config, null, 2), "utf-8");
}

function saveProjectConfig(cwd: string, config: ProjectConfig): void {
	const path = projectConfigPath(cwd);
	const dir = dirname(path);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(path, JSON.stringify(config, null, 2), "utf-8");
}

// ==========================================================================
// Merge env var into config
// ==========================================================================

function parseEnvConfig(): SubEntry[] {
	const raw = process.env.MULTI_SUB;
	if (!raw) return [];
	const entries: SubEntry[] = [];
	for (const part of raw.split(",")) {
		const [provider, countStr] = part.trim().split(":");
		if (!provider || !PROVIDER_TEMPLATES[provider]) continue;
		const count = parseInt(countStr || "1", 10);
		if (isNaN(count) || count < 1) continue;
		for (let i = 0; i < count; i++) {
			entries.push({ provider, index: 0 });
		}
	}
	return entries;
}

function mergeConfigs(fileConfig: MultiPassConfig, envEntries: SubEntry[]): SubEntry[] {
	const merged = [...fileConfig.subscriptions];
	for (const envEntry of envEntries) {
		const existingCount = merged.filter((s) => s.provider === envEntry.provider).length;
		const envCountForProvider = envEntries.filter((e) => e.provider === envEntry.provider).length;
		if (existingCount < envCountForProvider) {
			const usedIndices = merged
				.filter((s) => s.provider === envEntry.provider)
				.map((s) => s.index);
			let nextIndex = 2;
			while (usedIndices.includes(nextIndex)) nextIndex++;
			merged.push({ provider: envEntry.provider, index: nextIndex });
		}
	}
	return merged;
}

function normalizeEntries(entries: SubEntry[]): SubEntry[] {
	const byProvider = new Map<string, SubEntry[]>();
	for (const entry of entries) {
		const list = byProvider.get(entry.provider) || [];
		list.push(entry);
		byProvider.set(entry.provider, list);
	}
	const result: SubEntry[] = [];
	for (const [, list] of byProvider) {
		const usedIndices = new Set(list.filter((e) => e.index > 0).map((e) => e.index));
		let nextIndex = 2;
		for (const entry of list) {
			if (entry.index > 0) {
				result.push(entry);
			} else {
				while (usedIndices.has(nextIndex)) nextIndex++;
				result.push({ ...entry, index: nextIndex });
				usedIndices.add(nextIndex);
				nextIndex++;
			}
		}
	}
	return result;
}

// ==========================================================================
// Provider name helpers
// ==========================================================================

function subProviderName(entry: SubEntry): string {
	return `${entry.provider}-${entry.index}`;
}

function subDisplayName(entry: SubEntry): string {
	const template = PROVIDER_TEMPLATES[entry.provider];
	const label = entry.label ? ` (${entry.label})` : "";
	return `${template?.displayName || entry.provider} #${entry.index}${label}`;
}

/** Get the base provider type from a provider name, e.g. "openai-codex-2" -> "openai-codex" */
function getBaseProvider(providerName: string): string | undefined {
	// Direct match
	if (PROVIDER_TEMPLATES[providerName]) return providerName;
	// Strip trailing -N
	const match = providerName.match(/^(.+)-(\d+)$/);
	if (match && PROVIDER_TEMPLATES[match[1]]) return match[1];
	return undefined;
}

// ==========================================================================
// Model cloning
// ==========================================================================

function cloneModels(originalProvider: string, index: number) {
	const models = getModels(originalProvider as any) as Model<Api>[];
	return models.map((m) => ({
		id: m.id,
		name: `${m.name} (#${index})`,
		api: m.api,
		reasoning: m.reasoning,
		input: m.input as ("text" | "image")[],
		cost: { ...m.cost },
		contextWindow: m.contextWindow,
		maxTokens: m.maxTokens,
		headers: m.headers ? { ...m.headers } : undefined,
		compat: m.compat,
	}));
}

// ==========================================================================
// Register a single subscription as a provider
// ==========================================================================

function registerSub(pi: ExtensionAPI, entry: SubEntry): void {
	const template = PROVIDER_TEMPLATES[entry.provider];
	if (!template) return;

	const name = subProviderName(entry);
	const oauth = template.buildOAuth(entry.index);
	const modifyModels = template.buildModifyModels?.(name);
	const builtinModels = getModels(entry.provider as any) as Model<Api>[];
	const baseUrl = builtinModels[0]?.baseUrl || "";
	const models = cloneModels(entry.provider, entry.index);

	pi.registerProvider(name, {
		baseUrl,
		api: builtinModels[0]?.api,
		oauth: modifyModels ? { ...oauth, modifyModels } : oauth,
		models,
	});
}

// ==========================================================================
// Pool rotation engine
// ==========================================================================

const RATE_LIMIT_PATTERNS = [
	/usage.?limit/i,
	/rate.?limit/i,
	/limit.*reached/i,
	/too many requests/i,
	/overloaded/i,
	/capacity/i,
	/429/,
	/quota/i,
];

function isRateLimitError(errorMessage: string): boolean {
	return RATE_LIMIT_PATTERNS.some((p) => p.test(errorMessage));
}

interface PoolState {
	/** Current index into pool.members */
	currentIndex: number;
	/** Members that are temporarily "exhausted" (hit limit), with timestamps */
	exhausted: Map<string, number>;
	/** Cooldown period in ms before retrying an exhausted member */
	cooldownMs: number;
}

class PoolManager {
	private pools: Map<string, PoolConfig> = new Map();
	private poolStates: Map<string, PoolState> = new Map();
	/** Map from provider name -> pool name (for quick lookup) */
	private providerToPool: Map<string, string> = new Map();
	private pi: ExtensionAPI;
	private lastRetryPrompt: string | null = null;
	private retryInProgress = false;

	constructor(pi: ExtensionAPI) {
		this.pi = pi;
	}

	loadPools(configs: PoolConfig[]): void {
		this.pools.clear();
		this.providerToPool.clear();

		for (const pool of configs) {
			if (!pool.enabled) continue;
			this.pools.set(pool.name, pool);

			// Initialize state if not exists
			if (!this.poolStates.has(pool.name)) {
				this.poolStates.set(pool.name, {
					currentIndex: 0,
					exhausted: new Map(),
					cooldownMs: 5 * 60 * 1000, // 5 min default cooldown
				});
			}

			// Map each member to this pool
			for (const member of pool.members) {
				this.providerToPool.set(member, pool.name);
			}
		}
	}

	/** Find pool for a given provider name */
	getPoolForProvider(providerName: string): PoolConfig | undefined {
		const poolName = this.providerToPool.get(providerName);
		return poolName ? this.pools.get(poolName) : undefined;
	}

	/** Get available (non-exhausted, authenticated) members of a pool */
	getAvailableMembers(
		pool: PoolConfig,
		authStorage: { hasAuth(provider: string): boolean },
	): string[] {
		const state = this.poolStates.get(pool.name);
		if (!state) return pool.members;

		const now = Date.now();
		return pool.members.filter((member) => {
			// Must have auth
			if (!authStorage.hasAuth(member)) return false;
			// Check if exhausted and still in cooldown
			const exhaustedAt = state.exhausted.get(member);
			if (exhaustedAt && now - exhaustedAt < state.cooldownMs) return false;
			// Clear expired exhaustion
			if (exhaustedAt && now - exhaustedAt >= state.cooldownMs) {
				state.exhausted.delete(member);
			}
			return true;
		});
	}

	/** Mark a member as exhausted (hit rate limit) */
	markExhausted(providerName: string): void {
		const poolName = this.providerToPool.get(providerName);
		if (!poolName) return;
		const state = this.poolStates.get(poolName);
		if (!state) return;
		state.exhausted.set(providerName, Date.now());
	}

	/** Get the next available member in a pool, skipping the current one */
	getNextMember(
		pool: PoolConfig,
		currentProvider: string,
		authStorage: { hasAuth(provider: string): boolean },
	): string | undefined {
		const available = this.getAvailableMembers(pool, authStorage);
		// Filter out current provider
		const candidates = available.filter((m) => m !== currentProvider);
		if (candidates.length === 0) return undefined;

		const state = this.poolStates.get(pool.name);
		if (!state) return candidates[0];

		// Round-robin: advance index
		state.currentIndex = (state.currentIndex + 1) % candidates.length;
		return candidates[state.currentIndex];
	}

	/**
	 * Handle an error: if it's a rate limit and the provider is in a pool,
	 * rotate to the next member and retry.
	 * Returns true if rotation happened.
	 */
	async handleError(
		errorMessage: string,
		currentModel: Model<Api> | undefined,
		ctx: ExtensionContext,
		lastUserPrompt: string | null,
	): Promise<boolean> {
		if (!currentModel) return false;
		if (!isRateLimitError(errorMessage)) return false;
		if (this.retryInProgress) return false;

		const pool = this.getPoolForProvider(currentModel.provider);
		if (!pool) return false;

		// Mark current as exhausted
		this.markExhausted(currentModel.provider);

		// Find next member
		const nextProvider = this.getNextMember(
			pool,
			currentModel.provider,
			ctx.modelRegistry.authStorage,
		);

		if (!nextProvider) {
			ctx.ui.notify(
				`[pool:${pool.name}] All members exhausted. Waiting for cooldown.`,
				"warning",
			);
			return false;
		}

		// Find the same model ID on the next provider
		const nextModel = ctx.modelRegistry.find(nextProvider, currentModel.id);
		if (!nextModel) {
			ctx.ui.notify(
				`[pool:${pool.name}] Model ${currentModel.id} not found on ${nextProvider}`,
				"warning",
			);
			return false;
		}

		// Switch model
		const success = await this.pi.setModel(nextModel);
		if (!success) {
			ctx.ui.notify(
				`[pool:${pool.name}] Failed to switch to ${nextProvider} (no auth)`,
				"warning",
			);
			return false;
		}

		const fromLabel = currentModel.provider;
		const toLabel = nextProvider;
		ctx.ui.notify(
			`[pool:${pool.name}] Rate limited on ${fromLabel}, rotating to ${toLabel}`,
			"info",
		);
		ctx.ui.setStatus("multi-pass", `pool:${pool.name} -> ${toLabel}`);

		// Retry the last prompt
		if (lastUserPrompt) {
			this.retryInProgress = true;
			this.pi.sendUserMessage(lastUserPrompt);
		}

		return true;
	}

	clearRetryFlag(): void {
		this.retryInProgress = false;
	}

	getPoolConfigs(): PoolConfig[] {
		return Array.from(this.pools.values());
	}

	getAllPoolConfigs(config: MultiPassConfig): PoolConfig[] {
		return config.pools || [];
	}
}

// ==========================================================================
// /subs command handlers
// ==========================================================================

async function handleSubsList(ctx: ExtensionCommandContext, config: MultiPassConfig): Promise<void> {
	const envEntries = parseEnvConfig();
	const all = normalizeEntries(mergeConfigs(config, envEntries));

	if (all.length === 0) {
		ctx.ui.notify("No extra subscriptions configured. Use /subs add to create one.", "info");
		return;
	}

	const lines = all.map((entry) => {
		const name = subProviderName(entry);
		const hasAuth = ctx.modelRegistry.authStorage.hasAuth(name);
		const status = hasAuth ? "[logged in]" : "[not logged in]";
		const source = config.subscriptions.find(
			(s) => s.provider === entry.provider && s.index === entry.index,
		)
			? "config"
			: "env";
		return `${subDisplayName(entry)} -- ${status} (${source})`;
	});

	await ctx.ui.select("Extra Subscriptions", lines);
}

async function handleSubsAdd(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	const providerLabels = SUPPORTED_PROVIDERS.map((p) => {
		const t = PROVIDER_TEMPLATES[p];
		return `${p} -- ${t.displayName}`;
	});

	const selected = await ctx.ui.select("Select provider to add", providerLabels);
	if (!selected) return;

	const provider = selected.split(" -- ")[0];
	if (!PROVIDER_TEMPLATES[provider]) {
		ctx.ui.notify(`Unknown provider: ${provider}`, "error");
		return;
	}

	const label = await ctx.ui.input("Label (optional)", "e.g. work, personal");

	const config = loadGlobalConfig();
	const envEntries = parseEnvConfig();
	const allEntries = normalizeEntries(mergeConfigs(config, envEntries));
	const usedIndices = new Set(
		allEntries.filter((e) => e.provider === provider).map((e) => e.index),
	);
	let nextIndex = 2;
	while (usedIndices.has(nextIndex)) nextIndex++;

	const entry: SubEntry = {
		provider,
		index: nextIndex,
		label: label?.trim() || undefined,
	};

	config.subscriptions.push(entry);
	saveGlobalConfig(config);

	registerSub(pi, entry);
	ctx.modelRegistry.refresh();

	const loginNow = await ctx.ui.confirm(
		subDisplayName(entry),
		`Created ${subDisplayName(entry)}.\n\nLogin now?`,
	);

	if (loginNow) {
		ctx.ui.notify(
			`Use /login and select "${PROVIDER_TEMPLATES[entry.provider]?.buildOAuth(entry.index).name}" to authenticate.`,
			"info",
		);
	} else {
		ctx.ui.notify(`Added ${subDisplayName(entry)}. Use /subs login to authenticate.`, "info");
	}
}

async function handleSubsRemove(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	const config = loadGlobalConfig();
	if (config.subscriptions.length === 0) {
		ctx.ui.notify("No saved subscriptions to remove.", "info");
		return;
	}

	const options = config.subscriptions.map((entry) => {
		const name = subProviderName(entry);
		const hasAuth = ctx.modelRegistry.authStorage.hasAuth(name);
		const status = hasAuth ? " [logged in]" : "";
		return `${subDisplayName(entry)}${status}`;
	});

	const selected = await ctx.ui.select("Remove subscription", options);
	if (!selected) return;

	const idx = options.indexOf(selected);
	if (idx < 0) return;

	const entry = config.subscriptions[idx];
	const confirmed = await ctx.ui.confirm(
		"Confirm removal",
		`Remove ${subDisplayName(entry)}?\nThis will also logout if authenticated.`,
	);
	if (!confirmed) return;

	const name = subProviderName(entry);
	if (ctx.modelRegistry.authStorage.hasAuth(name)) {
		ctx.modelRegistry.authStorage.logout(name);
	}
	pi.unregisterProvider(name);

	// Also remove from any pools
	for (const pool of config.pools) {
		pool.members = pool.members.filter((m) => m !== name);
	}
	// Remove empty pools
	config.pools = config.pools.filter((p) => p.members.length > 0);

	config.subscriptions.splice(idx, 1);
	saveGlobalConfig(config);
	ctx.modelRegistry.refresh();
	ctx.ui.notify(`Removed ${subDisplayName(entry)}`, "info");
}

async function handleSubsLogin(ctx: ExtensionCommandContext): Promise<void> {
	const config = loadGlobalConfig();
	const envEntries = parseEnvConfig();
	const all = normalizeEntries(mergeConfigs(config, envEntries));

	const notLoggedIn = all.filter(
		(entry) => !ctx.modelRegistry.authStorage.hasAuth(subProviderName(entry)),
	);

	if (notLoggedIn.length === 0) {
		ctx.ui.notify(
			all.length === 0
				? "No subscriptions configured. Use /subs add first."
				: "All subscriptions are already logged in.",
			"info",
		);
		return;
	}

	const options = notLoggedIn.map((e) => subDisplayName(e));
	const selected = await ctx.ui.select("Login to subscription", options);
	if (!selected) return;

	const idx = options.indexOf(selected);
	if (idx < 0) return;

	const entry = notLoggedIn[idx];
	ctx.ui.notify(
		`Use /login and select "${PROVIDER_TEMPLATES[entry.provider]?.buildOAuth(entry.index).name}" to authenticate.`,
		"info",
	);
}

async function handleSubsLogout(ctx: ExtensionCommandContext): Promise<void> {
	const config = loadGlobalConfig();
	const envEntries = parseEnvConfig();
	const all = normalizeEntries(mergeConfigs(config, envEntries));

	const loggedIn = all.filter((entry) =>
		ctx.modelRegistry.authStorage.hasAuth(subProviderName(entry)),
	);

	if (loggedIn.length === 0) {
		ctx.ui.notify("No subscriptions are currently logged in.", "info");
		return;
	}

	const options = loggedIn.map((e) => subDisplayName(e));
	const selected = await ctx.ui.select("Logout from subscription", options);
	if (!selected) return;

	const idx = options.indexOf(selected);
	if (idx < 0) return;

	const entry = loggedIn[idx];
	ctx.modelRegistry.authStorage.logout(subProviderName(entry));
	ctx.modelRegistry.refresh();
	ctx.ui.notify(`Logged out of ${subDisplayName(entry)}`, "info");
}

async function handleSubsStatus(ctx: ExtensionCommandContext): Promise<void> {
	const config = loadGlobalConfig();
	const envEntries = parseEnvConfig();
	const all = normalizeEntries(mergeConfigs(config, envEntries));

	if (all.length === 0) {
		ctx.ui.notify("No extra subscriptions configured.", "info");
		return;
	}

	const lines: string[] = [];
	for (const entry of all) {
		const name = subProviderName(entry);
		const cred = ctx.modelRegistry.authStorage.get(name);
		const hasAuth = ctx.modelRegistry.authStorage.hasAuth(name);

		let status: string;
		if (!hasAuth) {
			status = "not logged in";
		} else if (cred?.type === "oauth") {
			const expiresIn = cred.expires - Date.now();
			if (expiresIn > 0) {
				const mins = Math.round(expiresIn / 60000);
				status = `logged in (expires ${mins}m)`;
			} else {
				status = "logged in (token expired, will refresh)";
			}
		} else {
			status = "logged in (api key)";
		}

		const modelCount = (getModels(entry.provider as any) as Model<Api>[]).length;
		const source = config.subscriptions.find(
			(s) => s.provider === entry.provider && s.index === entry.index,
		)
			? "saved"
			: "env";

		// Check if in any pool
		const inPools = config.pools
			.filter((p) => p.members.includes(name))
			.map((p) => p.name);
		const poolInfo = inPools.length > 0 ? ` | pools: ${inPools.join(", ")}` : "";

		lines.push(
			`${subDisplayName(entry)} | ${status} | ${modelCount} models | ${source}${poolInfo}`,
		);
	}

	await ctx.ui.select("Subscription Status", lines);
}

// ==========================================================================
// /pool command handlers
// ==========================================================================

/** Get all provider names that belong to a base provider type (including the original) */
function getAllProvidersForBase(
	baseProvider: string,
	allSubs: SubEntry[],
): string[] {
	const providers = [baseProvider]; // original
	for (const entry of allSubs) {
		if (entry.provider === baseProvider) {
			providers.push(subProviderName(entry));
		}
	}
	return providers;
}

async function handlePoolCreate(
	ctx: ExtensionCommandContext,
	poolManager: PoolManager,
): Promise<void> {
	// Pick base provider
	const providerLabels = SUPPORTED_PROVIDERS.map((p) => {
		const t = PROVIDER_TEMPLATES[p];
		return `${p} -- ${t.displayName}`;
	});

	const selectedProvider = await ctx.ui.select("Pool base provider", providerLabels);
	if (!selectedProvider) return;
	const baseProvider = selectedProvider.split(" -- ")[0];

	// Pool name
	const poolName = await ctx.ui.input("Pool name", `e.g. ${baseProvider}-pool`);
	if (!poolName?.trim()) return;

	const config = loadGlobalConfig();
	const envEntries = parseEnvConfig();
	const allSubs = normalizeEntries(mergeConfigs(config, envEntries));

	// Get all providers for this base type
	const allProviders = getAllProvidersForBase(baseProvider, allSubs);

	// Filter to only authenticated ones
	const authedProviders = allProviders.filter((p) =>
		ctx.modelRegistry.authStorage.hasAuth(p),
	);
	const unauthedProviders = allProviders.filter(
		(p) => !ctx.modelRegistry.authStorage.hasAuth(p),
	);

	if (authedProviders.length === 0) {
		ctx.ui.notify(
			`No authenticated ${baseProvider} subscriptions found. Login first with /subs login.`,
			"warning",
		);
		return;
	}

	// Let user pick which to include
	const memberLabels = allProviders.map((p) => {
		const authed = ctx.modelRegistry.authStorage.hasAuth(p);
		return `${p} ${authed ? "[logged in]" : "[not logged in]"}`;
	});

	// Use multiple selects (select each to toggle, done when they cancel)
	const members: string[] = [];
	let selecting = true;
	while (selecting) {
		const remaining = allProviders.filter((p) => !members.includes(p));
		if (remaining.length === 0) break;

		const options = [
			`--- Selected (${members.length}): ${members.join(", ") || "none"} ---`,
			...remaining.map((p) => {
				const authed = ctx.modelRegistry.authStorage.hasAuth(p);
				return `${p} ${authed ? "[logged in]" : "[not logged in]"}`;
			}),
			"[Done - create pool]",
		];

		const picked = await ctx.ui.select("Add members (Esc when done)", options);
		if (!picked || picked.startsWith("---")) {
			if (members.length > 0) selecting = false;
			else {
				ctx.ui.notify("Select at least one member.", "warning");
			}
			continue;
		}
		if (picked === "[Done - create pool]") {
			selecting = false;
			continue;
		}

		const provName = picked.split(" ")[0];
		if (provName && allProviders.includes(provName)) {
			members.push(provName);
		}
	}

	if (members.length < 2) {
		ctx.ui.notify("Pool needs at least 2 members for rotation to be useful.", "warning");
		return;
	}

	const pool: PoolConfig = {
		name: poolName.trim(),
		baseProvider,
		members,
		enabled: true,
	};

	// Check for duplicate name
	const existingIdx = config.pools.findIndex((p) => p.name === pool.name);
	if (existingIdx >= 0) {
		const overwrite = await ctx.ui.confirm(
			"Pool exists",
			`Pool "${pool.name}" already exists. Overwrite?`,
		);
		if (!overwrite) return;
		config.pools[existingIdx] = pool;
	} else {
		config.pools.push(pool);
	}

	saveGlobalConfig(config);
	poolManager.loadPools(config.pools);

	ctx.ui.notify(
		`Created pool "${pool.name}" with ${members.length} members: ${members.join(", ")}`,
		"info",
	);
}

async function handlePoolList(
	ctx: ExtensionCommandContext,
	poolManager: PoolManager,
): Promise<void> {
	const config = loadGlobalConfig();
	const pools = config.pools;

	if (pools.length === 0) {
		ctx.ui.notify("No pools configured. Use /pool create to make one.", "info");
		return;
	}

	const lines = pools.map((pool) => {
		const status = pool.enabled ? "enabled" : "disabled";
		const authedCount = pool.members.filter((m) =>
			ctx.modelRegistry.authStorage.hasAuth(m),
		).length;
		return `${pool.name} | ${pool.baseProvider} | ${pool.members.length} members (${authedCount} authed) | ${status}`;
	});

	await ctx.ui.select("Pools", lines);
}

async function handlePoolToggle(
	ctx: ExtensionCommandContext,
	poolManager: PoolManager,
): Promise<void> {
	const config = loadGlobalConfig();
	if (config.pools.length === 0) {
		ctx.ui.notify("No pools configured.", "info");
		return;
	}

	const options = config.pools.map(
		(p) => `${p.name} -- currently ${p.enabled ? "enabled" : "disabled"}`,
	);

	const selected = await ctx.ui.select("Toggle pool", options);
	if (!selected) return;

	const idx = options.indexOf(selected);
	if (idx < 0) return;

	config.pools[idx].enabled = !config.pools[idx].enabled;
	saveGlobalConfig(config);
	poolManager.loadPools(config.pools);

	const pool = config.pools[idx];
	ctx.ui.notify(
		`Pool "${pool.name}" is now ${pool.enabled ? "enabled" : "disabled"}`,
		"info",
	);
}

async function handlePoolRemove(
	ctx: ExtensionCommandContext,
	poolManager: PoolManager,
): Promise<void> {
	const config = loadGlobalConfig();
	if (config.pools.length === 0) {
		ctx.ui.notify("No pools configured.", "info");
		return;
	}

	const options = config.pools.map(
		(p) => `${p.name} (${p.members.length} members)`,
	);

	const selected = await ctx.ui.select("Remove pool", options);
	if (!selected) return;

	const idx = options.indexOf(selected);
	if (idx < 0) return;

	const pool = config.pools[idx];
	const confirmed = await ctx.ui.confirm(
		"Confirm removal",
		`Remove pool "${pool.name}"? (Subscriptions are kept.)`,
	);
	if (!confirmed) return;

	config.pools.splice(idx, 1);
	saveGlobalConfig(config);
	poolManager.loadPools(config.pools);
	ctx.ui.notify(`Removed pool "${pool.name}"`, "info");
}

async function handlePoolStatus(
	ctx: ExtensionCommandContext,
	poolManager: PoolManager,
): Promise<void> {
	const config = loadGlobalConfig();
	if (config.pools.length === 0) {
		ctx.ui.notify("No pools configured.", "info");
		return;
	}

	const lines: string[] = [];
	for (const pool of config.pools) {
		lines.push(`=== ${pool.name} (${pool.enabled ? "enabled" : "disabled"}) ===`);
		for (const member of pool.members) {
			const authed = ctx.modelRegistry.authStorage.hasAuth(member);
			const available = poolManager
				.getAvailableMembers(pool, ctx.modelRegistry.authStorage)
				.includes(member);
			let status = authed ? "logged in" : "not logged in";
			if (authed && !available) status += " (rate limited, cooling down)";
			lines.push(`  ${member} -- ${status}`);
		}
	}

	await ctx.ui.select("Pool Status", lines);
}

async function handlePoolProject(
	ctx: ExtensionCommandContext,
	poolManager: PoolManager,
): Promise<void> {
	const projectPath = projectConfigPath(ctx.cwd);
	const projectConf = loadProjectConfig(ctx.cwd);
	const globalConf = loadGlobalConfig();

	const hasProjectConfig = projectConf !== undefined;

	const actions: string[] = [];
	if (hasProjectConfig) {
		actions.push(`edit     -- Edit project pool config (${projectPath})`);
		actions.push("clear    -- Remove project config (use global pools)");
	}
	actions.push("restrict -- Set allowed subs for this project");
	actions.push("pools    -- Set project-specific pools");
	actions.push("info     -- Show effective config for this project");

	const selected = await ctx.ui.select(
		`Project Config (${hasProjectConfig ? "active" : "none"})`,
		actions,
	);
	if (!selected) return;

	const action = selected.split(" ")[0].trim();

	if (action === "clear") {
		if (!hasProjectConfig) {
			ctx.ui.notify("No project config to clear.", "info");
			return;
		}
		const confirmed = await ctx.ui.confirm(
			"Clear project config",
			`Remove ${projectPath}?\nGlobal pools will be used instead.`,
		);
		if (!confirmed) return;
		try {
			writeFileSync(projectPath, "{}", "utf-8");
			const effective = loadEffectiveConfig(ctx.cwd);
			poolManager.loadPools(effective.pools);
			ctx.ui.notify("Project config cleared. Using global pools.", "info");
		} catch (err: unknown) {
			ctx.ui.notify(`Failed: ${err instanceof Error ? err.message : String(err)}`, "error");
		}
		return;
	}

	if (action === "restrict") {
		// Show all global subs and let user pick which are allowed
		const envEntries = parseEnvConfig();
		const allSubs = normalizeEntries(mergeConfigs(globalConf, envEntries));
		const allProviderNames = [
			...SUPPORTED_PROVIDERS.filter((p) =>
				ctx.modelRegistry.authStorage.hasAuth(p),
			),
			...allSubs.map((s) => subProviderName(s)),
		];

		if (allProviderNames.length === 0) {
			ctx.ui.notify("No subscriptions available to restrict.", "info");
			return;
		}

		const currentAllowed = projectConf?.allowedSubs || [];
		const allowed: string[] = [];
		let selecting = true;

		while (selecting) {
			const remaining = allProviderNames.filter((p) => !allowed.includes(p));
			if (remaining.length === 0) break;

			const options = [
				`--- Allowed (${allowed.length}): ${allowed.join(", ") || "all (no restriction)"} ---`,
				...remaining.map((p) => {
					const authed = ctx.modelRegistry.authStorage.hasAuth(p);
					const current = currentAllowed.includes(p) ? " [currently allowed]" : "";
					return `${p} ${authed ? "[logged in]" : "[not logged in]"}${current}`;
				}),
				"[Done - save]",
				"[Clear - allow all]",
			];

			const picked = await ctx.ui.select("Select allowed subs (Esc when done)", options);
			if (!picked || picked.startsWith("---")) {
				selecting = false;
				continue;
			}
			if (picked === "[Done - save]") {
				selecting = false;
				continue;
			}
			if (picked === "[Clear - allow all]") {
				allowed.length = 0;
				selecting = false;
				continue;
			}

			const provName = picked.split(" ")[0];
			if (provName && allProviderNames.includes(provName)) {
				allowed.push(provName);
			}
		}

		const newProjectConf: ProjectConfig = {
			...projectConf,
			allowedSubs: allowed.length > 0 ? allowed : undefined,
		};
		saveProjectConfig(ctx.cwd, newProjectConf);

		const effective = loadEffectiveConfig(ctx.cwd);
		poolManager.loadPools(effective.pools);

		if (allowed.length > 0) {
			ctx.ui.notify(
				`Project restricted to: ${allowed.join(", ")}`,
				"info",
			);
		} else {
			ctx.ui.notify("Project restriction cleared. All subs available.", "info");
		}
		return;
	}

	if (action === "pools") {
		// Copy global pools and let user toggle which are active for this project
		const globalPools = globalConf.pools;
		if (globalPools.length === 0) {
			ctx.ui.notify("No global pools defined. Create pools first with /pool create.", "info");
			return;
		}

		const currentProjectPools = projectConf?.pools;
		const options = [
			"[Use global pools (no override)]",
			...globalPools.map((p) => {
				const isIncluded = currentProjectPools
					? currentProjectPools.some((pp) => pp.name === p.name)
					: true;
				return `${p.name} (${p.members.length} members) ${isIncluded ? "[included]" : "[excluded]"}`;
			}),
		];

		const selected2 = await ctx.ui.select("Project pools (select to toggle)", options);
		if (!selected2) return;

		if (selected2 === "[Use global pools (no override)]") {
			const newProjectConf: ProjectConfig = { ...projectConf };
			delete newProjectConf.pools;
			saveProjectConfig(ctx.cwd, newProjectConf);
			const effective = loadEffectiveConfig(ctx.cwd);
			poolManager.loadPools(effective.pools);
			ctx.ui.notify("Project will use global pools.", "info");
			return;
		}

		// Toggle: build project pool list
		const poolName = selected2.split(" (")[0];
		const pool = globalPools.find((p) => p.name === poolName);
		if (!pool) return;

		let projectPools = currentProjectPools ? [...currentProjectPools] : [...globalPools];
		const existingIdx = projectPools.findIndex((p) => p.name === pool.name);
		if (existingIdx >= 0) {
			projectPools.splice(existingIdx, 1);
		} else {
			projectPools.push(pool);
		}

		const newProjectConf: ProjectConfig = { ...projectConf, pools: projectPools };
		saveProjectConfig(ctx.cwd, newProjectConf);
		const effective = loadEffectiveConfig(ctx.cwd);
		poolManager.loadPools(effective.pools);

		const activeNames = projectPools.map((p) => p.name).join(", ") || "none";
		ctx.ui.notify(`Project pools: ${activeNames}`, "info");
		return;
	}

	if (action === "info") {
		const effective = loadEffectiveConfig(ctx.cwd);
		const lines: string[] = [];

		if (effective.projectConfigPath && loadProjectConfig(ctx.cwd)) {
			lines.push(`Project config: ${projectPath}`);
		} else {
			lines.push("Project config: none (using global)");
		}

		const pc = loadProjectConfig(ctx.cwd);
		if (pc?.allowedSubs && pc.allowedSubs.length > 0) {
			lines.push(`Allowed subs: ${pc.allowedSubs.join(", ")}`);
		} else {
			lines.push("Allowed subs: all (no restriction)");
		}

		lines.push("");
		lines.push(`Effective pools (${effective.pools.length}):`);
		for (const pool of effective.pools) {
			const src = pc?.pools ? "project" : "global";
			lines.push(`  ${pool.name} [${src}] -- ${pool.members.join(", ")} (${pool.enabled ? "enabled" : "disabled"})`);
		}

		lines.push("");
		lines.push(`Effective subs (${effective.subscriptions.length}):`);
		for (const sub of effective.subscriptions) {
			const authed = ctx.modelRegistry.authStorage.hasAuth(subProviderName(sub));
			lines.push(`  ${subDisplayName(sub)} -- ${authed ? "logged in" : "not logged in"}`);
		}

		await ctx.ui.select("Effective Config", lines);
		return;
	}
}

async function handlePoolMenu(
	ctx: ExtensionCommandContext,
	poolManager: PoolManager,
): Promise<void> {
	const actions = [
		"create   -- Create a new rotation pool",
		"list     -- Show all pools",
		"toggle   -- Enable/disable a pool",
		"remove   -- Remove a pool",
		"status   -- Detailed pool status with member health",
		"project  -- Project-level pool config (.pi/multi-pass.json)",
	];

	const selected = await ctx.ui.select("Pool Manager", actions);
	if (!selected) return;

	const action = selected.split(" ")[0].trim();
	switch (action) {
		case "create":
			return handlePoolCreate(ctx, poolManager);
		case "list":
			return handlePoolList(ctx, poolManager);
		case "toggle":
			return handlePoolToggle(ctx, poolManager);
		case "remove":
			return handlePoolRemove(ctx, poolManager);
		case "status":
			return handlePoolStatus(ctx, poolManager);
		case "project":
			return handlePoolProject(ctx, poolManager);
	}
}

// ==========================================================================
// /subs main menu (updated)
// ==========================================================================

async function handleSubsMenu(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	poolManager: PoolManager,
): Promise<void> {
	const actions = [
		"list     -- Show all extra subscriptions",
		"add      -- Add a new subscription",
		"remove   -- Remove a subscription",
		"login    -- Login to a subscription",
		"logout   -- Logout from a subscription",
		"status   -- Show auth status and token info",
	];

	const selected = await ctx.ui.select("Subscription Manager", actions);
	if (!selected) return;

	const action = selected.split(" ")[0].trim();
	const config = loadGlobalConfig();
	switch (action) {
		case "list":
			return handleSubsList(ctx, config);
		case "add":
			return handleSubsAdd(pi, ctx);
		case "remove":
			return handleSubsRemove(pi, ctx);
		case "login":
			return handleSubsLogin(ctx);
		case "logout":
			return handleSubsLogout(ctx);
		case "status":
			return handleSubsStatus(ctx);
	}
}

// ==========================================================================
// Extension entry point
// ==========================================================================

export default function multiSub(pi: ExtensionAPI) {
	const config = loadGlobalConfig();
	const envEntries = parseEnvConfig();
	const all = normalizeEntries(mergeConfigs(config, envEntries));

	// Register all subscriptions (always global)
	for (const entry of all) {
		registerSub(pi, entry);
	}

	// Initialize pool manager with global pools (updated on session_start with project config)
	const poolManager = new PoolManager(pi);
	poolManager.loadPools(config.pools);

	// On session start, reload pools with project-level config
	pi.on("session_start", async (_event, ctx) => {
		const effective = loadEffectiveConfig(ctx.cwd);
		poolManager.loadPools(effective.pools);

		const projectConf = loadProjectConfig(ctx.cwd);
		if (projectConf) {
			const poolCount = effective.pools.filter((p) => p.enabled).length;
			const restricted = projectConf.allowedSubs && projectConf.allowedSubs.length > 0;
			const parts: string[] = [];
			if (poolCount > 0) parts.push(`${poolCount} pool(s)`);
			if (restricted) parts.push(`restricted to ${projectConf.allowedSubs!.length} sub(s)`);
			if (parts.length > 0) {
				ctx.ui.setStatus("multi-pass", `project: ${parts.join(", ")}`);
			}
		}
	});

	// Track last user prompt for retry on rotation
	let lastUserPrompt: string | null = null;

	// Listen for user input to track last prompt
	pi.on("before_agent_start", async (event) => {
		lastUserPrompt = event.prompt;
		poolManager.clearRetryFlag();
	});

	// Listen for errors to trigger pool rotation
	pi.on("agent_end", async (event: AgentEndEvent, ctx: ExtensionContext) => {
		if (!event.messages || event.messages.length === 0) return;

		const lastMsg = event.messages[event.messages.length - 1];
		if (!lastMsg || lastMsg.role !== "assistant") return;

		const assistantMsg = lastMsg as any;
		if (assistantMsg.stopReason !== "error") return;
		if (!assistantMsg.errorMessage) return;

		const rotated = await poolManager.handleError(
			assistantMsg.errorMessage,
			ctx.model,
			ctx,
			lastUserPrompt,
		);

		if (!rotated && isRateLimitError(assistantMsg.errorMessage)) {
			// Show which pool members are available
			const pool = ctx.model
				? poolManager.getPoolForProvider(ctx.model.provider)
				: undefined;
			if (pool) {
				const available = poolManager.getAvailableMembers(
					pool,
					ctx.modelRegistry.authStorage,
				);
				if (available.length === 0) {
					ctx.ui.notify(
						`[pool:${pool.name}] All members rate limited. Try again in a few minutes.`,
						"warning",
					);
				}
			}
		}
	});

	// Register /subs command
	pi.registerCommand("subs", {
		description: "Manage extra OAuth subscriptions",
		getArgumentCompletions: (prefix: string) => {
			const subcommands = ["list", "add", "remove", "login", "logout", "status"];
			const filtered = subcommands.filter((s) => s.startsWith(prefix));
			return filtered.length > 0
				? filtered.map((s) => ({ value: s, label: s }))
				: null;
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const config = loadGlobalConfig();
			const subcommand = args.trim().toLowerCase();
			switch (subcommand) {
				case "list":
				case "ls":
					return handleSubsList(ctx, config);
				case "add":
				case "new":
					return handleSubsAdd(pi, ctx);
				case "remove":
				case "rm":
				case "delete":
					return handleSubsRemove(pi, ctx);
				case "login":
					return handleSubsLogin(ctx);
				case "logout":
					return handleSubsLogout(ctx);
				case "status":
				case "info":
					return handleSubsStatus(ctx);
				default:
					return handleSubsMenu(pi, ctx, poolManager);
			}
		},
	});

	// Register /pool command
	pi.registerCommand("pool", {
		description: "Manage subscription rotation pools",
		getArgumentCompletions: (prefix: string) => {
			const subcommands = ["create", "list", "toggle", "remove", "status", "project"];
			const filtered = subcommands.filter((s) => s.startsWith(prefix));
			return filtered.length > 0
				? filtered.map((s) => ({ value: s, label: s }))
				: null;
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const subcommand = args.trim().toLowerCase();
			switch (subcommand) {
				case "create":
				case "new":
					return handlePoolCreate(ctx, poolManager);
				case "list":
				case "ls":
					return handlePoolList(ctx, poolManager);
				case "toggle":
					return handlePoolToggle(ctx, poolManager);
				case "remove":
				case "rm":
				case "delete":
					return handlePoolRemove(ctx, poolManager);
				case "status":
				case "info":
					return handlePoolStatus(ctx, poolManager);
				case "project":
					return handlePoolProject(ctx, poolManager);
				default:
					return handlePoolMenu(ctx, poolManager);
			}
		},
	});
}
