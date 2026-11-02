/**
 * Session-scoped memory runtime: config, scopes, the scanned catalog, writes, extraction
 * and consolidation. Everything the extension handlers need lives here so the wiring in
 * `index.ts` stays thin.
 */

import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MemoryConfig, MemoryType } from "./config.ts";
import { DEFAULT_CONFIG, loadConfig } from "./config.ts";
import { debug } from "./debug.ts";
import { buildExtractionPrompt, dialogueExcerpt, existingCatalog, normalizeFact, parseCandidates } from "./extract.ts";
import { complete, parseJsonReply } from "./llm.ts";
import type { MemoryDraft, MemoryEntry, MemoryScope, ScopeName } from "./memory.ts";
import {
	deleteMemoryFile,
	ensureScopeDir,
	indexFile,
	pruneIndex,
	readIndex,
	scanScope,
	scopeSignature,
	slugify,
	writeMemoryFile,
} from "./memory.ts";
import type { CatalogScope } from "./prompt.ts";
import { selectRelevant } from "./select.ts";

export interface SaveOptions {
	scope?: ScopeName;
	overwrite?: boolean;
}

export interface SaveOutcome {
	ok: boolean;
	reason?: string;
	filename?: string;
	path?: string;
	scope?: ScopeName;
}

export interface ExtractOutcome {
	written: string[];
	reason?: string;
}

export interface ConsolidatePlanItem extends MemoryDraft {
	scope: ScopeName;
	replaces: string[];
}

export interface ConsolidatePlan {
	items: ConsolidatePlanItem[];
	reason?: string;
}

/** Walk up from `cwd` looking for a repository root. */
export function findProjectRoot(cwd: string): string | undefined {
	let dir = cwd;
	for (;;) {
		if (existsSync(join(dir, ".git"))) return dir;
		const parent = join(dir, "..");
		if (parent === dir) return undefined;
		dir = parent;
	}
}

function displayPath(dir: string, cwd: string): string {
	const home = homedir();
	if (dir === home) return "~";
	if (dir.startsWith(`${home}/`)) return `~/${relative(home, dir)}`;
	return relative(cwd, dir).startsWith("..") ? dir : relative(cwd, dir) || ".";
}

export class MemoryRuntime {
	config: MemoryConfig = DEFAULT_CONFIG;
	warnings: string[] = [];
	configFiles: string[] = [];

	private cwd = process.cwd();
	private projectRoot?: string;
	private globalScope?: MemoryScope;
	private projectScope?: MemoryScope;

	entries: MemoryEntry[] = [];
	private catalogs = new Map<ScopeName, string>();
	private signature = "";
	private extractingSince = 0;
	lastExtractAt = 0;
	lastConsolidateAt = 0;

	init(ctx: ExtensionContext): void {
		this.cwd = ctx.cwd;
		const loaded = loadConfig({ cwd: ctx.cwd, trusted: ctx.isProjectTrusted() });
		this.config = loaded.config;
		this.warnings = loaded.warnings;
		this.configFiles = loaded.files;

		this.globalScope = { name: "global", dir: this.config.store.global };
		this.projectRoot = findProjectRoot(ctx.cwd);
		const projectDir = this.projectRoot ? join(this.projectRoot, this.config.store.projectPath) : undefined;
		this.projectScope =
			this.config.store.project && projectDir && projectDir !== this.globalScope.dir
				? { name: "project", dir: projectDir }
				: undefined;

		this.refresh(true);
	}

	/** Scopes that exist on disk, plus the project scope when `includeMissing`. */
	scopes(includeMissing = false): MemoryScope[] {
		const list: MemoryScope[] = [];
		if (this.globalScope) list.push(this.globalScope);
		if (this.projectScope && (includeMissing || existsSync(this.projectScope.dir))) list.push(this.projectScope);
		return list;
	}

	/** Rescan the store when anything changed. Returns whether the catalog changed. */
	refresh(force = false): boolean {
		const signature = this.scopes(true)
			.map((scope) => scopeSignature(scope))
			.join("|");
		if (!force && signature === this.signature) return false;
		this.signature = signature;

		this.entries = [];
		this.catalogs.clear();
		for (const scope of this.scopes()) {
			const scanned = scanScope(scope);
			const present = new Set(scanned.map((entry) => entry.filename));
			this.catalogs.set(scope.name, pruneIndex(readIndex(scope), present));
			this.entries.push(...scanned);
		}
		this.entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
		return true;
	}

	catalogScopes(): CatalogScope[] {
		const result: CatalogScope[] = [];
		for (const scope of this.scopes()) {
			const index = this.catalogs.get(scope.name) ?? "";
			result.push({
				scope,
				label: scope.name,
				displayPath: displayPath(scope.dir, this.cwd),
				entries: this.entries.filter((entry) => entry.scope === scope.name),
				indexLines: index.split("\n").filter((line) => line.trim().length > 0),
			});
		}
		return result;
	}

	findByFilename(filename: string): MemoryEntry | undefined {
		return this.entries.find((entry) => entry.filename === filename);
	}

	private scopeFor(name: ScopeName): MemoryScope | undefined {
		return name === "global" ? this.globalScope : this.projectScope;
	}

	/** Default scope for a memory type: project facts stay in the project store. */
	private defaultScope(type: MemoryType): ScopeName {
		return type === "project" && this.projectScope ? "project" : "global";
	}

	/** A memory with the same fact, under any name. */
	private duplicateOf(draft: MemoryDraft): MemoryEntry | undefined {
		const fact = normalizeFact(draft.description);
		const slug = slugify(draft.name);
		return this.entries.find(
			(entry) =>
				entry.filename === `${slug}.md` ||
				(fact.length > 0 && normalizeFact(entry.description) === fact) ||
				(fact.length > 0 && normalizeFact(entry.name) === normalizeFact(draft.name)),
		);
	}

	save(draft: MemoryDraft, options: SaveOptions = {}): SaveOutcome {
		const scopeName = options.scope ?? this.defaultScope(draft.type);
		const scope = this.scopeFor(scopeName);
		if (!scope)
			return { ok: false, reason: "project memory is disabled (no repository root, or store.project is false)" };

		const filename = `${slugify(draft.name)}.md`;
		if (existsSync(join(scope.dir, filename)) && !options.overwrite) {
			return { ok: false, reason: `memory already exists: ${filename}`, filename, scope: scopeName };
		}

		if (!options.overwrite) {
			const duplicate = this.duplicateOf(draft);
			if (duplicate) {
				return {
					ok: false,
					reason: `already stored as ${duplicate.filename}: ${duplicate.description}`,
					filename: duplicate.filename,
					scope: duplicate.scope,
				};
			}
		}

		const path = writeMemoryFile(scope, filename, draft);
		this.refresh(true);
		return { ok: true, filename, path, scope: scopeName };
	}

	remove(filename: string): boolean {
		for (const scope of this.scopes()) {
			if (this.entries.some((entry) => entry.scope === scope.name && entry.filename === filename)) {
				const removed = deleteMemoryFile(scope, filename);
				if (removed) this.refresh(true);
				return removed;
			}
		}
		return false;
	}

	/** Which memories to recall for this request, using the model then keywords. */
	async recall(ctx: ExtensionContext, prompt: string): Promise<MemoryEntry[]> {
		const config = this.config.recall;
		return selectRelevant(ctx, this.entries, {
			prompt,
			maxItems: config.maxItems,
			timeoutMs: config.timeoutMs,
			model: this.config.extract.model,
			useModel: config.useModel,
		});
	}

	private recentMessages(ctx: ExtensionContext, limit: number): AgentMessage[] {
		const messages: AgentMessage[] = [];
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "message") messages.push(entry.message);
		}
		return messages.slice(-limit);
	}

	/** Extract new memories from the run that just settled. Never throws. */
	async extract(ctx: ExtensionContext): Promise<ExtractOutcome> {
		const config = this.config.extract;
		if (!config.enabled) return { written: [], reason: "disabled" };
		if (this.extractingSince > 0) return { written: [], reason: "already running" };
		if (Date.now() - this.lastExtractAt < config.minIntervalMs) return { written: [], reason: "throttled" };
		if (config.skipChildSessions && ctx.sessionManager.getHeader()?.parentSession) {
			return { written: [], reason: "child session" };
		}

		const dialogue = dialogueExcerpt(this.recentMessages(ctx, 40), {
			maxMessages: config.maxMessages,
			maxChars: config.maxDialogueChars,
		});
		if (!dialogue) {
			debug("extract: no dialogue");
			return { written: [], reason: "no dialogue" };
		}

		this.extractingSince = Date.now();
		try {
			const prompt = buildExtractionPrompt({
				existing: existingCatalog(this.entries),
				dialogue,
				maxItems: config.maxNewPerRun,
			});
			const outcome = await complete(ctx, config.model, {
				system: prompt.system,
				user: prompt.user,
				maxTokens: 900,
				timeoutMs: 30_000,
			});
			if (!outcome.text) {
				debug(`extract: model call returned nothing (${outcome.error})`);
				return { written: [], reason: outcome.error };
			}
			debug(`extract: model reply ${outcome.text.slice(0, 200)}`);

			const written: string[] = [];
			for (const candidate of parseCandidates(outcome.text)) {
				if (written.length >= config.maxNewPerRun) break;
				const draft: MemoryDraft = {
					name: candidate.name,
					description: candidate.description,
					type: candidate.type,
					body: candidate.body,
				};
				if (this.duplicateOf(draft)) {
					debug(`extract: skipped duplicate ${candidate.name}`);
					continue;
				}
				const result = this.save(draft, { scope: candidate.scope, overwrite: false });
				debug(`extract: save ${candidate.name} -> ${result.ok ? result.path : result.reason}`);
				if (result.ok && result.filename) written.push(result.filename);
			}
			return { written };
		} finally {
			this.extractingSince = 0;
			this.lastExtractAt = Date.now();
		}
	}

	/** Ask the model which memories say the same thing. The caller applies the plan. */
	async planConsolidation(ctx: ExtensionContext): Promise<ConsolidatePlan> {
		if (this.entries.length < this.config.consolidate.threshold) {
			return { items: [], reason: `fewer than ${this.config.consolidate.threshold} memories` };
		}

		const catalog = this.entries
			.map(
				(entry) =>
					`- ${entry.filename} (${entry.scope}, ${entry.type}) ${entry.name}: ${entry.description}\n  ${entry.body.slice(0, 400)}`,
			)
			.join("\n");

		const user = [
			"Stored memories:",
			catalog,
			"",
			"Merge only memories that state the same fact, or where a newer one makes an older one obsolete. Never merge unrelated memories.",
			"Reply with JSON and nothing else:",
			`{"memories": [{"name": "...", "type": "user|feedback|project|reference", "description": "...", "body": "...", "scope": "global|project", "replaces": ["file.md"]}]}`,
			'Every object must list in `replaces` the files it absorbs. Return {"memories": []} when nothing should change.',
		].join("\n");

		const outcome = await complete(ctx, this.config.consolidate.model || this.config.extract.model, {
			system: "You deduplicate a long-term memory store. Reply with JSON only.",
			user,
			maxTokens: 2_000,
			timeoutMs: 45_000,
		});
		if (!outcome.text) return { items: [], reason: outcome.error };

		const parsed = parseJsonReply(outcome.text);
		const memories = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed.memories : undefined;
		if (!Array.isArray(memories)) return { items: [], reason: "unparseable reply" };

		const known = new Map(this.entries.map((entry) => [entry.filename, entry]));
		const items: ConsolidatePlanItem[] = [];
		for (const item of memories) {
			if (!item || typeof item !== "object" || Array.isArray(item)) continue;
			const record = item as Record<string, unknown>;
			const replaces = Array.isArray(record.replaces)
				? record.replaces.filter((name): name is string => typeof name === "string" && known.has(name))
				: [];
			if (replaces.length < 2) continue;
			const name = typeof record.name === "string" ? record.name.trim() : "";
			const description = typeof record.description === "string" ? record.description.trim() : "";
			if (!name || !description) continue;
			const rawType = typeof record.type === "string" ? record.type : "reference";
			const type =
				(["user", "feedback", "project", "reference"] as const).find((value) => value === rawType) ?? "reference";
			items.push({
				name,
				description,
				type,
				body: typeof record.body === "string" ? record.body : description,
				scope: record.scope === "project" ? "project" : "global",
				replaces,
			});
		}
		return { items };
	}

	/** Apply a consolidation plan: back up the absorbed files, then replace them. */
	applyConsolidation(plan: ConsolidatePlan): { written: string[]; removed: string[] } {
		const written: string[] = [];
		const removed: string[] = [];
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");

		for (const item of plan.items) {
			const scope = this.scopeFor(item.scope) ?? this.globalScope;
			if (!scope) continue;
			const absorbed = item.replaces
				.map((filename) => ({ filename, entry: this.findByFilename(filename) }))
				.filter((candidate): candidate is { filename: string; entry: MemoryEntry } => Boolean(candidate.entry));

			const backup = join(scope.dir, ".backup", stamp);
			mkdirSync(backup, { recursive: true });
			for (const target of absorbed) {
				const source = join(scope.dir, target.filename);
				if (existsSync(source)) cpSync(source, join(backup, target.filename));
			}

			const draft: MemoryDraft = {
				name: item.name,
				description: item.description,
				type: item.type,
				body: item.body,
			};
			this.save(draft, { scope: item.scope, overwrite: true });
			written.push(`${slugify(item.name)}.md`);
			for (const target of absorbed) {
				if (deleteMemoryFile(scope, target.filename)) removed.push(target.filename);
			}
		}

		this.lastConsolidateAt = Date.now();
		this.refresh(true);
		return { written, removed };
	}

	total(): number {
		return this.entries.length;
	}

	statusText(): string {
		if (this.total() === 0) return "memory: empty";
		const projectCount = this.entries.filter((entry) => entry.scope === "project").length;
		const globalCount = this.total() - projectCount;
		const parts = [`${globalCount} global`];
		if (this.projectScope) parts.push(`${projectCount} project`);
		return `memory ${this.total()} (${parts.join(", ")})`;
	}

	/** Directories that hold memories, for `/memory status`. */
	directories(): Array<{ scope: ScopeName; dir: string; count: number; index: string }> {
		return this.scopes().map((scope) => ({
			scope: scope.name,
			dir: scope.dir,
			count: this.entries.filter((entry) => entry.scope === scope.name).length,
			index: indexFile(scope),
		}));
	}

	ensureProjectDir(): void {
		if (this.projectScope) ensureScopeDir(this.projectScope);
	}

	/** Files in the project scope, used for tests and diagnostics. */
	projectFiles(): string[] {
		if (!this.projectScope || !existsSync(this.projectScope.dir)) return [];
		try {
			return readdirSync(this.projectScope.dir);
		} catch {
			return [];
		}
	}
}
