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

/** `Request was aborted` tells the caller nothing; when our own budget fired, say that instead. */
function timeoutMessage(timeoutMs: number, elapsedMs: number): string {
	return `timed out after ${(elapsedMs / 1000).toFixed(1)}s (timeoutMs=${timeoutMs})`;
}

function describeFailure(error: unknown, signal: AbortSignal, request: CompletionRequest, elapsedMs: number): string {
	const message = error instanceof Error ? error.message : String(error);
	return signal.aborted && /abort/i.test(message) ? timeoutMessage(request.timeoutMs, elapsedMs) : message;
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
	const signal = AbortSignal.timeout(request.timeoutMs);
	const startedAt = Date.now();
	try {
		message = await ctx.modelRegistry.complete(
			model,
			{
				systemPrompt: request.system,
				messages: [{ role: "user", content: request.user, timestamp: Date.now() }],
			},
			{
				maxTokens: request.maxTokens,
				// OpenCode routes per conversation and rejects a request without this header with
				// 400 MissingSessionID; a side query that fails leaves recall and extraction dead.
				sessionId: ctx.sessionManager.getSessionId(),
				// The same id keys Anthropic's server-side message threads. A side query must not
				// join the conversation's thread: doing so drops the prefix the real turn continues
				// from, so every turn after a memory call resends the full prompt.
				disableContinuation: true,
				// Side queries are serialized with the run they belong to: an already-known slow prompt
				// has to fail with a reason that names the budget, not with the provider's generic abort.
				signal,
			},
		);
	} catch (error) {
		return { error: describeFailure(error, signal, request, Date.now() - startedAt) };
	}

	if (message.stopReason === "error" || message.stopReason === "aborted") {
		return {
			error: signal.aborted
				? timeoutMessage(request.timeoutMs, Date.now() - startedAt)
				: (message.errorMessage ?? `request ${message.stopReason}`),
		};
	}

	const text = message.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("")
		.trim();
	if (text) return { text };

	// A reasoning model can spend the entire output budget thinking and never reach an answer.
	// Measured on opencode-go/deepseek-v4.1-flash: a 227-entry consolidation prompt returned one
	// thinking block and 0 characters of text under maxTokens=2000. Say that, instead of leaving
	// the caller to read "empty response" as "the model had nothing to add".
	const detail = `stopReason=${message.stopReason}, maxTokens=${request.maxTokens}`;
	const onlyReasoning = message.content.some((part) => part.type === "thinking");
	return {
		error: onlyReasoning
			? `only reasoning came back (${detail}); raise maxTokens so the answer fits`
			: `empty response (${detail})`,
	};
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
