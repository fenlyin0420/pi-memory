/**
 * pi-memory — a durable memory layer for Pi.
 *
 * Three moving parts, mirroring how Claude Code keeps memory outside the context window:
 *
 * 1. Catalog in the system prompt. `MEMORY.md` (one line per memory) is injected as a
 *    prompt section, so the model always knows what exists without paying for the bodies.
 * 2. Recall per request. Before a run starts, a cheap model picks the memories that matter
 *    for this prompt; they are appended as one extra user message on each request, which
 *    keeps the cached prefix intact. Keyword scoring takes over when the model is unavailable.
 * 3. Extraction after the run settles. New durable facts are written as markdown files and
 *    the catalog is updated, so the next session starts with them.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { registerMemoryCommand } from "./command.ts";
import { debug } from "./debug.ts";
import type { MemoryEntry } from "./memory.ts";
import { truncateText } from "./memory.ts";
import { lastUserText, promptSignature, renderCatalogSection, renderRecallBlock } from "./prompt.ts";
import { MemoryRuntime } from "./runtime.ts";
import { keywordSelect } from "./select.ts";
import { registerMemoryTools } from "./tools.ts";

interface RecallReport {
	title?: string;
	lines?: string[];
}

/** One report line stays short so the session entry reads like an index, not a second catalog. */
const RECALL_LINE_MAX = 120;

function recallMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: Date.now() } as AgentMessage;
}

/** `filename - description`, one line per recalled memory. */
function recallLine(entry: MemoryEntry): string {
	return truncateText(`${entry.filename} - ${entry.description || "(no description)"}`, RECALL_LINE_MAX);
}

/**
 * Record what recall did for one prompt. The stored entry is the audit trail: the block lives in
 * the transcript for one request, so without this nobody can tell afterwards what was injected.
 */
function reportRecall(pi: ExtensionAPI, signature: string, memories: MemoryEntry[], block: string | undefined): void {
	const files = memories.map((entry) => entry.filename);
	debug(
		`recall: signature=${signature} count=${memories.length} bytes=${block ? Buffer.byteLength(block, "utf8") : 0} files=${files.length > 0 ? files.join(", ") : "-"}`,
	);

	pi.appendEntry("memory-report", {
		title: memories.length > 0 ? `memory recall · ${memories.length}` : "memory recall · none",
		lines: memories.length > 0 ? memories.map(recallLine) : ["(nothing relevant)"],
	} satisfies RecallReport);
}

export default function memoryExtension(pi: ExtensionAPI): void {
	const runtime = new MemoryRuntime();

	/** Selection started in `before_agent_start`, awaited by the first request of the run. */
	let prefetch: { signature: string; promise: Promise<MemoryEntry[]> } | undefined;
	/** Rendered block for the prompt being answered, so later requests reuse it verbatim. */
	let rendered: { signature: string; block?: string } | undefined;

	pi.on("session_start", async (_event, ctx) => {
		runtime.init(ctx);
		prefetch = undefined;
		rendered = undefined;
	});

	pi.on("before_agent_start", async (event, ctx) => {
		runtime.refresh();

		const prompt = runtime.config.prompt;
		const section = prompt.index
			? renderCatalogSection(runtime.catalogScopes(), {
					maxItems: prompt.maxIndexItems,
					maxBytes: prompt.maxIndexBytes,
				})
			: undefined;
		if (section) event.systemPromptOptions.sections.memory = section;
		else delete event.systemPromptOptions.sections.memory;

		const recall = runtime.config.recall;
		const text = event.messageType === "user" ? (event.prompt ?? "").trim() : "";
		if (!recall.enabled) {
			debug("recall: disabled");
			prefetch = undefined;
			return;
		}
		if (text.length < recall.minPromptChars) {
			debug(`recall: prompt is ${text.length} chars, below minPromptChars=${recall.minPromptChars}`);
			prefetch = undefined;
			return;
		}

		const signature = promptSignature(text);
		if (prefetch?.signature === signature) return;
		prefetch = {
			signature,
			promise: runtime.recall(ctx, text).catch(() => keywordSelect(runtime.entries, text, recall.maxItems)),
		};
	});

	pi.on("context", async (event) => {
		const recall = runtime.config.recall;
		if (!recall.enabled) {
			debug("recall: disabled");
			return;
		}

		const prompt = lastUserText(event.messages);
		if (!prompt) {
			debug("recall: no user prompt in context");
			return;
		}
		if (prompt.length < recall.minPromptChars) {
			debug(`recall: prompt is ${prompt.length} chars, below minPromptChars=${recall.minPromptChars}`);
			return;
		}
		const signature = promptSignature(prompt);

		if (rendered?.signature === signature) {
			// Cached: this branch runs on every tool loop of the same prompt, so it logs and appends
			// nothing. One report per signature is the whole point of the entry.
			return rendered.block ? { messages: [...event.messages, recallMessage(rendered.block)] } : undefined;
		}

		const memories =
			prefetch?.signature === signature
				? await prefetch.promise
				: keywordSelect(runtime.entries, prompt, recall.maxItems);
		const block = renderRecallBlock(memories, {
			maxFileBytes: recall.maxFileBytes,
			maxTotalBytes: recall.maxTotalBytes,
		});
		rendered = { signature, block };
		reportRecall(pi, signature, memories, block);
		return block ? { messages: [...event.messages, recallMessage(block)] } : undefined;
	});

	pi.on("agent_settled", async (event, ctx) => {
		if (event.aborted) return;

		const work = (async () => {
			try {
				const outcome = await runtime.extract(ctx);
				if (outcome.written.length > 0) {
					ctx.ui.notify(`memory: saved ${outcome.written.join(", ")}`, "info");
				}
				runtime.refresh();

				const consolidate = runtime.config.consolidate;
				if (
					consolidate.enabled &&
					runtime.total() >= consolidate.threshold &&
					Date.now() - runtime.lastConsolidateAt >= consolidate.minIntervalMs
				) {
					const plan = await runtime.planConsolidation(ctx);
					if (plan.items.length > 0) runtime.applyConsolidation(plan);
				}
			} catch {
				// Memory maintenance is best-effort: a failure here must not disturb the session.
			}
		})();

		// Headless modes exit as soon as the run ends, so the extraction has to finish first.
		// Interactive modes stay usable: the write is a background task there.
		if (ctx.mode === "print" || ctx.mode === "json") await work;
		else void work;
	});

	pi.registerEntryRenderer<RecallReport>("memory-report", (entry, _options, theme) => {
		const title = theme.fg("accent", theme.bold(entry.data?.title ?? "memory"));
		const lines = (entry.data?.lines ?? []).map((line) => theme.fg("dim", line));
		return new Text([title, ...lines].join("\n"), 0, 0);
	});

	registerMemoryTools(pi, runtime);
	registerMemoryCommand(pi, runtime);
}
