/**
 * Tools the model can call: save a memory, search the store.
 *
 * Editing and deleting stay behind `/memory`, so the model cannot quietly remove what a
 * previous session learned.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import type { MemoryType } from "./config.ts";
import { truncateText } from "./memory.ts";
import type { MemoryRuntime } from "./runtime.ts";
import { keywordSelect, keywords, scoreEntry } from "./select.ts";

const SaveParams = Type.Object({
	name: Type.String({ description: "Short kebab-case identifier, e.g. `tabs-not-spaces`" }),
	type: StringEnum(["user", "feedback", "project", "reference"] as const),
	description: Type.String({ description: "One line, at most 140 characters, stating the fact itself" }),
	body: Type.String({
		description: "Details: what the fact is, why it matters, how to apply it (at most 800 characters)",
	}),
	scope: Type.Optional(
		StringEnum(["global", "project"] as const, {
			description: "global = every project, project = this repository only. Defaults to project for type=project.",
		}),
	),
	overwrite: Type.Optional(Type.Boolean({ description: "Replace an existing memory with the same name" })),
});
type SaveInput = Static<typeof SaveParams>;

const SearchParams = Type.Object({
	query: Type.String({ description: "What to look for; words from the fact you need" }),
	scope: Type.Optional(StringEnum(["global", "project"] as const, { description: "Restrict to one store" })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "Maximum results (default 5)" })),
	full: Type.Optional(Type.Boolean({ description: "Include memory bodies, not just descriptions" })),
});
type SearchInput = Static<typeof SearchParams>;

function formatEntry(entry: ReturnType<MemoryRuntime["findByFilename"]>, full: boolean): string {
	if (!entry) return "";
	const head = `- ${entry.name} (${entry.type}, ${entry.scope}) — ${entry.description}\n  ${entry.path}`;
	return full ? `${head}\n${entry.body}` : head;
}

export function registerMemoryTools(pi: ExtensionAPI, runtime: MemoryRuntime): void {
	pi.registerTool({
		name: "memory_save",
		label: "Save Memory",
		description:
			"Save a durable fact to the long-term memory store so it survives this session: a stated preference, a correction, project background, or where something lives. Not for transient task state.",
		promptSnippet: "Save a durable fact (preference, correction, project background) to long-term memory",
		promptGuidelines: [
			"Use memory_save when the user states a lasting preference, corrects the way you work, or explains project background that is not in the repository. One call per fact, with a short kebab-case `name` and a one-line `description`.",
			"Do not use memory_save for transient state (current task, open file, temporary decision), for code that already exists in the repository, or for anything already listed in the memory catalog.",
		],
		parameters: SaveParams,

		async execute(_toolCallId, params: SaveInput, _signal, _onUpdate) {
			const type = params.type as MemoryType;
			const outcome = runtime.save(
				{
					name: params.name,
					description: truncateText(params.description.trim(), 200),
					type,
					body: params.body.trim(),
				},
				{ scope: params.scope, overwrite: params.overwrite },
			);

			if (!outcome.ok) {
				return {
					content: [{ type: "text" as const, text: `Not saved: ${outcome.reason}` }],
					details: { saved: false, reason: outcome.reason },
				};
			}
			return {
				content: [
					{
						type: "text" as const,
						text: `Saved memory "${params.name}" (${outcome.scope}) to ${outcome.path}. It is in the catalog now; no need to read it back.`,
					},
				],
				details: { saved: true, path: outcome.path, filename: outcome.filename, scope: outcome.scope },
			};
		},
	});

	pi.registerTool({
		name: "memory_search",
		label: "Search Memory",
		description:
			"Search the long-term memory store for facts saved in earlier sessions. The catalog in the system prompt shows names and descriptions; use this when you need the body of a specific memory.",
		promptSnippet: "Search saved memories and read their bodies",
		promptGuidelines: [
			"Use memory_search with a few content words when the catalog lists a memory whose body you need. Set `full: true` to get the bodies. Reading the file directly works too; memory_search ranks across both stores.",
		],
		parameters: SearchParams,

		async execute(_toolCallId, params: SearchInput, _signal, _onUpdate) {
			runtime.refresh();
			const scope = params.scope;
			const entries = runtime.entries.filter((entry) => !scope || entry.scope === scope);
			const limit = params.limit ?? 5;
			const query = params.query.trim();

			if (!query) {
				const recent = entries.slice(0, limit);
				const lines = recent.map((entry) => formatEntry(entry, Boolean(params.full))).filter(Boolean);
				return {
					content: [{ type: "text" as const, text: lines.join("\n") || "The memory store is empty." }],
					details: { count: recent.length },
				};
			}

			const tokens = keywords(query);
			const ranked = entries
				.map((entry) => ({ entry, score: scoreEntry(entry, tokens) }))
				.filter((candidate) => candidate.score > 0)
				.sort((a, b) => b.score - a.score)
				.slice(0, limit)
				.map((candidate) => candidate.entry);

			const found = ranked.length > 0 ? ranked : keywordSelect(entries, query, limit, 0);
			if (found.length === 0) {
				return {
					content: [
						{ type: "text" as const, text: `No memory matches "${query}" in the ${scope ?? "whole"} store.` },
					],
					details: { count: 0 },
				};
			}
			return {
				content: [
					{
						type: "text" as const,
						text: found.map((entry) => formatEntry(entry, Boolean(params.full))).join("\n"),
					},
				],
				details: { count: found.length, filenames: found.map((entry) => entry.filename) },
			};
		},
	});
}
