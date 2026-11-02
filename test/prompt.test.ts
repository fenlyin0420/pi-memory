import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import type { MemoryEntry } from "../src/memory.ts";
import { lastUserText, promptSignature, renderCatalogSection, renderRecallBlock } from "../src/prompt.ts";

function entry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
	const filename = overrides.filename ?? "tabs.md";
	return {
		filename,
		name: "tabs",
		description: "User prefers tabs",
		type: "user",
		body: "Use tabs, not spaces.",
		path: `/mem/${filename}`,
		scope: "global",
		mtimeMs: 1,
		...overrides,
	};
}

describe("catalog section", () => {
	it("lists existing files in catalog order, including hand-added files", () => {
		const section = renderCatalogSection(
			[
				{
					scope: { name: "global", dir: "/mem" },
					label: "global",
					displayPath: "~/.agents/memory",
					entries: [entry(), entry({ filename: "extra.md", name: "extra", description: "Added by hand" })],
					indexLines: ["- [tabs](tabs.md) — User prefers tabs", "- [ghost](ghost.md) — missing file"],
				},
			],
			{ maxItems: 50, maxBytes: 4_000 },
		);

		expect(section).toContain("[global] ~/.agents/memory");
		expect(section).toContain("- [tabs](tabs.md) — User prefers tabs");
		expect(section).toContain("- [extra](extra.md) — Added by hand");
		expect(section).not.toContain("ghost.md");
	});

	it("returns nothing when the store is empty", () => {
		const section = renderCatalogSection(
			[
				{
					scope: { name: "global", dir: "/mem" },
					label: "global",
					displayPath: "~/.agents/memory",
					entries: [],
					indexLines: [],
				},
			],
			{ maxItems: 50, maxBytes: 4_000 },
		);
		expect(section).toBeUndefined();
	});

	it("respects the item budget", () => {
		const entries = Array.from({ length: 10 }, (_, index) =>
			entry({ filename: `m${index}.md`, name: `m${index}`, description: "x".repeat(50) }),
		);
		const section = renderCatalogSection(
			[
				{
					scope: { name: "global", dir: "/mem" },
					label: "global",
					displayPath: "/mem",
					entries,
					indexLines: entries.map((item) => `- [${item.name}](${item.filename}) — ${item.description}`),
				},
			],
			{ maxItems: 3, maxBytes: 100_000 },
		);
		expect(section?.match(/^- \[m\d\]/gm)).toHaveLength(3);
		expect(section).toContain("3 of 10 memories shown");
	});
});

describe("recall block", () => {
	it("includes name, type, path and body", () => {
		const block = renderRecallBlock([entry()], { maxFileBytes: 500, maxTotalBytes: 2_000 });
		expect(block).toContain("<memory-recall>");
		expect(block).toContain("## tabs (user) — /mem/tabs.md");
		expect(block).toContain("Use tabs, not spaces.");
		expect(block).toContain("</memory-recall>");
	});

	it("drops memories that do not fit the total budget", () => {
		const block = renderRecallBlock(
			[entry({ filename: "a.md", body: "x".repeat(400) }), entry({ filename: "b.md", body: "y".repeat(400) })],
			{ maxFileBytes: 400, maxTotalBytes: 650 },
		);
		expect(block).toContain("a.md");
		expect(block).not.toContain("b.md");
	});

	it("returns nothing for an empty list", () => {
		expect(renderRecallBlock([], { maxFileBytes: 100, maxTotalBytes: 100 })).toBeUndefined();
	});
});

describe("message helpers", () => {
	const messages: AgentMessage[] = [
		{ role: "user", content: "first prompt", timestamp: 1 },
		{ role: "assistant", content: [{ type: "text", text: "answer" }], timestamp: 2 } as AgentMessage,
		{ role: "user", content: [{ type: "text", text: "second prompt" }], timestamp: 3 } as AgentMessage,
	];

	it("finds the latest user text", () => {
		expect(lastUserText(messages)).toBe("second prompt");
	});

	it("signs the same prompt the same way", () => {
		expect(promptSignature("hello world")).toBe(promptSignature("hello world"));
		expect(promptSignature("hello world")).not.toBe(promptSignature("hello worlds"));
	});
});
