import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { complete } from "../src/llm.ts";

interface FakeOptions {
	/** Text the provider returns, or undefined for a reply with no text part. */
	text?: string;
	stopReason?: string;
	errorMessage?: string;
	knownModel?: boolean;
}

interface FakeContext {
	ctx: ExtensionContext;
	/** Options the provider was called with, captured so the test can inspect them. */
	options: Record<string, unknown> | undefined;
}

function fakeContext(options: FakeOptions = {}): FakeContext {
	const fake: FakeContext = { ctx: undefined as unknown as ExtensionContext, options: undefined };
	const modelRegistry = {
		find: (provider: string, id: string) =>
			options.knownModel === false ? undefined : ({ provider, id } as unknown as Model<Api>),
		complete: async (_model: Model<Api>, _context: unknown, streamOptions: Record<string, unknown>) => {
			fake.options = streamOptions;
			return {
				content: options.text === undefined ? [] : [{ type: "text", text: options.text }],
				stopReason: options.stopReason ?? "stop",
				errorMessage: options.errorMessage,
			};
		},
	};

	// SAFETY: `complete` touches only these members; a partial stub keeps the test independent of
	// the full extension context surface.
	fake.ctx = {
		sessionManager: { getSessionId: () => "session-1" },
		modelRegistry,
	} as unknown as ExtensionContext;
	return fake;
}

const request = { system: "sys", user: "user", maxTokens: 200, timeoutMs: 5000 };

describe("complete", () => {
	it("passes the session id so providers that route per conversation accept the call", async () => {
		const fake = fakeContext({ text: "[0]" });
		const outcome = await complete(fake.ctx, "opencode-go/deepseek-v4.1-flash", request);

		expect(outcome).toEqual({ text: "[0]" });
		expect(fake.options?.sessionId).toBe("session-1");
	});

	it("keeps the side query out of the conversation's server-side thread", async () => {
		const fake = fakeContext({ text: "[0]" });
		await complete(fake.ctx, "opencode-go/deepseek-v4.1-flash", request);

		expect(fake.options?.disableContinuation).toBe(true);
	});

	it("reports an unknown model instead of calling the provider", async () => {
		const fake = fakeContext({ knownModel: false });
		const outcome = await complete(fake.ctx, "opencode-go/missing", request);

		expect(outcome).toEqual({ error: "model not available: opencode-go/missing" });
		expect(fake.options).toBeUndefined();
	});

	it("turns a provider error into an outcome instead of throwing", async () => {
		const fake = fakeContext({ stopReason: "error", errorMessage: "400 MissingSessionID" });
		const outcome = await complete(fake.ctx, "opencode-go/deepseek-v4.1-flash", request);

		expect(outcome).toEqual({ error: "400 MissingSessionID" });
	});

	it("reports an empty reply", async () => {
		const fake = fakeContext({});
		const outcome = await complete(fake.ctx, "opencode-go/deepseek-v4.1-flash", request);

		expect(outcome).toEqual({ error: "empty response" });
	});
});
