/**
 * Picking which memories are relevant to the current request.
 *
 * Primary path is a cheap model side-query over names and descriptions, the way Claude Code
 * does it: it reads intent, which embeddings and keyword overlap both miss. When the model
 * is unavailable, times out, or answers garbage, keyword scoring takes over. An explicit
 * "nothing applies" is an answer, not a failure, so an empty reply is kept as it is: falling
 * back there would re-inject exactly the memories the model just rejected. Recall must never
 * fail the request.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { debug } from "./debug.ts";
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

/**
 * A model answer. `picked` is undefined when the reply was unusable; an empty array means the
 * model understood the request and said nothing applies. The two need different handling, so
 * they cannot share the "no results" shape of a bare array.
 */
interface ModelSelection {
	picked?: MemoryEntry[];
	/** Short account of why there is no answer, for the debug log. */
	reason?: string;
}

/**
 * Budget for the catalog shown to the selecting model. It has to cover the whole store:
 * a catalog cut short silently hides the memories that fall past the cut, and the model
 * then picks from a subset without knowing it.
 */
const SELECT_CATALOG_MAX_BYTES = 12_000;

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

	const outcome = await modelSelect(ctx, entries, options);
	if (outcome.picked) {
		// An empty array reaches this branch on purpose: the model looked at the catalog and
		// found nothing worth injecting, which is a better answer than keyword overlap gives.
		debug(
			outcome.picked.length > 0
				? `select: model picked ${outcome.picked.map((entry) => entry.name).join(", ")}`
				: "select: model returned nothing relevant",
		);
		return outcome.picked;
	}
	debug(`select: model unavailable (${outcome.reason ?? "unknown"}), keyword fallback`);
	return keywordSelect(entries, options.prompt, options.maxItems);
}

async function modelSelect(
	ctx: ExtensionContext,
	entries: MemoryEntry[],
	options: SelectOptions,
): Promise<ModelSelection> {
	const catalog = entries.map((entry, index) => `${index}: ${entry.name} — ${entry.description}`).join("\n");
	const user = [
		`Request:\n${truncateBytes(options.prompt, 2_000)}`,
		`\nMemories:\n${truncateBytes(catalog, SELECT_CATALOG_MAX_BYTES)}`,
		`\nReturn at most ${options.maxItems} indices.`,
	].join("\n");

	const outcome = await complete(ctx, options.model, {
		system: SELECT_SYSTEM,
		user,
		maxTokens: 200,
		timeoutMs: options.timeoutMs,
	});
	if (!outcome.text) return { reason: outcome.error ?? "empty response" };

	const parsed = parseJsonReply(outcome.text);
	if (parsed === undefined) return { reason: "unparsable reply" };
	if (!Array.isArray(parsed)) return { reason: "reply was not an array" };

	const picked: MemoryEntry[] = [];
	const seen = new Set<number>();
	for (const value of parsed) {
		if (typeof value !== "number" || !Number.isInteger(value)) continue;
		if (value < 0 || value >= entries.length || seen.has(value)) continue;
		seen.add(value);
		picked.push(entries[value]);
		if (picked.length >= options.maxItems) break;
	}
	// An empty reply stays empty; a reply full of indices that do not exist is junk, and junk
	// must not silence the keyword fallback.
	if (picked.length === 0 && parsed.length > 0) return { reason: "no valid indices" };
	return { picked };
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

/**
 * Where a path or URL token ends: whitespace, a quote, or CJK punctuation. Without this bound a
 * single Windows path would swallow the rest of the line, and every word it ate would become a
 * keyword that happens to appear somewhere in some memory body.
 */
const TOKEN_END = "\\s\"'`（）【】「」『』，。、；：、“”‘’\\[\\]";

/** Code, URLs, and absolute or multi-segment paths carry no relevance signal. */
const NOISE_PATTERNS: readonly RegExp[] = [
	/```[\s\S]*?```/g,
	/`[^`]*`/g,
	new RegExp(`\\b(?:https?|file):\\/\\/[^${TOKEN_END}]+`, "gi"),
	new RegExp(`[A-Za-z]:\\\\[^${TOKEN_END}]+`, "g"),
	new RegExp(`\\\\\\\\[^${TOKEN_END}]+`, "g"),
	new RegExp(`(?:~|\\.)?(?:\\/[^${TOKEN_END}\\/]+){2,}`, "g"),
];

/** Blank out the noise before tokenizing. Replaced by a space so the neighbours stay separate. */
function stripNoise(text: string): string {
	let cleaned = text;
	for (const pattern of NOISE_PATTERNS) cleaned = cleaned.replace(pattern, " ");
	return cleaned;
}

/** Latin words plus CJK bigrams, which is enough signal for a fallback. */
export function keywords(text: string): string[] {
	const lower = stripNoise(text).toLowerCase();
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

/**
 * Score an entry, keeping the two kinds of hit apart. A hit in the name or description says
 * what the memory is about; a hit in the body only says the word appears somewhere in the
 * details, which any long body satisfies by accident. Only the former can make a candidate.
 */
function scoreEntryParts(entry: MemoryEntry, tokens: readonly string[]): { total: number; strong: number } {
	const name = entry.name.toLowerCase();
	const description = entry.description.toLowerCase();
	const body = entry.body.toLowerCase();
	let total = 0;
	let strong = 0;
	for (const token of tokens) {
		if (name.includes(token)) {
			total += 4;
			strong += 4;
		}
		if (description.includes(token)) {
			total += 2;
			strong += 2;
		}
		if (body.includes(token)) total += 1;
	}
	return { total, strong };
}

/** Plain relevance score. `/memory search` ranks on it and applies its own threshold. */
export function scoreEntry(entry: MemoryEntry, tokens: readonly string[]): number {
	return scoreEntryParts(entry, tokens).total;
}

/**
 * Same hits as `scoreEntryParts`, but each one weighed by how rare its token is. Counting hits
 * alone scores a word that appears in half the store the same as one that appears twice, so
 * one shared word can pull a whole family of memories level with the memory that was meant.
 */
function scoreEntryWeighted(entry: MemoryEntry, tokens: readonly string[], rarity: (token: string) => number): number {
	const name = entry.name.toLowerCase();
	const description = entry.description.toLowerCase();
	const body = entry.body.toLowerCase();
	let score = 0;
	for (const token of tokens) {
		const weight = rarity(token);
		if (weight === 0) continue;
		if (name.includes(token)) score += 4 * weight;
		if (description.includes(token)) score += 2 * weight;
		if (body.includes(token)) score += weight;
	}
	return score;
}

/**
 * `ln(1 + N/df)` for each token, with df counted over names and descriptions: the surfaces a
 * candidate is gated on. A token no entry mentions weighs nothing, which also drops the CJK
 * bigrams a long prompt produces by the dozen.
 */
function tokenRarity(entries: readonly MemoryEntry[], tokens: readonly string[]): (token: string) => number {
	const surfaces = entries.map((entry) => `${entry.name} ${entry.description}`.toLowerCase());
	const weights = new Map<string, number>();
	for (const token of tokens) {
		const df = surfaces.filter((surface) => surface.includes(token)).length;
		weights.set(token, df === 0 ? 0 : Math.log(1 + surfaces.length / df));
	}
	return (token) => weights.get(token) ?? 0;
}

/** The least signal a candidate needs (in unweighted hits) to be worth prompt bytes. */
export const KEYWORD_MIN_SCORE = 2;

/**
 * Keep only entries within this fraction of the best weighted score. Keyword scores are sums
 * of hits, so a fixed threshold that suits one prompt is far too loose for another: what
 * separates a real match from an accidental one is the gap to the best candidate.
 */
export const RELATIVE_FLOOR = 0.5;

/**
 * How far ahead of the runner-up the best candidate has to be before the fallback is trusted
 * at all. Measured on a 160-entry store: a query with real evidence leaves the runner-up at
 * half the best score or less, while the queries that injected junk ended within 10% of each
 * other, matching a whole family of memories through one shared word. A tie is the signature
 * of that failure, and answering it with "take the first five" is how unrelated memories got
 * in. A keyword fallback that stays silent is cheap; one that guesses is not.
 */
export const KEYWORD_CONFIDENCE = 1.3;

export function keywordSelect(
	entries: MemoryEntry[],
	prompt: string,
	maxItems: number,
	minScore = KEYWORD_MIN_SCORE,
): MemoryEntry[] {
	const tokens = keywords(prompt);
	if (tokens.length === 0) return [];

	const rarity = tokenRarity(entries, tokens);
	const scored = entries
		.map((entry) => ({ entry, ...scoreEntryParts(entry, tokens) }))
		.filter((candidate) => candidate.strong > 0 && candidate.total >= minScore)
		.map((candidate) => ({ ...candidate, weighted: scoreEntryWeighted(candidate.entry, tokens, rarity) }));
	if (scored.length === 0) return [];

	// Ranking only; a tie means the tokens matched several memories equally well, which is the
	// case this fallback cannot decide, so it decides nothing.
	scored.sort((a, b) => b.weighted - a.weighted);
	const best = scored[0].weighted;
	const runnerUp = scored[1]?.weighted ?? 0;
	if (runnerUp > 0 && best < runnerUp * KEYWORD_CONFIDENCE) return [];

	return scored
		.filter((candidate) => candidate.weighted >= best * RELATIVE_FLOOR)
		.slice(0, maxItems)
		.map((candidate) => candidate.entry);
}
