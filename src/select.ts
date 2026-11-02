/**
 * Picking which memories are relevant to the current request.
 *
 * Primary path is a cheap model side-query over names and descriptions, the way Claude Code
 * does it: it reads intent, which embeddings and keyword overlap both miss. When the model
 * is unavailable, times out, or answers garbage, keyword scoring takes over. Recall must
 * never fail the request.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { complete, parseJsonReply } from "./llm.ts";
import type { MemoryEntry } from "./memory.ts";
import { truncateBytes } from "./memory.ts";

export interface SelectOptions {
	prompt: string;
	maxItems: number;
	timeoutMs: number;
	model: string;
	useModel: boolean;
}

const SELECT_SYSTEM = [
	"You choose which saved memories help answer a request from a coding agent.",
	"Reply with a JSON array of indices and nothing else, for example [0,3].",
	"Be strict: include a memory only when knowing it would change the answer or the way the task is done.",
	"Return [] when nothing clearly applies. Fewer is better than more.",
].join(" ");

export async function selectRelevant(
	ctx: ExtensionContext,
	entries: MemoryEntry[],
	options: SelectOptions,
): Promise<MemoryEntry[]> {
	if (entries.length === 0) return [];
	if (entries.length <= 3) return keywordSelect(entries, options.prompt, options.maxItems);
	if (!options.useModel) return keywordSelect(entries, options.prompt, options.maxItems);

	const chosen = await modelSelect(ctx, entries, options);
	if (chosen.length > 0) return chosen;
	return keywordSelect(entries, options.prompt, options.maxItems);
}

async function modelSelect(
	ctx: ExtensionContext,
	entries: MemoryEntry[],
	options: SelectOptions,
): Promise<MemoryEntry[]> {
	const catalog = entries.map((entry, index) => `${index}: ${entry.name} — ${entry.description}`).join("\n");
	const user = [
		`Request:\n${truncateBytes(options.prompt, 2_000)}`,
		`\nMemories:\n${truncateBytes(catalog, 4_000)}`,
		`\nReturn at most ${options.maxItems} indices.`,
	].join("\n");

	const outcome = await complete(ctx, options.model, {
		system: SELECT_SYSTEM,
		user,
		maxTokens: 200,
		timeoutMs: options.timeoutMs,
	});
	if (!outcome.text) return [];

	const parsed = parseJsonReply(outcome.text);
	if (!Array.isArray(parsed)) return [];

	const picked: MemoryEntry[] = [];
	const seen = new Set<number>();
	for (const value of parsed) {
		if (typeof value !== "number" || !Number.isInteger(value)) continue;
		if (value < 0 || value >= entries.length || seen.has(value)) continue;
		seen.add(value);
		picked.push(entries[value]);
		if (picked.length >= options.maxItems) break;
	}
	return picked;
}

const STOPWORDS = new Set([
	"the",
	"and",
	"for",
	"with",
	"that",
	"this",
	"from",
	"you",
	"your",
	"are",
	"was",
	"were",
	"have",
	"has",
	"not",
	"but",
	"can",
	"could",
	"should",
	"would",
	"please",
	"use",
	"using",
	"make",
	"just",
	"then",
	"than",
	"into",
	"about",
	"what",
	"when",
	"where",
	"which",
	"there",
	"here",
]);

/** Latin words plus CJK bigrams, which is enough signal for a fallback. */
export function keywords(text: string): string[] {
	const lower = text.toLowerCase();
	const tokens = new Set<string>();

	for (const word of lower.match(/[a-z0-9][a-z0-9_.-]{2,}/g) ?? []) {
		if (!STOPWORDS.has(word)) tokens.add(word);
	}

	for (const run of lower.match(/[\u3400-\u9fff]+/g) ?? []) {
		if (run.length === 1) {
			tokens.add(run);
			continue;
		}
		for (let i = 0; i < run.length - 1; i++) tokens.add(run.slice(i, i + 2));
	}

	return [...tokens];
}

export function scoreEntry(entry: MemoryEntry, tokens: readonly string[]): number {
	const name = entry.name.toLowerCase();
	const description = entry.description.toLowerCase();
	const body = entry.body.toLowerCase();
	let score = 0;
	for (const token of tokens) {
		if (name.includes(token)) score += 4;
		if (description.includes(token)) score += 2;
		if (body.includes(token)) score += 1;
	}
	return score;
}

export function keywordSelect(entries: MemoryEntry[], prompt: string, maxItems: number, minScore = 2): MemoryEntry[] {
	const tokens = keywords(prompt);
	if (tokens.length === 0) return [];
	return entries
		.map((entry) => ({ entry, score: scoreEntry(entry, tokens) }))
		.filter((candidate) => candidate.score >= minScore)
		.sort((a, b) => b.score - a.score)
		.slice(0, maxItems)
		.map((candidate) => candidate.entry);
}
