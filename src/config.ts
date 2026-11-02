/**
 * Extension configuration: defaults, file loading, and merging.
 *
 * Two files are read, in order of precedence:
 *   1. `<agent dir>/memory.json`        (global)
 *   2. `<cwd>/.pi/memory.json`          (project, only when the project is trusted)
 *
 * Every key is optional; anything missing falls back to `DEFAULT_CONFIG`.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

export type MemoryType = "user" | "feedback" | "project" | "reference";

export const MEMORY_TYPES: readonly MemoryType[] = ["user", "feedback", "project", "reference"];

export interface MemoryConfig {
	store: {
		/** Where cross-project memories live. `~` is expanded. */
		global: string;
		/** Also read/write `<project root>/.agents/memory`. */
		project: boolean;
		/** Project memory directory, relative to the project root. */
		projectPath: string;
		/** Skip provenance suffixes in the injected catalog. */
	};
	prompt: {
		/** Inject the MEMORY.md catalog into the system prompt. */
		index: boolean;
		maxIndexItems: number;
		maxIndexBytes: number;
	};
	recall: {
		/** Inject memories relevant to the current request into the turn. */
		enabled: boolean;
		maxItems: number;
		maxFileBytes: number;
		maxTotalBytes: number;
		/** Skip recall for prompts shorter than this (e.g. "ok", "继续"). */
		minPromptChars: number;
		/** Use a model side-query to pick memories; falls back to keyword scoring. */
		useModel: boolean;
		timeoutMs: number;
	};
	extract: {
		/** Extract new memories after each settled run. */
		enabled: boolean;
		/** Cheap model used for extraction, `provider/model-id`. */
		model: string;
		maxMessages: number;
		maxDialogueChars: number;
		/** Minimum spacing between two extractions in one process. */
		minIntervalMs: number;
		maxNewPerRun: number;
		/** Skip extraction in sessions started with a parent session (subagents). */
		skipChildSessions: boolean;
	};
	consolidate: {
		/** Merge duplicates automatically once `threshold` memories exist. */
		enabled: boolean;
		threshold: number;
		minIntervalMs: number;
		/** Model used for consolidation. Empty = `extract.model`. */
		model: string;
	};
}

export interface LoadedConfig {
	config: MemoryConfig;
	/** Files that were read, in merge order. */
	files: string[];
	warnings: string[];
}

export const DEFAULT_CONFIG: MemoryConfig = {
	store: {
		global: join(homedir(), ".agents", "memory"),
		project: true,
		projectPath: join(".agents", "memory"),
	},
	prompt: {
		index: true,
		maxIndexItems: 200,
		maxIndexBytes: 25_000,
	},
	recall: {
		enabled: true,
		maxItems: 5,
		maxFileBytes: 4_096,
		maxTotalBytes: 12_000,
		minPromptChars: 12,
		useModel: true,
		timeoutMs: 8_000,
	},
	extract: {
		enabled: true,
		model: "opencode-go/deepseek-v4.1-flash",
		maxMessages: 12,
		maxDialogueChars: 6_000,
		minIntervalMs: 60_000,
		maxNewPerRun: 3,
		skipChildSessions: true,
	},
	consolidate: {
		enabled: false,
		threshold: 30,
		minIntervalMs: 86_400_000,
		model: "",
	},
};

export function expandHome(path: string, home = homedir()): string {
	if (path === "~") return home;
	if (path.startsWith("~/") || path.startsWith("~\\")) return join(home, path.slice(2));
	return path;
}

/** A JSON object read from a config file; validated field by field when merged. */
export type ConfigPatch = Record<string, unknown>;

function asRecord(value: unknown): ConfigPatch {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as ConfigPatch) : {};
}

function num(value: unknown, fallback: number, min = 0): number {
	return typeof value === "number" && Number.isFinite(value) && value >= min ? value : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function str(value: unknown, fallback: string): string {
	return typeof value === "string" ? value : fallback;
}

/** Merge a user-provided partial config over a base config, section by section. */
export function mergeConfig(base: MemoryConfig, patch: ConfigPatch | undefined): MemoryConfig {
	const p = asRecord(patch);
	const store = asRecord(p.store);
	const prompt = asRecord(p.prompt);
	const recall = asRecord(p.recall);
	const extract = asRecord(p.extract);
	const consolidate = asRecord(p.consolidate);

	return {
		store: {
			global: str(store.global, base.store.global),
			project: bool(store.project, base.store.project),
			projectPath: str(store.projectPath, base.store.projectPath),
		},
		prompt: {
			index: bool(prompt.index, base.prompt.index),
			maxIndexItems: num(prompt.maxIndexItems, base.prompt.maxIndexItems, 1),
			maxIndexBytes: num(prompt.maxIndexBytes, base.prompt.maxIndexBytes, 200),
		},
		recall: {
			enabled: bool(recall.enabled, base.recall.enabled),
			maxItems: num(recall.maxItems, base.recall.maxItems, 1),
			maxFileBytes: num(recall.maxFileBytes, base.recall.maxFileBytes, 200),
			maxTotalBytes: num(recall.maxTotalBytes, base.recall.maxTotalBytes, 200),
			minPromptChars: num(recall.minPromptChars, base.recall.minPromptChars),
			useModel: bool(recall.useModel, base.recall.useModel),
			timeoutMs: num(recall.timeoutMs, base.recall.timeoutMs, 500),
		},
		extract: {
			enabled: bool(extract.enabled, base.extract.enabled),
			model: str(extract.model, base.extract.model),
			maxMessages: num(extract.maxMessages, base.extract.maxMessages, 1),
			maxDialogueChars: num(extract.maxDialogueChars, base.extract.maxDialogueChars, 500),
			minIntervalMs: num(extract.minIntervalMs, base.extract.minIntervalMs),
			maxNewPerRun: num(extract.maxNewPerRun, base.extract.maxNewPerRun, 1),
			skipChildSessions: bool(extract.skipChildSessions, base.extract.skipChildSessions),
		},
		consolidate: {
			enabled: bool(consolidate.enabled, base.consolidate.enabled),
			threshold: num(consolidate.threshold, base.consolidate.threshold, 2),
			minIntervalMs: num(consolidate.minIntervalMs, base.consolidate.minIntervalMs),
			model: str(consolidate.model, base.consolidate.model),
		},
	};
}

export function globalConfigPath(agentDir = getAgentDir()): string {
	return join(agentDir, "memory.json");
}

export function projectConfigPath(cwd: string): string {
	return join(cwd, CONFIG_DIR_NAME, "memory.json");
}

export interface LoadConfigOptions {
	cwd: string;
	trusted: boolean;
	agentDir?: string;
	/** Test seam: overrides the global config path. */
	globalPath?: string;
}

export function loadConfig(options: LoadConfigOptions): LoadedConfig {
	const files: string[] = [];
	const warnings: string[] = [];
	let config = DEFAULT_CONFIG;

	const candidates: Array<{ path: string; follow: (c: MemoryConfig) => MemoryConfig }> = [
		{
			path: options.globalPath ?? globalConfigPath(options.agentDir),
			follow: (c) => mergeConfig(c, readJson(globalConfigPath(options.agentDir))),
		},
	];

	for (const candidate of candidates) {
		if (!existsSync(candidate.path)) continue;
		const patch = readJson(candidate.path, warnings);
		if (patch === undefined) continue;
		config = mergeConfig(config, patch);
		files.push(candidate.path);
	}

	if (options.trusted) {
		const path = projectConfigPath(options.cwd);
		if (existsSync(path)) {
			const patch = readJson(path, warnings);
			if (patch !== undefined) {
				config = mergeConfig(config, patch);
				files.push(path);
			}
		}
	}

	return {
		config: {
			...config,
			store: { ...config.store, global: resolve(expandHome(config.store.global)) },
		},
		files,
		warnings,
	};
}

function readJson(path: string, warnings?: string[]): ConfigPatch | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as ConfigPatch) : {};
	} catch (error) {
		warnings?.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
		return undefined;
	}
}

export function resolvePath(base: string, path: string): string {
	return isAbsolute(path) ? path : resolve(base, path);
}
