import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type MemoryScope, readIndex, scanScope } from "../src/memory.ts";
import { findProjectRoot, MemoryRuntime } from "../src/runtime.ts";

interface FakeOptions {
	cwd: string;
	/** Model reply for extraction and selection calls. */
	reply?: string;
	branch?: AgentMessage[];
	header?: Record<string, unknown>;
}

interface FakeContext {
	ctx: ExtensionContext;
	notifications: string[];
	/** System prompts sent to the model, in call order. */
	calls: number;
}

function fakeContext(options: FakeOptions): FakeContext {
	const notifications: string[] = [];
	const fake = { calls: 0 };
	const modelRegistry = {
		find: (provider: string, id: string) => ({ provider, id }) as unknown as Model<Api>,
		complete: async () => {
			fake.calls++;
			return { content: [{ type: "text", text: options.reply ?? "[]" }], stopReason: "stop" };
		},
	};

	// SAFETY: MemoryRuntime touches only these members; casting a partial stub keeps the test
	// independent of the full extension context surface.
	const ctx = {
		cwd: options.cwd,
		isProjectTrusted: () => true,
		ui: {
			notify: (text: string) => notifications.push(text),
		},
		sessionManager: {
			getBranch: () => (options.branch ?? []).map((message) => ({ type: "message", message })),
			getHeader: () => options.header ?? {},
		},
		modelRegistry,
	} as unknown as ExtensionContext;

	return {
		ctx,
		notifications,
		get calls() {
			return fake.calls;
		},
	};
}

const directories: string[] = [];
let previousAgentDir: string | undefined;

/**
 * A temp store wired through the extension's own config file, so the test exercises the
 * same path a real session takes.
 */
function setup(config: Record<string, unknown> = {}): {
	runtime: MemoryRuntime;
	store: MemoryScope;
	ctx: ExtensionContext;
} {
	const root = mkdtempSync(join(tmpdir(), "pi-memory-runtime-"));
	directories.push(root);
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;

	const storeDir = join(root, "store");
	writeFileSync(
		join(agentDir, "memory.json"),
		JSON.stringify({
			store: { global: storeDir, project: false },
			extract: { enabled: true, minIntervalMs: 0, model: "fake/model" },
			recall: { useModel: false },
			...config,
		}),
	);

	const store: MemoryScope = { name: "global", dir: storeDir };
	const { ctx } = fakeContext({ cwd: root });
	const runtime = new MemoryRuntime();
	runtime.init(ctx);
	return { runtime, store, ctx };
}

beforeEach(() => {
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
});

afterEach(() => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("save", () => {
	it("writes a file and a catalog line", () => {
		const { runtime, store } = setup();
		const result = runtime.save({
			name: "Tabs Not Spaces",
			description: "用户用 tab",
			type: "user",
			body: "用 tab。",
		});

		expect(result.ok).toBe(true);
		expect(result.filename).toBe("tabs-not-spaces.md");
		expect(existsSync(join(store.dir, "tabs-not-spaces.md"))).toBe(true);
		expect(readIndex(store)).toContain("- [Tabs Not Spaces](tabs-not-spaces.md) — 用户用 tab");
		expect(runtime.total()).toBe(1);
	});

	it("rejects a second memory with the same fact", () => {
		const { runtime } = setup();
		runtime.save({ name: "tabs", description: "User prefers tabs", type: "user", body: "a" });
		const again = runtime.save({ name: "indentation", description: "user prefers TABS.", type: "user", body: "b" });
		expect(again.ok).toBe(false);
		expect(again.reason).toContain("already stored");
	});

	it("rejects an existing filename unless overwrite is set", () => {
		const { runtime, store } = setup();
		runtime.save({ name: "tabs", description: "first", type: "user", body: "a" });
		expect(runtime.save({ name: "tabs", description: "second", type: "user", body: "b" }).ok).toBe(false);

		const forced = runtime.save(
			{ name: "tabs", description: "second", type: "user", body: "b" },
			{ overwrite: true },
		);
		expect(forced.ok).toBe(true);
		expect(readFileSync(join(store.dir, "tabs.md"), "utf8")).toContain("description: second");
	});

	it("removes a memory and its catalog line", () => {
		const { runtime, store } = setup();
		runtime.save({ name: "tabs", description: "x", type: "user", body: "a" });
		expect(runtime.remove("tabs.md")).toBe(true);
		expect(readIndex(store).trim()).toBe("");
		expect(scanScope(store)).toEqual([]);
	});
});

describe("extraction", () => {
	it("stores what the model returns and skips it next time", async () => {
		const reply = JSON.stringify([
			{
				name: "single-quotes",
				type: "feedback",
				description: "用户偏好单引号",
				body: "写字符串用 '",
				scope: "global",
			},
		]);
		const { runtime, store, ctx } = setup();
		const context = fakeContext({
			cwd: store.dir,
			reply,
			branch: [{ role: "user", content: "用单引号写字符串", timestamp: 1 }],
		});

		const first = await runtime.extract(context.ctx);
		expect(first.written).toEqual(["single-quotes.md"]);
		expect(readFileSync(join(store.dir, "single-quotes.md"), "utf8")).toContain("type: feedback");

		runtime.lastExtractAt = 0;
		const second = await runtime.extract(context.ctx);
		expect(second.written).toEqual([]);
		expect(runtime.total()).toBe(1);
		void ctx;
	});

	it("does nothing when extraction is disabled", async () => {
		const { runtime } = setup({ extract: { enabled: false } });
		const context = fakeContext({ cwd: "/tmp", reply: '[{"name":"x","description":"y"}]' });
		const outcome = await runtime.extract(context.ctx);
		expect(outcome).toEqual({ written: [], reason: "disabled" });
		expect(context.calls).toBe(0);
	});

	it("skips child sessions", async () => {
		const { runtime } = setup();
		const context = fakeContext({ cwd: "/tmp", reply: "[]", header: { parentSession: "/tmp/parent.jsonl" } });
		const outcome = await runtime.extract(context.ctx);
		expect(outcome.reason).toBe("child session");
	});

	it("throttles repeated runs", async () => {
		const { runtime } = setup({ extract: { minIntervalMs: 60_000 } });
		const context = fakeContext({
			cwd: "/tmp",
			reply: "[]",
			branch: [{ role: "user", content: "hi", timestamp: 1 }],
		});
		await runtime.extract(context.ctx);
		const outcome = await runtime.extract(context.ctx);
		expect(outcome.reason).toBe("throttled");
	});
});

describe("recall", () => {
	it("falls back to keywords when the model is not used", async () => {
		const { runtime, ctx } = setup();
		runtime.save({ name: "tabs", description: "User prefers tabs for indentation", type: "user", body: "tabs" });
		const memories = await runtime.recall(ctx, "which indentation should I use?");
		expect(memories.map((entry) => entry.filename)).toEqual(["tabs.md"]);
	});
});

describe("project scope", () => {
	it("finds the repository root and stores project memories there", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-memory-project-"));
		directories.push(root);
		mkdirSync(join(root, ".git"), { recursive: true });
		const nested = join(root, "src", "deep");
		mkdirSync(nested, { recursive: true });
		expect(findProjectRoot(nested)).toBe(root);

		const agentDir = join(root, "agent");
		mkdirSync(agentDir, { recursive: true });
		process.env.PI_CODING_AGENT_DIR = agentDir;
		writeFileSync(
			join(agentDir, "memory.json"),
			JSON.stringify({ store: { global: join(root, "global"), project: true } }),
		);

		const { ctx } = fakeContext({ cwd: nested });
		const runtime = new MemoryRuntime();
		runtime.init(ctx);
		runtime.save({
			name: "auth-rewrite",
			description: "auth rewrite is compliance driven",
			type: "project",
			body: "x",
		});

		expect(runtime.entries.some((entry) => entry.scope === "project")).toBe(true);
		expect(existsSync(join(root, ".agents", "memory", "auth-rewrite.md"))).toBe(true);
		expect(existsSync(join(root, "global"))).toBe(false);
	});
});
