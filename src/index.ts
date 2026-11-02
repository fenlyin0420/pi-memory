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
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { registerMemoryCommand } from "./command.ts";
import type { MemoryEntry } from "./memory.ts";
import { lastUserText, promptSignature, renderCatalogSection, renderRecallBlock } from "./prompt.ts";
import { MemoryRuntime } from "./runtime.ts";
import { keywordSelect } from "./select.ts";
import { registerMemoryTools } from "./tools.ts";

interface RecallReport {
	title?: string;
	lines?: string[];
}

function recallMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: Date.now() } as AgentMessage;
}

export default function memoryExtension(pi: ExtensionAPI): void {
	const runtime = new MemoryRuntime();

	/** Selection started in `before_agent_start`, awaited by the first request of the run. */
	let prefetch: { signature: string; promise: Promise<MemoryEntry[]> } | undefined;
	/** Rendered block for the prompt being answered, so later requests reuse it verbatim. */
	let rendered: { signature: string; block?: string } | undefined;

	const setStatus = (ctx: ExtensionContext): void => {
		try {
			ctx.ui.setStatus("memory", runtime.statusText());
		} catch {
			// Session teardown; the status line no longer matters.
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		runtime.init(ctx);
		prefetch = undefined;
		rendered = undefined;
		setStatus(ctx);
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
		if (!recall.enabled || text.length < recall.minPromptChars) {
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
		if (!recall.enabled) return;

		const prompt = lastUserText(event.messages);
		if (!prompt || prompt.length < recall.minPromptChars) return;
		const signature = promptSignature(prompt);

		if (rendered?.signature === signature) {
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
		return block ? { messages: [...event.messages, recallMessage(block)] } : undefined;
	});

	pi.on("agent_settled", async (event, ctx) => {
		if (event.aborted) return;

		const work = (async () => {
			try {
				const outcome = await runtime.extract(ctx);
				if (outcome.written.length > 0) {
					ctx.ui.notify(`memory: saved ${outcome.written.join(", ")}`, "info");
					setStatus(ctx);
				}
				runtime.refresh();
				setStatus(ctx);

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
