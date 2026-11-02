/**
 * Turning a finished run into new memories.
 *
 * Runs after the agent settles, on a cheap model, over the tail of the conversation. The
 * model sees what is already stored so it does not re-save the same fact under a new name.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { MemoryType } from "./config.ts";
import type { JsonReply } from "./llm.ts";
import { parseJsonReply } from "./llm.ts";
import type { MemoryDraft, ScopeName } from "./memory.ts";
import { truncateBytes, truncateText } from "./memory.ts";
import { messageText } from "./prompt.ts";

export interface Candidate extends MemoryDraft {
	scope: ScopeName;
}

export interface ExtractionPromptInput {
	/** `name: description` lines for every stored memory. */
	existing: string;
	dialogue: string;
	maxItems: number;
}

const EXTRACT_SYSTEM = [
	"You maintain the long-term memory store of a coding agent.",
	"You receive the tail of a conversation and the catalog of what is already stored.",
	"Return only durable, reusable facts that are missing from the catalog.",
	"Reply with a JSON array and nothing else.",
].join(" ");

export function buildExtractionPrompt(input: ExtractionPromptInput): { system: string; user: string } {
	const user = [
		"Already stored:",
		input.existing || "(none)",
		"",
		"Dialogue:",
		input.dialogue,
		"",
		`Return a JSON array of at most ${input.maxItems} objects, each:`,
		`{"name": "...", "type": "user|feedback|project|reference", "description": "...", "body": "...", "scope": "global|project"}`,
		"",
		"Rules:",
		"- Write in the language of the dialogue.",
		"- name: short kebab-case identifier, unique and descriptive (e.g. `tabs-not-spaces`).",
		"- description: one line, at most 140 characters, stating the fact itself.",
		"- body: at most 800 characters. What the fact is, why it matters, and how to apply it.",
		"- type user: who the user is. feedback: how to work (a correction or a stated preference). project: what is happening in this project. reference: where something lives.",
		"- scope: `project` only for facts tied to this repository; everything else `global`.",
		"- Skip transient task state, code that already exists in the repository, and anything the catalog already covers.",
		"- Only record things the user stated or confirmed. Return [] when nothing qualifies.",
	].join("\n");
	return { system: EXTRACT_SYSTEM, user };
}

const TYPES = new Set<MemoryType>(["user", "feedback", "project", "reference"]);

function asObject(value: JsonReply): { [key: string]: JsonReply } | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function asString(value: JsonReply | undefined): string {
	return typeof value === "string" ? value.trim() : "";
}

export function parseCandidates(reply: string): Candidate[] {
	const parsed = parseJsonReply(reply);
	if (!Array.isArray(parsed)) return [];

	const candidates: Candidate[] = [];
	for (const item of parsed) {
		const object = asObject(item);
		if (!object) continue;
		const name = asString(object.name);
		const description = asString(object.description);
		const body = asString(object.body);
		if (!name || !description) continue;
		const rawType = asString(object.type).toLowerCase() as MemoryType;
		const scope = asString(object.scope) === "project" ? "project" : "global";
		candidates.push({
			name,
			description: truncateText(description, 200),
			type: TYPES.has(rawType) ? rawType : "reference",
			body: truncateBytes(body || description, 2_000),
			scope,
		});
	}
	return candidates;
}

export interface DialogueOptions {
	maxMessages: number;
	maxChars: number;
	/** Per-message cap so one huge tool output cannot crowd out the rest. */
	maxCharsPerMessage?: number;
}

/** The tail of the conversation, user and assistant text only. */
export function dialogueExcerpt(messages: readonly AgentMessage[], options: DialogueOptions): string {
	const perMessage = options.maxCharsPerMessage ?? 900;
	const blocks: string[] = [];
	let budget = options.maxChars;

	for (let i = messages.length - 1; i >= 0 && blocks.length < options.maxMessages; i--) {
		const message = messages[i];
		const role = (message as { role?: string }).role;
		if (role !== "user" && role !== "assistant") continue;
		const text = messageText(message);
		if (!text) continue;
		const label = role === "user" ? "User" : "Assistant";
		const block = `${label}: ${truncateText(text, perMessage)}`;
		if (budget - block.length < 0) break;
		budget -= block.length;
		blocks.unshift(block);
	}

	return blocks.join("\n\n");
}

/** `name: description` lines used to tell the extractor what already exists. */
export function existingCatalog(entries: readonly { name: string; description: string }[], maxChars = 4_000): string {
	return truncateText(entries.map((entry) => `- ${entry.name}: ${entry.description}`).join("\n"), maxChars);
}

const NORMALIZE = /[^\p{L}\p{N}]+/gu;

export function normalizeFact(text: string): string {
	// Comparison only: dropping every separator makes "用户 喜欢" and "用户喜欢" compare equal.
	return text.toLowerCase().replace(NORMALIZE, "");
}
