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

interface ChainEntryConfig {
	/** Target pool name to enter when traversing the chain */
	pool: string;
	/** Model to select when entering the target pool */
	model: string;
	/** Whether this chain entry participates in traversal */
	enabled: boolean;
}

interface ChainConfig {
	/** Chain name (user-defined) */
	name: string;
	/** Ordered chain traversal entries */
	entries: ChainEntryConfig[];
	/** Whether chain traversal is enabled */
	enabled: boolean;
}

interface MultiPassConfig {
	subscriptions: SubEntry[];
	pools: PoolConfig[];
	chains: ChainConfig[];
}

/** Project-level config (.pi/multi-pass.json) */
interface ProjectConfig {
	/** Override pools for this project. If set, replaces global pools. */
	pools?: PoolConfig[];
	/** Override chains for this project. If set, replaces global chains. */
	chains?: ChainConfig[];
	/** Restrict which subscriptions can be used. Provider names (e.g. "openai-codex-2").
	 *  If set, only these subs (plus the originals) are available in this project.
	 *  If not set, all global subs are available. */
	allowedSubs?: string[];
}

/** Effective config after merging global + project */
interface EffectiveConfig {
	subscriptions: SubEntry[];
	pools: PoolConfig[];
	chains: ChainConfig[];
	/** Which project config was loaded from, if any */
	projectConfigPath?: string;
}

function globalConfigPath(): string {
	return join(getAgentDir(), "multi-pass.json");
}

function projectConfigPath(cwd: string): string {
	return join(cwd, ".pi", "multi-pass.json");
}

function emptyMultiPassConfig(): MultiPassConfig {
	return { subscriptions: [], pools: [], chains: [] };
}

function normalizeMultiPassConfig(raw: unknown): MultiPassConfig {
	const parsed = raw && typeof raw === "object" ? (raw as Partial<MultiPassConfig>) : {};
	return {
		subscriptions: Array.isArray(parsed.subscriptions) ? parsed.subscriptions : [],
		pools: Array.isArray(parsed.pools) ? parsed.pools : [],
		chains: Array.isArray(parsed.chains) ? parsed.chains : [],
	};
}

function normalizeProjectConfig(raw: unknown): ProjectConfig {
	const parsed = raw && typeof raw === "object" ? (raw as Partial<ProjectConfig>) : {};
	const config: ProjectConfig = {};
	if (Array.isArray(parsed.pools)) config.pools = parsed.pools;
	if (Array.isArray(parsed.chains)) config.chains = parsed.chains;
	if (Array.isArray(parsed.allowedSubs)) config.allowedSubs = parsed.allowedSubs;
	return config;
}

function loadGlobalConfig(): MultiPassConfig {
	const path = globalConfigPath();
	if (!existsSync(path)) return emptyMultiPassConfig();
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8"));
		return normalizeMultiPassConfig(raw);
	} catch {
		return emptyMultiPassConfig();
	}
}

function loadProjectConfig(cwd: string): ProjectConfig | undefined {
	const path = projectConfigPath(cwd);
	if (!existsSync(path)) return undefined;
	try {
		return normalizeProjectConfig(JSON.parse(readFileSync(path, "utf-8")));
	} catch {
		return undefined;
	}
}

function loadEffectiveConfig(cwd: string): EffectiveConfig {
	const global = loadGlobalConfig();
	const project = loadProjectConfig(cwd);

	if (!project) {
		return {
			subscriptions: global.subscriptions,
			pools: global.pools,
			chains: global.chains,
		};
	}

	// Subscriptions are always global, but filter if allowedSubs is set
	let subs = global.subscriptions;
	if (project.allowedSubs && project.allowedSubs.length > 0) {
		const allowed = new Set(project.allowedSubs);
		subs = global.subscriptions.filter((s) => allowed.has(subProviderName(s)));
	}

	// Pools/chains: project overrides global if defined
	const pools = project.pools !== undefined ? project.pools : global.pools;
	const chains = project.chains !== undefined ? project.chains : global.chains;

	return {
		subscriptions: subs,
		pools,
		chains,
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
	private cascadeState: FailoverCascadeState | null = null;
	private suppressNextStartTurn = false;

	constructor(pi: ExtensionAPI) {
		this.pi = pi;
	}

	private getOrCreatePoolState(poolName: string): PoolState {
		let state = this.poolStates.get(poolName);
		if (!state) {
			state = {
				currentIndex: 0,
				exhausted: new Map(),
				cooldownMs: 5 * 60 * 1000, // 5 min default cooldown
			};
			this.poolStates.set(poolName, state);
		}
		return state;
	}

	loadPools(configs: PoolConfig[]): void {
		this.pools.clear();
		this.providerToPool.clear();

		const activePoolNames = new Set<string>();
		for (const pool of configs) {
			if (!pool.enabled) continue;
			activePoolNames.add(pool.name);
			this.pools.set(pool.name, pool);

			const state = this.getOrCreatePoolState(pool.name);
			state.currentIndex = pool.members.length > 0 ? state.currentIndex % pool.members.length : 0;
			for (const member of Array.from(state.exhausted.keys())) {
				if (!pool.members.includes(member)) {
					state.exhausted.delete(member);
				}
			}

			// Map each member to this pool
			for (const member of pool.members) {
				this.providerToPool.set(member, pool.name);
			}
		}

		for (const poolName of Array.from(this.poolStates.keys())) {
			if (!activePoolNames.has(poolName)) {
				this.poolStates.delete(poolName);
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
		const state = this.getOrCreatePoolState(pool.name);
		const now = Date.now();
		return pool.members.filter((member) => {
			if (!authStorage.hasAuth(member)) return false;
			const exhaustedAt = state.exhausted.get(member);
			if (exhaustedAt && now - exhaustedAt < state.cooldownMs) return false;
			if (exhaustedAt && now - exhaustedAt >= state.cooldownMs) {
				state.exhausted.delete(member);
			}
			return true;
		});
	}

	isMemberExhausted(pool: PoolConfig, provider: string): boolean {
		const state = this.getOrCreatePoolState(pool.name);
		const exhaustedAt = state.exhausted.get(provider);
		if (!exhaustedAt) return false;
		if (Date.now() - exhaustedAt >= state.cooldownMs) {
			state.exhausted.delete(provider);
			return false;
		}
		return true;
	}

	getEnabledChains(config: MultiPassConfig): ChainConfig[] {
		return config.chains.filter((chain) => chain.enabled);
	}

	findApplicableChain(poolName: string, config: MultiPassConfig): {
		chain: ChainConfig;
		index: number;
	} | undefined {
		for (const chain of this.getEnabledChains(config)) {
			const index = chain.entries.findIndex((entry) => entry.pool === poolName);
			if (index >= 0) {
				return { chain, index };
			}
		}
		return undefined;
	}

	buildFailoverPlan(
		currentModel: Model<Api>,
		config: MultiPassConfig,
		authStorage: { hasAuth(provider: string): boolean },
		options?: FailoverPlanOptions,
	): FailoverPlan {
		const attemptedProviders = options?.attemptedProviders ?? new Set<string>();
		const visitedChainIndexes = options?.visitedChainIndexes ?? new Set<number>();
		const pool = this.getPoolForProvider(currentModel.provider);
		if (!pool) {
			return { candidates: [], skips: [] };
		}

		const skips: FailoverSkip[] = [];
		const candidates: FailoverCandidate[] = [];
		const poolSize = pool.members.length;
		const currentIndex = pool.members.indexOf(currentModel.provider);
		const startIndex = currentIndex >= 0 ? currentIndex : 0;

		for (let step = 1; step <= poolSize; step++) {
			const candidateIndex = poolSize <= 0 ? -1 : (startIndex + step) % poolSize;
			if (candidateIndex < 0) break;
			const candidate = pool.members[candidateIndex];
			if (candidate === currentModel.provider) continue;
			if (attemptedProviders.has(candidate)) {
				skips.push({
					type: "pool-member",
					poolName: pool.name,
					reason: "already-attempted",
					detail: `${candidate} skipped (already attempted this turn)`,
				});
				continue;
			}
			const skip = classifyPoolMemberSkip(
				pool.name,
				candidate,
				authStorage,
				this.isMemberExhausted(pool, candidate),
			);
			if (skip) {
				skips.push(skip);
				continue;
			}
			candidates.push({
				poolName: pool.name,
				provider: candidate,
				modelId: currentModel.id,
				source: "pool",
			});
		}

		const applicable = this.findApplicableChain(pool.name, config);
		if (!applicable) {
			return { pool, candidates, skips };
		}

		for (let chainIndex = applicable.index + 1; chainIndex < applicable.chain.entries.length; chainIndex++) {
			const entry = applicable.chain.entries[chainIndex];
			if (visitedChainIndexes.has(chainIndex)) {
				skips.push({
					type: "chain-entry",
					poolName: entry.pool,
					reason: "already-visited-chain-entry",
					detail: `${entry.pool} -> ${entry.model} skipped (chain entry already visited this turn)`,
					chainName: applicable.chain.name,
					chainIndex,
				});
				continue;
			}
			const entrySkip = classifyChainEntrySkip(applicable.chain, chainIndex, entry, config);
			if (entrySkip) {
				skips.push(entrySkip);
				continue;
			}
			const targetPool = config.pools.find((candidate) => candidate.name === entry.pool);
			if (!targetPool) {
				skips.push({
					type: "chain-entry",
					poolName: entry.pool,
					reason: "missing-pool",
					detail: `${entry.pool} -> ${entry.model} skipped (pool missing)`,
					chainName: applicable.chain.name,
					chainIndex,
				});
				continue;
			}
			let foundEligible = false;
			for (const member of targetPool.members) {
				if (attemptedProviders.has(member)) {
					skips.push({
						type: "pool-member",
						poolName: targetPool.name,
						reason: "already-attempted",
						detail: `${member} skipped (already attempted this turn)`,
						chainName: applicable.chain.name,
						chainIndex,
					});
					continue;
				}
				const memberSkip = classifyPoolMemberSkip(
					targetPool.name,
					member,
					authStorage,
					this.isMemberExhausted(targetPool, member),
				);
				if (memberSkip) {
					skips.push({
						...memberSkip,
						chainName: applicable.chain.name,
						chainIndex,
					});
					continue;
				}
				foundEligible = true;
				candidates.push({
					poolName: targetPool.name,
					provider: member,
					modelId: entry.model,
					source: "chain",
					chainName: applicable.chain.name,
					chainIndex,
				});
			}
			if (!foundEligible) {
				skips.push({
					type: "chain-entry",
					poolName: targetPool.name,
					reason: "no-eligible-members",
					detail: `${targetPool.name} -> ${entry.model} skipped (no eligible members)`,
					chainName: applicable.chain.name,
					chainIndex,
				});
			}
		}

		return {
			pool,
			chain: applicable.chain,
			currentChainIndex: applicable.index,
			candidates,
			skips,
		};
	}

	/** Mark a member as exhausted (hit rate limit) */
	markExhausted(providerName: string): void {
		const poolName = this.providerToPool.get(providerName);
		if (!poolName) return;
		const state = this.getOrCreatePoolState(poolName);
		state.exhausted.set(providerName, Date.now());
	}

	/** Get the next available member in a pool, skipping the current one */
	getNextMember(
		pool: PoolConfig,
		currentProvider: string,
		authStorage: { hasAuth(provider: string): boolean },
	): string | undefined {
		const state = this.getOrCreatePoolState(pool.name);
		const available = this.getAvailableMembers(pool, authStorage);
		if (available.length === 0) return undefined;

		const poolSize = pool.members.length;
		if (poolSize <= 1) {
			return available[0] === currentProvider ? undefined : available[0];
		}

		const currentIndex = pool.members.indexOf(currentProvider);
		const startIndex = currentIndex >= 0 ? currentIndex : state.currentIndex % poolSize;

		for (let step = 1; step <= poolSize; step++) {
			const candidateIndex = (startIndex + step) % poolSize;
			const candidate = pool.members[candidateIndex];
			if (candidate === currentProvider) continue;
			if (!available.includes(candidate)) continue;
			state.currentIndex = candidateIndex;
			return candidate;
		}

		return undefined;
	}

	private ensureCascadeState(prompt: string | null, currentModel: Model<Api>): FailoverCascadeState {
		if (!prompt) {
			const fallbackState: FailoverCascadeState = {
				prompt: "",
				attemptedProviders: new Set([currentModel.provider]),
				visitedChainIndexes: new Set<number>(),
			};
			this.cascadeState = fallbackState;
			return fallbackState;
		}

		if (!this.cascadeState || this.cascadeState.prompt !== prompt) {
			this.cascadeState = {
				prompt,
				attemptedProviders: new Set([currentModel.provider]),
				visitedChainIndexes: new Set<number>(),
			};
		} else {
			this.cascadeState.attemptedProviders.add(currentModel.provider);
		}

		return this.cascadeState;
	}

	startTurn(prompt: string | null, currentModel?: Model<Api>): void {
		if (this.suppressNextStartTurn) {
			this.suppressNextStartTurn = false;
			return;
		}
		if (!prompt) {
			this.cascadeState = null;
			return;
		}
		if (!this.cascadeState || this.cascadeState.prompt !== prompt) {
			this.cascadeState = {
				prompt,
				attemptedProviders: new Set(currentModel ? [currentModel.provider] : []),
				visitedChainIndexes: new Set<number>(),
			};
			return;
		}
		if (currentModel) {
			this.cascadeState.attemptedProviders.add(currentModel.provider);
		}
	}

	clearCascadeState(): void {
		this.cascadeState = null;
	}

	getCascadeStateSnapshot():
		| { prompt: string; attemptedProviders: string[]; visitedChainIndexes: number[] }
		| null {
		if (!this.cascadeState) return null;
		return {
			prompt: this.cascadeState.prompt,
			attemptedProviders: [...this.cascadeState.attemptedProviders],
			visitedChainIndexes: [...this.cascadeState.visitedChainIndexes],
		};
	}

	/**
	 * Handle an error: if it's a rate limit and the provider is in a pool,
	 * build an ordered failover plan, switch to the first usable candidate, and retry.
	 * Returns true if rotation happened.
	 */
	async handleError(
		errorMessage: string,
		currentModel: Model<Api> | undefined,
		ctx: ExtensionContext,
		lastUserPrompt: string | null,
		config: MultiPassConfig,
	): Promise<boolean> {
		if (!currentModel) return false;
		if (!isRateLimitError(errorMessage)) return false;

		const pool = this.getPoolForProvider(currentModel.provider);
		if (!pool) return false;

		const cascade = this.ensureCascadeState(lastUserPrompt, currentModel);

		// Mark current as exhausted before planning the forward-only cascade.
		this.markExhausted(currentModel.provider);

		const plan = this.buildFailoverPlan(
			currentModel,
			config,
			ctx.modelRegistry.authStorage,
			{
				attemptedProviders: cascade.attemptedProviders,
				visitedChainIndexes: cascade.visitedChainIndexes,
			},
		);
		const continuation = formatFailoverContinuation(plan.candidates[0]);
		for (const skip of plan.skips) {
			ctx.ui.notify(
				`[pool:${skip.poolName}] ${skip.detail}; ${continuation}`,
				"warning",
			);
		}

		const nextCandidate = plan.candidates[0];
		if (!nextCandidate) {
			ctx.ui.notify(formatFailoverExhausted(pool.name, currentModel.provider), "warning");
			ctx.ui.setStatus("multi-pass", formatFailoverStatus(null, pool.name));
			return false;
		}

		const nextModel = ctx.modelRegistry.find(nextCandidate.provider, nextCandidate.modelId);
		if (!nextModel) {
			ctx.ui.notify(
				`[pool:${nextCandidate.poolName}] ${nextCandidate.provider} -> ${nextCandidate.modelId} skipped (model missing at runtime); cascade exhausted; no later eligible target`,
				"warning",
			);
			ctx.ui.notify(formatFailoverExhausted(pool.name, currentModel.provider), "warning");
			ctx.ui.setStatus("multi-pass", formatFailoverStatus(null, pool.name));
			return false;
		}

		const success = await this.pi.setModel(nextModel);
		if (!success) {
			ctx.ui.notify(
				`[pool:${nextCandidate.poolName}] ${nextCandidate.provider} skipped (authentication unavailable during switch); cascade exhausted; no later eligible target`,
				"warning",
			);
			ctx.ui.notify(formatFailoverExhausted(pool.name, currentModel.provider), "warning");
			ctx.ui.setStatus("multi-pass", formatFailoverStatus(null, pool.name));
			return false;
		}

		cascade.attemptedProviders.add(nextCandidate.provider);
		if (typeof nextCandidate.chainIndex === "number") {
			cascade.visitedChainIndexes.add(nextCandidate.chainIndex);
		}

		ctx.ui.notify(
			formatFailoverTransition(pool.name, currentModel.provider, nextCandidate),
			"info",
		);
		ctx.ui.setStatus("multi-pass", formatFailoverStatus(nextCandidate));

		if (lastUserPrompt) {
			this.suppressNextStartTurn = true;
			this.pi.sendUserMessage(lastUserPrompt);
		}

		return true;
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

function createPoolValidationMessage(members: string[]): string | null {
	if (members.length < 1) {
		return "Pool needs at least 1 member.";
	}
	return null;
}

function buildPoolConfig(input: {
	name: string;
	baseProvider: string;
	members: string[];
	enabled?: boolean;
}): { ok: true; pool: PoolConfig } | { ok: false; error: string } {
	const name = input.name.trim();
	if (!name) {
		return { ok: false, error: "Pool name is required." };
	}
	const validation = createPoolValidationMessage(input.members);
	if (validation) {
		return { ok: false, error: validation };
	}
	return {
		ok: true,
		pool: {
			name,
			baseProvider: input.baseProvider,
			members: [...input.members],
			enabled: input.enabled ?? true,
		},
	};
}

function persistPoolConfig(
	config: MultiPassConfig,
	pool: PoolConfig,
): { action: "created" | "updated"; config: MultiPassConfig } {
	const existingIdx = config.pools.findIndex((candidate) => candidate.name === pool.name);
	if (existingIdx >= 0) {
		config.pools[existingIdx] = pool;
		return { action: "updated", config };
	}
	config.pools.push(pool);
	return { action: "created", config };
}

async function promptForPoolDefinition(
	ctx: ExtensionCommandContext,
	options?: {
		allowOverwrite?: boolean;
		resumeChainName?: string;
	},
): Promise<PoolConfig | undefined> {
	const config = loadGlobalConfig();
	const envEntries = parseEnvConfig();
	const allSubs = normalizeEntries(mergeConfigs(config, envEntries));
	const providerLabels = SUPPORTED_PROVIDERS.map((p) => {
		const t = PROVIDER_TEMPLATES[p];
		return `${p} -- ${t.displayName}`;
	});

	const selectedProvider = await ctx.ui.select("Pool base provider", providerLabels);
	if (!selectedProvider) return undefined;
	const baseProvider = selectedProvider.split(" -- ")[0];

	const poolName = await ctx.ui.input("Pool name", `e.g. ${baseProvider}-pool`);
	if (!poolName?.trim()) return undefined;

	const allProviders = getAllProvidersForBase(baseProvider, allSubs);
	const authedProviders = allProviders.filter((p) =>
		ctx.modelRegistry.authStorage.hasAuth(p),
	);

	if (authedProviders.length === 0) {
		ctx.ui.notify(
			`No authenticated ${baseProvider} subscriptions found. Login first with /subs login.`,
			"warning",
		);
		return undefined;
	}

	const members: string[] = [];
	let selecting = true;
	while (selecting) {
		const remaining = allProviders.filter((p) => !members.includes(p));
		if (remaining.length === 0) break;

		const optionsList = [
			`--- Selected (${members.length}): ${members.join(", ") || "none"} ---`,
			...remaining.map((p) => {
				const authed = ctx.modelRegistry.authStorage.hasAuth(p);
				return `${p} ${authed ? "[logged in]" : "[not logged in]"}`;
			}),
			"[Done - create pool]",
		];

		const picked = await ctx.ui.select("Add members ([Done] saves, Esc cancels)", optionsList);
		if (!picked) {
			ctx.ui.notify(`Cancelled pool creation${poolName ? ` for "${poolName}"` : ""}.`, "info");
			return undefined;
		}
		if (picked.startsWith("---")) {
			continue;
		}
		if (picked === "[Done - create pool]") {
			if (members.length === 0) {
				ctx.ui.notify("Select at least one member.", "warning");
				continue;
			}
			selecting = false;
			continue;
		}

		const provName = picked.split(" ")[0];
		if (provName && allProviders.includes(provName)) {
			members.push(provName);
		}
	}

	const built = buildPoolConfig({ name: poolName, baseProvider, members, enabled: true });
	if (!built.ok) {
		ctx.ui.notify(built.error, "warning");
		return undefined;
	}

	const existing = config.pools.find((pool) => pool.name === built.pool.name);
	if (existing && !options?.allowOverwrite) {
		ctx.ui.notify(`Pool "${built.pool.name}" already exists.`, "warning");
		return undefined;
	}
	if (existing && options?.allowOverwrite) {
		const overwrite = await ctx.ui.confirm(
			"Pool exists",
			`Pool "${built.pool.name}" already exists. Overwrite?`,
		);
		if (!overwrite) return undefined;
	}

	if (options?.resumeChainName) {
		ctx.ui.notify(
			`Prepared pool "${built.pool.name}" for chain "${options.resumeChainName}".`,
			"info",
		);
	}

	return built.pool;
}

async function createAndPersistPool(
	ctx: ExtensionCommandContext,
	poolManager: PoolManager,
	options?: {
		allowOverwrite?: boolean;
		resumeChainName?: string;
	},
): Promise<PoolConfig | undefined> {
	const pool = await promptForPoolDefinition(ctx, options);
	if (!pool) return undefined;

	const config = loadGlobalConfig();
	const persisted = persistPoolConfig(config, pool);
	saveGlobalConfig(persisted.config);
	poolManager.loadPools(persisted.config.pools);

	const resumeSuffix = options?.resumeChainName
		? ` Chain builder resumed for "${options.resumeChainName}".`
		: "";
	ctx.ui.notify(
		`${persisted.action === "created" ? "Created" : "Updated"} pool "${pool.name}" with ${pool.members.length} member${pool.members.length === 1 ? "" : "s"}: ${pool.members.join(", ")}.${resumeSuffix}`,
		"info",
	);
	return pool;
}

function getSelectableModelsForPool(pool: PoolConfig): string[] {
	return (getModels(pool.baseProvider as any) as Model<Api>[]).map((model) => model.id);
}

function createChainValidationError(
	config: MultiPassConfig,
	chain: ChainConfig,
): string | null {
	if (!chain.name.trim()) {
		return "Chain name is required.";
	}
	if (findChainByName(config.chains, chain.name)) {
		return `Chain "${chain.name}" already exists.`;
	}
	if (chain.entries.length === 0) {
		return `Chain "${chain.name}" needs at least 1 entry.`;
	}

	for (const entry of chain.entries) {
		const pool = config.pools.find((candidate) => candidate.name === entry.pool);
		if (!pool) {
			return `Chain entry pool "${entry.pool}" does not exist.`;
		}
		const selectableModels = getSelectableModelsForPool(pool);
		if (selectableModels.length === 0) {
			return `Pool "${pool.name}" has no selectable models for ${pool.baseProvider}.`;
		}
		if (!selectableModels.includes(entry.model)) {
			return `Model "${entry.model}" is not available for pool "${pool.name}".`;
		}
	}

	return null;
}

function buildChainConfig(
	config: MultiPassConfig,
	input: { name: string; entries: ChainEntryConfig[]; enabled?: boolean },
): { ok: true; chain: ChainConfig } | { ok: false; error: string } {
	const chain: ChainConfig = {
		name: input.name.trim(),
		entries: input.entries.map((entry) => ({ ...entry })),
		enabled: input.enabled ?? true,
	};
	const validationError = createChainValidationError(config, chain);
	if (validationError) {
		return { ok: false, error: validationError };
	}
	return { ok: true, chain };
}

async function handlePoolCreate(
	ctx: ExtensionCommandContext,
	poolManager: PoolManager,
): Promise<void> {
	await createAndPersistPool(ctx, poolManager, { allowOverwrite: true });
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

	const options = config.pools.map((p) => {
		const memberLabel = p.members.length === 1 ? "member" : "members";
		return `${p.name} (${p.members.length} ${memberLabel})`;
	});

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

function summarizePoolHealth(
	pool: PoolConfig,
	authStorage: { hasAuth(provider: string): boolean },
	poolManager: Pick<PoolManager, "getAvailableMembers" | "isMemberExhausted">,
): {
	availableCount: number;
	authedCount: number;
	memberCount: number;
	unavailableCount: number;
	statusLabel: string;
} {
	const availableMembers = pool.enabled
		? poolManager.getAvailableMembers(pool, authStorage)
		: [];
	const availableSet = new Set(availableMembers);
	let authedCount = 0;
	for (const member of pool.members) {
		if (authStorage.hasAuth(member)) authedCount += 1;
	}
	const availableCount = availableMembers.length;
	const memberCount = pool.members.length;
	const unavailableCount = memberCount - availableCount;
	let statusLabel = `${availableCount}/${memberCount} available`;
	if (!pool.enabled) {
		statusLabel += " | pool disabled";
	} else if (memberCount === 0) {
		statusLabel += " | no members configured";
	} else if (availableCount === 0) {
		if (authedCount === 0) {
			statusLabel += " | no auth";
		} else {
			statusLabel += " | cooldown/no eligible members";
		}
	}
	return {
		availableCount,
		authedCount,
		memberCount,
		unavailableCount,
		statusLabel,
	};
}

function formatPoolListLine(
	pool: PoolConfig,
	authStorage: { hasAuth(provider: string): boolean },
	poolManager: Pick<PoolManager, "getAvailableMembers" | "isMemberExhausted">,
): string {
	const summary = summarizePoolHealth(pool, authStorage, poolManager);
	const status = pool.enabled ? "enabled" : "disabled";
	return `${pool.name} | ${pool.baseProvider} | ${summary.memberCount} member${summary.memberCount === 1 ? "" : "s"} (${summary.authedCount} authed, ${summary.availableCount} available) | ${status}${summary.unavailableCount > 0 ? ` | ${summary.unavailableCount} unavailable` : ""}`;
}

function formatPoolStatusLines(
	pool: PoolConfig,
	authStorage: { hasAuth(provider: string): boolean },
	poolManager: Pick<PoolManager, "getAvailableMembers" | "isMemberExhausted">,
): string[] {
	const summary = summarizePoolHealth(pool, authStorage, poolManager);
	const lines = [
		`=== ${pool.name} (${pool.enabled ? "enabled" : "disabled"}) ===`,
		`provider: ${pool.baseProvider}`,
		`members: ${summary.memberCount}`,
		`availability: ${summary.statusLabel}`,
	];
	if (pool.members.length === 0) {
		lines.push("  [no members configured]");
		return lines;
	}
	for (const member of pool.members) {
		const authed = authStorage.hasAuth(member);
		const exhausted = pool.enabled && authed && poolManager.isMemberExhausted(pool, member);
		let status = authed ? "logged in" : "not logged in";
		if (exhausted) status += " (rate limited, cooling down)";
		if (pool.enabled && authed && !exhausted) status += " (available)";
		if (!pool.enabled && authed) status += " (pool disabled)";
		lines.push(`  ${member} -- ${status}`);
	}
	return lines;
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
		lines.push(
			...formatPoolStatusLines(pool, ctx.modelRegistry.authStorage, poolManager),
		);
	}

	await ctx.ui.select("Pool Status", lines);
}

function findChainByName(chains: ChainConfig[], name: string): ChainConfig | undefined {
	return chains.find((chain) => chain.name === name);
}

function getChainEntryIssue(entry: ChainEntryConfig, config: MultiPassConfig): string | null {
	const pool = config.pools.find((candidate) => candidate.name === entry.pool);
	if (!pool) {
		return `invalid pool: ${entry.pool} missing`;
	}
	if (!pool.enabled) {
		return `invalid pool: ${pool.name} disabled`;
	}
	const selectableModels = getSelectableModelsForPool(pool);
	if (selectableModels.length === 0) {
		return `invalid model: no selectable models for ${pool.baseProvider}`;
	}
	if (!selectableModels.includes(entry.model)) {
		return `invalid model: ${entry.model} unavailable for ${pool.name}`;
	}
	return null;
}

interface FailoverCandidate {
	poolName: string;
	provider: string;
	modelId: string;
	source: "pool" | "chain";
	chainName?: string;
	chainIndex?: number;
}

interface FailoverSkip {
	type: "pool-member" | "chain-entry";
	poolName: string;
	reason:
		| "no-auth"
		| "exhausted"
		| "missing-pool"
		| "disabled-entry"
		| "disabled-pool"
		| "unavailable-model"
		| "no-eligible-members"
		| "already-attempted"
		| "already-visited-chain-entry";
	detail: string;
	chainName?: string;
	chainIndex?: number;
}

interface FailoverPlanOptions {
	attemptedProviders?: Set<string>;
	visitedChainIndexes?: Set<number>;
}

interface FailoverPlan {
	pool?: PoolConfig;
	chain?: ChainConfig;
	currentChainIndex?: number;
	candidates: FailoverCandidate[];
	skips: FailoverSkip[];
}

interface FailoverCascadeState {
	prompt: string;
	attemptedProviders: Set<string>;
	visitedChainIndexes: Set<number>;
}

function formatFailoverTarget(candidate: Pick<FailoverCandidate, "provider" | "modelId">): string {
	return `${candidate.provider} (${candidate.modelId})`;
}

function formatFailoverStatus(
	candidate:
		| Pick<FailoverCandidate, "provider" | "modelId" | "source" | "poolName" | "chainName" | "chainIndex">
		| null,
	fallbackPoolName?: string,
): string {
	if (!candidate) {
		return fallbackPoolName
			? `pool:${fallbackPoolName} | cascade exhausted | no eligible target`
			: "cascade exhausted | no eligible target";
	}
	const scope = candidate.source === "chain"
		? `chain:${candidate.chainName}#${(candidate.chainIndex ?? 0) + 1}`
		: `pool:${candidate.poolName}`;
	return `${scope} | active ${formatFailoverTarget(candidate)}`;
}

function formatFailoverContinuation(
	nextCandidate: Pick<FailoverCandidate, "provider" | "modelId" | "source" | "poolName" | "chainName" | "chainIndex"> | undefined,
): string {
	if (!nextCandidate) {
		return "cascade exhausted; no later eligible target";
	}
	const phase = nextCandidate.source === "chain"
		? `continuing forward to chain ${nextCandidate.chainName}#${(nextCandidate.chainIndex ?? 0) + 1}`
		: `continuing within pool ${nextCandidate.poolName}`;
	return `${phase} -> ${formatFailoverTarget(nextCandidate)}`;
}

function formatFailoverTransition(
	poolName: string,
	currentProvider: string,
	nextCandidate: Pick<FailoverCandidate, "provider" | "modelId" | "source" | "poolName" | "chainName" | "chainIndex">,
): string {
	const phase = nextCandidate.source === "chain"
		? `advancing to chain ${nextCandidate.chainName}#${(nextCandidate.chainIndex ?? 0) + 1}`
		: `rotating within pool ${poolName}`;
	return `[pool:${poolName}] Rate limited on ${currentProvider}; ${phase}; active ${formatFailoverTarget(nextCandidate)}`;
}

function formatFailoverExhausted(poolName: string, currentProvider: string): string {
	return `[pool:${poolName}] Failover exhausted after ${currentProvider}; no eligible target remained in this cascade.`;
}

function classifyPoolMemberSkip(
	poolName: string,
	provider: string,
	authStorage: { hasAuth(provider: string): boolean },
	exhausted: boolean,
): FailoverSkip | null {
	if (!authStorage.hasAuth(provider)) {
		return {
			type: "pool-member",
			poolName,
			reason: "no-auth",
			detail: `${provider} skipped (no auth)` ,
		};
	}
	if (exhausted) {
		return {
			type: "pool-member",
			poolName,
			reason: "exhausted",
			detail: `${provider} skipped (cooldown active)`,
		};
	}
	return null;
}

function classifyChainEntrySkip(
	chain: ChainConfig,
	chainIndex: number,
	entry: ChainEntryConfig,
	config: MultiPassConfig,
): FailoverSkip | null {
	if (!entry.enabled) {
		return {
			type: "chain-entry",
			poolName: entry.pool,
			reason: "disabled-entry",
			detail: `${entry.pool} -> ${entry.model} skipped (entry disabled)`,
			chainName: chain.name,
			chainIndex,
		};
	}
	const issue = getChainEntryIssue(entry, config);
	if (!issue) return null;
	const reason = issue.includes("missing")
		? "missing-pool"
		: issue.includes("disabled")
			? "disabled-pool"
			: "unavailable-model";
	return {
		type: "chain-entry",
		poolName: entry.pool,
		reason,
		detail: `${entry.pool} -> ${entry.model} skipped (${issue})`,
		chainName: chain.name,
		chainIndex,
	};
}

function formatChainEntryStatus(
	entry: ChainEntryConfig,
	config?: MultiPassConfig,
	authStorage?: { hasAuth(provider: string): boolean },
	poolManager?: Pick<PoolManager, "getAvailableMembers" | "isMemberExhausted">,
): string {
	const entryState = entry.enabled ? "enabled" : "disabled";
	const issue = config ? getChainEntryIssue(entry, config) : null;
	let healthSuffix = "";
	if (config && authStorage && poolManager) {
		const pool = config.pools.find((candidate) => candidate.name === entry.pool);
		if (pool) {
			const summary = summarizePoolHealth(pool, authStorage, poolManager);
			healthSuffix = ` | pool ${pool.enabled ? "enabled" : "disabled"} | ${summary.availableCount}/${summary.memberCount} available | ${summary.authedCount} authed`;
		}
	}
	const issueSuffix = issue ? ` | ${issue} | skipped` : "";
	return `${entry.pool} -> ${entry.model} (${entryState}${healthSuffix}${issueSuffix})`;
}

function formatChainListLine(
	chain: ChainConfig,
	config?: MultiPassConfig,
	authStorage?: { hasAuth(provider: string): boolean },
	poolManager?: Pick<PoolManager, "getAvailableMembers" | "isMemberExhausted">,
): string {
	const entryLabel = chain.entries.length === 1 ? "entry" : "entries";
	const invalidEntries = config
		? chain.entries.filter((entry) => getChainEntryIssue(entry, config)).length
		: 0;
	let usableEntries = 0;
	if (config && authStorage && poolManager) {
		usableEntries = chain.entries.filter((entry) => {
			if (!entry.enabled) return false;
			if (getChainEntryIssue(entry, config)) return false;
			const pool = config.pools.find((candidate) => candidate.name === entry.pool);
			if (!pool || !pool.enabled) return false;
			return summarizePoolHealth(pool, authStorage, poolManager).availableCount > 0;
		}).length;
	}
	const issueLabel = invalidEntries > 0 ? ` | ${invalidEntries} invalid` : "";
	const usableLabel = config && authStorage && poolManager
		? ` | ${usableEntries}/${chain.entries.length} usable now`
		: "";
	return `${chain.name} | ${chain.entries.length} ${entryLabel} | ${chain.enabled ? "enabled" : "disabled"}${issueLabel}${usableLabel}`;
}

function formatChainToggleOption(chain: ChainConfig): string {
	return `${chain.name} -- currently ${chain.enabled ? "enabled" : "disabled"}`;
}

function formatChainRemoveOption(chain: ChainConfig): string {
	const entryLabel = chain.entries.length === 1 ? "entry" : "entries";
	return `${chain.name} (${chain.entries.length} ${entryLabel})`;
}

function formatChainStatusLines(
	chain: ChainConfig,
	config?: MultiPassConfig,
	authStorage?: { hasAuth(provider: string): boolean },
	poolManager?: Pick<PoolManager, "getAvailableMembers" | "isMemberExhausted">,
): string[] {
	const invalidEntries = config
		? chain.entries.filter((entry) => getChainEntryIssue(entry, config)).length
		: 0;
	const usableEntries = config && authStorage && poolManager
		? chain.entries.filter((entry) => {
			if (!entry.enabled) return false;
			if (getChainEntryIssue(entry, config)) return false;
			const pool = config.pools.find((candidate) => candidate.name === entry.pool);
			if (!pool || !pool.enabled) return false;
			return summarizePoolHealth(pool, authStorage, poolManager).availableCount > 0;
		}).length
		: undefined;
	const lines = [
		`=== ${chain.name} (${chain.enabled ? "enabled" : "disabled"}) ===`,
		`entries: ${chain.entries.length}`,
		`chain state: ${chain.enabled ? "active" : "disabled (all entries skipped)"}`,
	];

	if (usableEntries !== undefined) {
		lines.push(`usable entries now: ${usableEntries}/${chain.entries.length}`);
	}

	if (invalidEntries > 0) {
		lines.push(`invalid entries: ${invalidEntries} (skipped until fixed)`);
	}

	if (chain.entries.length === 0) {
		lines.push("  [no entries configured]");
		return lines;
	}

	for (let i = 0; i < chain.entries.length; i++) {
		const entry = chain.entries[i];
		lines.push(`  ${i + 1}. ${formatChainEntryStatus(entry, config, authStorage, poolManager)}`);
	}

	return lines;
}

async function handlePoolChainCreate(
	ctx: ExtensionCommandContext,
	poolManager: PoolManager,
): Promise<void> {
	const config = loadGlobalConfig();
	const chainName = await ctx.ui.input("Chain name", "e.g. primary-fallback");
	if (!chainName?.trim()) return;
	if (findChainByName(config.chains, chainName.trim())) {
		ctx.ui.notify(`Chain "${chainName.trim()}" already exists.`, "warning");
		return;
	}

	const entries: ChainEntryConfig[] = [];
	let selecting = true;
	while (selecting) {
		const latestConfig = loadGlobalConfig();
		const availablePools = latestConfig.pools;
		const options = [
			`--- Selected (${entries.length}): ${entries.map((entry) => formatChainEntryStatus(entry, latestConfig)).join(", ") || "none"} ---`,
			...availablePools.map((pool) => `${pool.name} -- ${pool.baseProvider} (${pool.enabled ? "enabled" : "disabled"})`),
			"[Create pool inline]",
			"[Done - save chain]",
		];

		const selected = await ctx.ui.select("Add chain entries ([Done] saves, Esc cancels)", options);
		if (!selected) {
			ctx.ui.notify(`Cancelled chain creation for "${chainName.trim()}".`, "info");
			return;
		}
		if (selected.startsWith("---")) {
			continue;
		}

		if (selected === "[Done - save chain]") {
			if (entries.length === 0) {
				ctx.ui.notify(`Chain "${chainName.trim()}" needs at least 1 entry.`, "warning");
				continue;
			}
			selecting = false;
			continue;
		}

		if (selected === "[Create pool inline]") {
			await createAndPersistPool(ctx, poolManager, {
				allowOverwrite: false,
				resumeChainName: chainName.trim(),
			});
			continue;
		}

		const poolName = selected.split(" -- ")[0];
		const pool = availablePools.find((candidate) => candidate.name === poolName);
		if (!pool) {
			ctx.ui.notify(`Pool "${poolName}" is no longer available.`, "warning");
			continue;
		}

		const selectableModels = getSelectableModelsForPool(pool);
		if (selectableModels.length === 0) {
			ctx.ui.notify(
				`Pool "${pool.name}" has no selectable models for ${pool.baseProvider}.`,
				"warning",
			);
			continue;
		}

		const selectedModel = await ctx.ui.select(
			`Default model for ${pool.name}`,
			selectableModels,
		);
		if (!selectedModel) continue;

		const enabled = await ctx.ui.confirm(
			`Enable entry for ${pool.name}?`,
			`${pool.name} -> ${selectedModel}\n\nEnable this chain entry?`,
		);
		entries.push({ pool: pool.name, model: selectedModel, enabled });
	}

	const latestConfig = loadGlobalConfig();
	const built = buildChainConfig(latestConfig, {
		name: chainName.trim(),
		entries,
		enabled: true,
	});
	if (!built.ok) {
		ctx.ui.notify(built.error, "warning");
		return;
	}

	latestConfig.chains.push(built.chain);
	saveGlobalConfig(latestConfig);
	ctx.ui.notify(
		`Created chain "${built.chain.name}" with ${built.chain.entries.length} ${built.chain.entries.length === 1 ? "entry" : "entries"}.`,
		"info",
	);
}

async function handlePoolChainList(
	ctx: ExtensionCommandContext,
	poolManager: PoolManager,
): Promise<void> {
	const config = loadGlobalConfig();
	if (config.chains.length === 0) {
		ctx.ui.notify("No chains configured. Use /pool chain to create one.", "info");
		return;
	}

	await ctx.ui.select(
		"Chains",
		config.chains.map((chain) =>
			formatChainListLine(chain, config, ctx.modelRegistry.authStorage, poolManager),
		),
	);
}

async function handlePoolChainToggle(ctx: ExtensionCommandContext): Promise<void> {
	const config = loadGlobalConfig();
	if (config.chains.length === 0) {
		ctx.ui.notify("No chains configured.", "info");
		return;
	}

	const options = config.chains.map(formatChainToggleOption);
	const selected = await ctx.ui.select("Toggle chain", options);
	if (!selected) return;

	const idx = options.indexOf(selected);
	if (idx < 0) return;

	config.chains[idx].enabled = !config.chains[idx].enabled;
	saveGlobalConfig(config);

	const chain = config.chains[idx];
	ctx.ui.notify(
		`Chain "${chain.name}" is now ${chain.enabled ? "enabled" : "disabled"}`,
		"info",
	);
}

async function handlePoolChainRemove(ctx: ExtensionCommandContext): Promise<void> {
	const config = loadGlobalConfig();
	if (config.chains.length === 0) {
		ctx.ui.notify("No chains configured.", "info");
		return;
	}

	const options = config.chains.map(formatChainRemoveOption);
	const selected = await ctx.ui.select("Remove chain", options);
	if (!selected) return;

	const idx = options.indexOf(selected);
	if (idx < 0) return;

	const chain = config.chains[idx];
	const confirmed = await ctx.ui.confirm(
		"Confirm removal",
		`Remove chain "${chain.name}"?`,
	);
	if (!confirmed) return;

	config.chains.splice(idx, 1);
	saveGlobalConfig(config);
	ctx.ui.notify(`Removed chain "${chain.name}"`, "info");
}

async function handlePoolChainStatus(
	ctx: ExtensionCommandContext,
	poolManager: PoolManager,
): Promise<void> {
	const config = loadGlobalConfig();
	if (config.chains.length === 0) {
		ctx.ui.notify("No chains configured.", "info");
		return;
	}

	const selected = await ctx.ui.select(
		"Chain Status",
		config.chains.map((chain) => `${chain.name} -- inspect chain entries`),
	);
	if (!selected) return;

	const chainName = selected.split(" -- ")[0];
	const chain = findChainByName(config.chains, chainName);
	if (!chain) {
		ctx.ui.notify(`Chain "${chainName}" not found.`, "warning");
		return;
	}

	await ctx.ui.select(
		`Chain Status: ${chain.name}`,
		formatChainStatusLines(chain, config, ctx.modelRegistry.authStorage, poolManager),
	);
}

async function handlePoolChainMenu(
	ctx: ExtensionCommandContext,
	poolManager: PoolManager,
): Promise<void> {
	const actions = [
		"create   -- Create a new fallback chain",
		"list     -- Show all chains",
		"toggle   -- Enable/disable a chain",
		"remove   -- Remove a chain",
		"status   -- Inspect ordered chain entries",
	];

	const selected = await ctx.ui.select("Chain Manager", actions);
	if (!selected) return;

	const action = selected.split(" ")[0].trim();
	switch (action) {
		case "create":
			return handlePoolChainCreate(ctx, poolManager);
		case "list":
			return handlePoolChainList(ctx, poolManager);
		case "toggle":
			return handlePoolChainToggle(ctx);
		case "remove":
			return handlePoolChainRemove(ctx);
		case "status":
			return handlePoolChainStatus(ctx, poolManager);
	}
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
		"chain    -- Manage saved fallback chains",
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
		case "chain":
			return handlePoolChainMenu(ctx, poolManager);
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

		const enabledChains = effective.chains.filter((chain) => chain.enabled);
		const activeChain = enabledChains[0];
		if (activeChain) {
			const firstEnabledEntry = activeChain.entries.find((entry) => entry.enabled);
			if (firstEnabledEntry) {
				ctx.ui.setStatus(
					"multi-pass",
					`chain:${activeChain.name} | starts ${firstEnabledEntry.pool} -> ${firstEnabledEntry.model}`,
				);
				return;
			}
		}

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
	pi.on("before_agent_start", async (event, ctx) => {
		lastUserPrompt = event.prompt;
		poolManager.startTurn(event.prompt, ctx.model);
	});

	// Listen for errors to trigger pool rotation
	pi.on("agent_end", async (event: AgentEndEvent, ctx: ExtensionContext) => {
		if (!event.messages || event.messages.length === 0) return;

		const lastMsg = event.messages[event.messages.length - 1];
		if (!lastMsg || lastMsg.role !== "assistant") return;

		const assistantMsg = lastMsg as any;
		if (assistantMsg.stopReason !== "error") return;
		if (!assistantMsg.errorMessage) return;

		const effective = loadEffectiveConfig(ctx.cwd);
		const rotated = await poolManager.handleError(
			assistantMsg.errorMessage,
			ctx.model,
			ctx,
			lastUserPrompt,
			normalizeMultiPassConfig({
				subscriptions: effective.subscriptions,
				pools: effective.pools,
				chains: effective.chains,
			}),
		);

		if (!rotated && isRateLimitError(assistantMsg.errorMessage)) {
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
			const subcommands = ["create", "list", "chain", "toggle", "remove", "status", "project"];
			const filtered = subcommands.filter((s) => s.startsWith(prefix));
			return filtered.length > 0
				? filtered.map((s) => ({ value: s, label: s }))
				: null;
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const parts = args
				.trim()
				.toLowerCase()
				.split(/\s+/)
				.filter(Boolean);
			const subcommand = parts[0] || "";
			const chainSubcommand = parts[1] || "";
			switch (subcommand) {
				case "create":
				case "new":
					return handlePoolCreate(ctx, poolManager);
				case "list":
				case "ls":
					return handlePoolList(ctx, poolManager);
				case "chain":
					switch (chainSubcommand) {
						case "":
							return handlePoolChainMenu(ctx, poolManager);
						case "list":
						case "ls":
							return handlePoolChainList(ctx);
						case "toggle":
							return handlePoolChainToggle(ctx);
						case "remove":
						case "rm":
						case "delete":
							return handlePoolChainRemove(ctx);
						case "status":
						case "info":
							return handlePoolChainStatus(ctx);
						case "create":
						case "new":
							return handlePoolChainCreate(ctx, poolManager);
						default:
							return handlePoolChainMenu(ctx, poolManager);
					}
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
