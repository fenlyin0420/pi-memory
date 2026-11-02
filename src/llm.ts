/**
 * One-shot model calls through the session's provider registry.
 *
 * Memory work uses its own cheap model rather than the session model: it runs after every
 * settled run, must never touch the conversation, and must never spend the user's main
 * model budget by accident.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface ModelRef {
	provider: string;
	id: string;
}

/** Parse `provider/model-id`. Bare ids are ambiguous, so they are rejected. */
export function parseModelRef(ref: string): ModelRef | undefined {
	const slash = ref.indexOf("/");
	if (slash <= 0 || slash === ref.length - 1) return undefined;
	return { provider: ref.slice(0, slash), id: ref.slice(slash + 1) };
}

export interface CompletionRequest {
	system: string;
	user: string;
	maxTokens: number;
	timeoutMs: number;
}

export interface CompletionOutcome {
	text?: string;
	/** Why nothing came back: unknown model, auth, timeout, or provider error. */
	error?: string;
}

export function resolveModel(ctx: ExtensionContext, modelRef: string): Model<Api> | undefined {
	const ref = parseModelRef(modelRef);
	if (!ref) return undefined;
	return ctx.modelRegistry.find(ref.provider, ref.id);
}

/** Run one non-streaming completion and return its text. */
export async function complete(
	ctx: ExtensionContext,
	modelRef: string,
	request: CompletionRequest,
): Promise<CompletionOutcome> {
	const model = resolveModel(ctx, modelRef);
	if (!model) return { error: `model not available: ${modelRef}` };

	let message: Awaited<ReturnType<typeof ctx.modelRegistry.complete>>;
	try {
		message = await ctx.modelRegistry.complete(
			model,
			{
				systemPrompt: request.system,
				messages: [{ role: "user", content: request.user, timestamp: Date.now() }],
			},
			{
				maxTokens: request.maxTokens,
				signal: AbortSignal.timeout(request.timeoutMs),
			},
		);
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}

	if (message.stopReason === "error" || message.stopReason === "aborted") {
		return { error: message.errorMessage ?? `request ${message.stopReason}` };
	}

	const text = message.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("")
		.trim();
	return text ? { text } : { error: "empty response" };
}

/** A value produced by `JSON.parse`, narrowed for callers that validate the fields they need. */
export type JsonReply = string | number | boolean | null | JsonReply[] | { [key: string]: JsonReply };

/** Parse the first JSON value in a model reply, tolerating prose or code fences around it. */
export function parseJsonReply(reply: string): JsonReply | undefined {
	const start = reply.search(/[[{]/);
	if (start === -1) return undefined;
	const end = Math.max(reply.lastIndexOf("]"), reply.lastIndexOf("}"));
	if (end <= start) return undefined;
	try {
		return JSON.parse(reply.slice(start, end + 1)) as JsonReply;
	} catch {
		return undefined;
	}
}
