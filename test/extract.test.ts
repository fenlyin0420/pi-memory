import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
	buildExtractionPrompt,
	dialogueExcerpt,
	existingCatalog,
	normalizeFact,
	parseCandidates,
} from "../src/extract.ts";

describe("parseCandidates", () => {
	it("accepts a JSON array inside prose or a code fence", () => {
		const reply =
			'Here you go:\n```json\n[{"name":"tabs-not-spaces","type":"feedback","description":"用 tab 缩进","body":"细节","scope":"project"}]\n```';
		const [candidate] = parseCandidates(reply);
		expect(candidate.name).toBe("tabs-not-spaces");
		expect(candidate.type).toBe("feedback");
		expect(candidate.scope).toBe("project");
		expect(candidate.body).toBe("细节");
	});

	it("falls back on unknown type and scope", () => {
		const [candidate] = parseCandidates('[{"name":"x","description":"y","type":"weird","scope":"mars"}]');
		expect(candidate.type).toBe("reference");
		expect(candidate.scope).toBe("global");
		expect(candidate.body).toBe("y");
	});

	it("drops entries without a name or description", () => {
		expect(parseCandidates('[{"name":"x"},{"description":"y"},{"name":"z","description":"ok"}]')).toHaveLength(1);
	});

	it("returns [] for a non-array reply", () => {
		expect(parseCandidates('{"name":"x"}')).toEqual([]);
		expect(parseCandidates("nothing here")).toEqual([]);
	});

	it("refuses a candidate whose body collapsed into a repeated filler token", () => {
		const body = Array.from({ length: 30 }, (_, index) => `推理服务里里 serving 里里 this 里里 step${index}`).join(
			" ",
		);
		expect(parseCandidates(JSON.stringify([{ name: "bad", description: "长时间冒烟测试", body }]))).toEqual([]);
	});

	it("keeps a body that names its subject an ordinary number of times", () => {
		const body = [
			"冒烟测试会拉起真模型，会话端口因此被占。",
			"起之前先问：这一步最坏会发生什么，能不能只读验证。",
			"收尾不要靠 pid 文件，用测试前后的 pgrep 差集核对孤儿进程。",
			"同样的道理适用于任何共享资源：显存、端口、生产数据。",
		].join("");
		expect(parseCandidates(JSON.stringify([{ name: "smoke", description: "冒烟测试纪律", body }]))).toHaveLength(1);
	});
});

describe("dialogueExcerpt", () => {
	const messages: AgentMessage[] = [
		{ role: "user", content: "I prefer tabs", timestamp: 1 },
		{ role: "assistant", content: [{ type: "text", text: "Noted." }], timestamp: 2 } as AgentMessage,
		{
			role: "toolResult",
			toolCallId: "1",
			toolName: "read",
			content: [],
			isError: false,
			timestamp: 3,
		} as AgentMessage,
		{ role: "user", content: "and single quotes", timestamp: 4 },
	];

	it("keeps only user and assistant text, oldest first", () => {
		const excerpt = dialogueExcerpt(messages, { maxMessages: 10, maxChars: 1_000 });
		expect(excerpt).toContain("User: I prefer tabs");
		expect(excerpt).toContain("Assistant: Noted.");
		expect(excerpt).toContain("User: and single quotes");
		expect(excerpt).not.toContain("toolResult");
		expect(excerpt.indexOf("I prefer tabs")).toBeLessThan(excerpt.indexOf("single quotes"));
	});

	it("takes the tail under a character budget", () => {
		const excerpt = dialogueExcerpt(messages, { maxMessages: 1, maxChars: 1_000 });
		expect(excerpt).toBe("User: and single quotes");
	});
});

describe("extraction prompt", () => {
	it("carries the existing catalog and the limits", () => {
		const prompt = buildExtractionPrompt({
			existing: "- tabs: prefers tabs",
			dialogue: "User: tabs please",
			maxItems: 2,
		});
		expect(prompt.user).toContain("- tabs: prefers tabs");
		expect(prompt.user).toContain("User: tabs please");
		expect(prompt.user).toContain("at most 2 objects");
		expect(prompt.user).toContain("Return []");
	});

	it("caps the existing catalog", () => {
		const catalog = existingCatalog(
			Array.from({ length: 100 }, (_, index) => ({ name: `m${index}`, description: "x".repeat(60) })),
			200,
		);
		expect(catalog.length).toBeLessThanOrEqual(200);
	});
});

describe("normalizeFact", () => {
	it("ignores punctuation and case", () => {
		expect(normalizeFact("User prefers tabs.")).toBe(normalizeFact("user prefers   tabs"));
		expect(normalizeFact("用户 喜欢 Tab")).toBe(normalizeFact("用户喜欢 tab"));
	});
});
