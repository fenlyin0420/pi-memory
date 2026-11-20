import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { MemoryEntry } from "../src/memory.ts";
import { keywordSelect, keywords, scoreEntry, selectRelevant } from "../src/select.ts";

function entry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
	return {
		filename: "tabs.md",
		name: "tabs-not-spaces",
		description: "User prefers tabs for indentation",
		type: "user",
		body: "The codebase uses tabs.",
		path: "/mem/tabs.md",
		scope: "global",
		mtimeMs: 1,
		...overrides,
	};
}

interface FakeReply {
	/** Text the provider returns, or undefined for a reply with no text part. */
	text?: string;
	stopReason?: string;
	errorMessage?: string;
}

/** SAFETY: `complete` touches only these members, so the rest of the context stays unstubbed. */
function fakeContext(reply: FakeReply = {}): ExtensionContext {
	const modelRegistry = {
		find: (provider: string, id: string) => ({ provider, id }) as unknown as Model<Api>,
		complete: async () => ({
			content: reply.text === undefined ? [] : [{ type: "text", text: reply.text }],
			stopReason: reply.stopReason ?? "stop",
			errorMessage: reply.errorMessage,
		}),
	};
	return {
		sessionManager: { getSessionId: () => "session-1" },
		modelRegistry,
	} as unknown as ExtensionContext;
}

const options = {
	maxItems: 5,
	timeoutMs: 1_000,
	model: "opencode-go/deepseek-v4.1-flash",
	useModel: true,
};

/** Five entries: the model path only runs above three, and exactly one of them matches. */
function store(): MemoryEntry[] {
	return [
		entry(),
		...["a", "b", "c", "d"].map((name) => entry({ filename: `${name}.md`, name, description: "unrelated" })),
	];
}

describe("keywords", () => {
	it("keeps latin words and drops stopwords", () => {
		const tokens = keywords("Please use the tabs for this file");
		expect(tokens).toContain("tabs");
		expect(tokens).toContain("file");
		expect(tokens).not.toContain("the");
	});

	it("turns CJK runs into bigrams", () => {
		const tokens = keywords("用户喜欢的缩进");
		expect(tokens).toContain("用户");
		expect(tokens).toContain("缩进");
		expect(tokens).not.toContain("喜欢的缩进");
	});

	it("drops path segments but keeps the words around them", () => {
		const tokens = keywords(
			"看看 C:\\Users\\Fenlyin\\.pi\\agent\\sessions\\abc.jsonl 里的缩进偏好，再看看 `sessions.ts`",
		);
		expect(tokens).not.toContain("users");
		expect(tokens).not.toContain("agent");
		expect(tokens).not.toContain("sessions");
		expect(tokens).not.toContain("session");
		expect(tokens).toContain("缩进");
		expect(tokens).toContain("偏好");
	});
});

describe("keyword recall", () => {
	it("ranks a name match above a body match", () => {
		const named = entry();
		const bodyOnly = entry({ filename: "other.md", name: "other", description: "unrelated", body: "tabs" });
		expect(scoreEntry(named, ["tabs"])).toBeGreaterThan(scoreEntry(bodyOnly, ["tabs"]));
	});

	it("returns nothing when no token matches", () => {
		expect(keywordSelect([entry()], "database migration", 5)).toEqual([]);
	});

	it("caps the result count", () => {
		const entries = [
			entry({ filename: "a.md", name: "tabs-a", description: "tabs indent notes" }),
			entry({ filename: "b.md", name: "tabs-b", description: "tabs notes" }),
			entry({ filename: "c.md", name: "tabs-c", description: "unrelated" }),
		];
		expect(keywordSelect(entries, "tabs indent notes", 2)).toHaveLength(2);
	});

	it("stays silent when one shared token ties a family of memories", () => {
		// The shape that injected junk: five memories all match one generic word equally well, so the
		// fallback has no way to tell which one the request meant.
		const family = ["a", "b", "c", "d", "e"].map((name) =>
			entry({ filename: `${name}.md`, name: `session-${name}`, description: "unrelated" }),
		);
		expect(keywordSelect(family, "session", 5)).toEqual([]);
	});

	it("prefers a rare token over one most memories share", () => {
		const shared = ["a", "b", "c", "d", "e", "f"].map((name) =>
			entry({ filename: `${name}.md`, name: `log-${name}`, description: "tail of the log" }),
		);
		const rare = entry({ filename: "rare.md", name: "keyring", description: "login blocked" });
		expect(keywordSelect([...shared, rare], "log keyring", 5).map((item) => item.filename)).toEqual(["rare.md"]);
	});

	it("matches CJK queries against CJK memories", () => {
		const memory = entry({ name: "缩进偏好", description: "用户喜欢缩进", body: "用 tab" });
		expect(keywordSelect([memory], "缩进用 tab 吗", 5)).toHaveLength(1);
	});

	it("never selects an entry on body hits alone", () => {
		const noisy = entry({ name: "unrelated", description: "also unrelated", body: "会话 请求 状态 会话请求状态" });
		expect(keywordSelect([noisy], "会话 请求 状态", 5)).toEqual([]);
	});

	it("drops a weak hit that is far below the best score", () => {
		const strong = entry({
			filename: "strong.md",
			name: "session-status",
			description: "request status report",
			body: "",
		});
		const weak = entry({ filename: "weak.md", name: "notes", description: "session", body: "" });
		// strong scores 12 (two name hits, two description hits), weak scores 2 for a lone
		// description hit, so the floor of ceil(12 * 0.5) removes it.
		expect(keywordSelect([strong, weak], "session status request", 5).map((item) => item.filename)).toEqual([
			"strong.md",
		]);
	});
});

describe("model selection", () => {
	it("keeps an explicit empty answer instead of falling back to keywords", async () => {
		const picked = await selectRelevant(fakeContext({ text: "[]" }), store(), {
			...options,
			prompt: "tabs or spaces?",
		});
		expect(picked).toEqual([]);
		// The keyword fallback would have returned the tabs memory, so an empty result proves the
		// model's answer won.
		expect(keywordSelect(store(), "tabs or spaces?", 5)).toHaveLength(1);
	});

	it("falls back to keywords when the reply is unusable", async () => {
		const nonsense = await selectRelevant(fakeContext({ text: "nonsense" }), store(), {
			...options,
			prompt: "tabs or spaces?",
		});
		expect(nonsense.map((item) => item.filename)).toEqual(["tabs.md"]);

		const errored = await selectRelevant(
			fakeContext({ stopReason: "error", errorMessage: "400 MissingSessionID" }),
			store(),
			{ ...options, prompt: "tabs or spaces?" },
		);
		expect(errored.map((item) => item.filename)).toEqual(["tabs.md"]);
	});

	it("falls back to keywords for indices that do not exist", async () => {
		const outOfRange = await selectRelevant(fakeContext({ text: "[99]" }), store(), {
			...options,
			prompt: "tabs or spaces?",
		});
		expect(outOfRange.map((item) => item.filename)).toEqual(["tabs.md"]);
	});
});
