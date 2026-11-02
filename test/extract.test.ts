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
