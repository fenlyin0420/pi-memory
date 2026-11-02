/**
 * `/memory` — inspect and curate the store without going through the model.
 *
 * The model decides what is worth remembering; the user decides what to keep.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { MemoryType } from "./config.ts";
import { MEMORY_TYPES } from "./config.ts";
import type { MemoryRuntime } from "./runtime.ts";
import { keywords, scoreEntry } from "./select.ts";

const SUBCOMMANDS = ["status", "list", "search", "show", "add", "forget", "consolidate", "auto", "reload"];

const ADD_TEMPLATE = [
	"name: ",
	"description: ",
	"type: reference",
	"scope: global",
	"",
	"Details: what the fact is, why it matters, how to apply it.",
].join("\n");

function report(ctx: ExtensionCommandContext, pi: ExtensionAPI, title: string, lines: string[]): void {
	if (ctx.mode === "tui") {
		pi.appendEntry("memory-report", { title, lines });
		return;
	}
	ctx.ui.notify([title, ...lines].join("\n"), "info");
}

function entryLine(entry: {
	name: string;
	type: string;
	scope: string;
	description: string;
	filename: string;
}): string {
	return `${entry.name} [${entry.type}/${entry.scope}] — ${entry.description || "(no description)"}  (${entry.filename})`;
}

function parseDraft(
	text: string,
): { name: string; description: string; type: MemoryType; scope?: "global" | "project"; body: string } | undefined {
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	const header: Record<string, string> = {};
	let index = 0;
	for (; index < lines.length; index++) {
		const line = lines[index];
		if (line.trim() === "") {
			index++;
			break;
		}
		const match = /^(?<key>[\w-]+)\s*:\s*(?<value>.*)$/.exec(line);
		if (!match?.groups) continue;
		header[match.groups.key.toLowerCase()] = match.groups.value.trim();
	}
	const body = lines.slice(index).join("\n").trim();
	const name = header.name?.trim();
	const description = header.description?.trim();
	if (!name || !description) return undefined;
	const type = (MEMORY_TYPES as readonly string[]).includes(header.type ?? "")
		? (header.type as MemoryType)
		: "reference";
	const scope = header.scope === "global" || header.scope === "project" ? header.scope : undefined;
	return { name, description, type, scope, body: body || description };
}

export function registerMemoryCommand(pi: ExtensionAPI, runtime: MemoryRuntime): void {
	pi.registerCommand("memory", {
		description:
			"Inspect, search, and curate long-term memory (/memory status|list|search|show|add|forget|consolidate|auto|reload)",
		getArgumentCompletions(prefix) {
			const match = SUBCOMMANDS.filter((name) => name.startsWith(prefix.trim()));
			return match.map((name) => ({ value: name, label: name }));
		},
		handler: async (args, ctx) => {
			const [command = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
			runtime.refresh();

			switch (command) {
				case "status": {
					const lines = [runtime.statusText()];
					for (const dir of runtime.directories()) {
						lines.push(`${dir.scope}: ${dir.count} memories in ${dir.dir}`);
					}
					lines.push(`config: ${runtime.configFiles.join(", ") || "defaults"}`);
					for (const warning of runtime.warnings) lines.push(`warning: ${warning}`);
					report(ctx, pi, "memory", lines);
					return;
				}

				case "list": {
					const scope = rest.find((value) => value === "global" || value === "project");
					const limit = Number(rest.find((value) => /^\d+$/.test(value)) ?? 20);
					const entries = runtime.entries.filter((entry) => !scope || entry.scope === scope).slice(0, limit);
					report(ctx, pi, `memory list${scope ? ` (${scope})` : ""}`, entries.map(entryLine));
					return;
				}

				case "search": {
					const query = rest.join(" ").trim();
					if (!query) {
						ctx.ui.notify("Usage: /memory search <words>", "warning");
						return;
					}
					const tokens = keywords(query);
					const ranked = runtime.entries
						.map((entry) => ({ entry, score: scoreEntry(entry, tokens) }))
						.filter((candidate) => candidate.score > 0)
						.sort((a, b) => b.score - a.score)
						.slice(0, 10)
						.map((candidate) => candidate.entry);
					report(ctx, pi, `memory search "${query}"`, ranked.length ? ranked.map(entryLine) : ["no match"]);
					return;
				}

				case "show": {
					const name = rest.join(" ").trim();
					const entry =
						runtime.entries.find((candidate) => candidate.name === name || candidate.filename === name) ??
						runtime.entries.find((candidate) => candidate.name.includes(name) && name.length > 0);
					if (!entry) {
						ctx.ui.notify(`No memory named "${name}"`, "warning");
						return;
					}
					report(ctx, pi, `${entry.name} (${entry.type}/${entry.scope})`, [
						`${entry.description}`,
						entry.path,
						"",
						...entry.body.split("\n"),
					]);
					return;
				}

				case "add": {
					if (!ctx.hasUI) {
						ctx.ui.notify(
							"`/memory add` needs an interactive session; use the memory_save tool instead.",
							"warning",
						);
						return;
					}
					const text = await ctx.ui.editor("New memory", ADD_TEMPLATE);
					if (!text) return;
					const draft = parseDraft(text);
					if (!draft) {
						ctx.ui.notify("A memory needs at least a name and a description.", "error");
						return;
					}
					const result = runtime.save(draft, { scope: draft.scope });
					if (!result.ok) {
						const overwrite = await ctx.ui.confirm("Memory exists", `${result.reason}\n\nOverwrite it?`);
						if (!overwrite) return;
						const forced = runtime.save(draft, { scope: draft.scope, overwrite: true });
						ctx.ui.notify(
							forced.ok ? `Saved ${forced.path}` : `Not saved: ${forced.reason}`,
							forced.ok ? "info" : "error",
						);
						return;
					}
					ctx.ui.notify(`Saved ${result.path}`, "info");
					ctx.ui.setStatus("memory", runtime.statusText());
					return;
				}

				case "forget": {
					const name = rest.join(" ").trim();
					const entry =
						runtime.entries.find((candidate) => candidate.filename === name) ??
						runtime.entries.find((candidate) => candidate.name === name);
					if (!entry) {
						ctx.ui.notify(`No memory named "${name}"`, "warning");
						return;
					}
					const confirmed = await ctx.ui.confirm(
						"Forget memory",
						`Delete ${entry.filename}?\n\n${entry.description}`,
					);
					if (!confirmed) return;
					const removed = runtime.remove(entry.filename);
					ctx.ui.notify(
						removed ? `Deleted ${entry.filename}` : `Could not delete ${entry.filename}`,
						removed ? "info" : "error",
					);
					ctx.ui.setStatus("memory", runtime.statusText());
					return;
				}

				case "consolidate": {
					const plan = await runtime.planConsolidation(ctx);
					if (plan.items.length === 0) {
						ctx.ui.notify(
							plan.reason ? `Nothing to consolidate: ${plan.reason}` : "Nothing to consolidate.",
							"info",
						);
						return;
					}
					const preview = plan.items
						.map((item) => `${item.name}: ${item.description}\n  absorbs: ${item.replaces.join(", ")}`)
						.join("\n");
					const confirmed = await ctx.ui.confirm(
						"Consolidate memories",
						`${preview}\n\nAbsorbed files are backed up under .backup/.`,
					);
					if (!confirmed) return;
					const result = runtime.applyConsolidation(plan);
					ctx.ui.notify(
						`Merged: ${result.written.join(", ") || "none"}; removed: ${result.removed.join(", ") || "none"}`,
						"info",
					);
					ctx.ui.setStatus("memory", runtime.statusText());
					return;
				}

				case "auto": {
					const target = rest[0];
					const config = runtime.config;
					if (target === "on" || target === "off") {
						const enabled = target === "on";
						config.extract.enabled = enabled;
						config.recall.enabled = enabled;
						ctx.ui.notify(
							`Memory extraction and recall ${enabled ? "enabled" : "disabled"} for this session.`,
							"info",
						);
						return;
					}
					report(ctx, pi, "memory auto", [
						`extract: ${config.extract.enabled ? "on" : "off"} (model ${config.extract.model})`,
						`recall: ${config.recall.enabled ? "on" : "off"} (up to ${config.recall.maxItems} memories)`,
						"Toggle with `/memory auto on|off` (session only; persist it in memory.json).",
					]);
					return;
				}

				case "reload": {
					runtime.init(ctx);
					ctx.ui.setStatus("memory", runtime.statusText());
					ctx.ui.notify(`Reloaded: ${runtime.statusText()}`, "info");
					return;
				}

				default:
					ctx.ui.notify(`Unknown subcommand "${command}". Try: ${SUBCOMMANDS.join(", ")}`, "warning");
			}
		},
	});
}
