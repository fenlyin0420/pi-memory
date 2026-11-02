import { describe, expect, it } from "vitest";
import type { MemoryEntry } from "../src/memory.ts";
import { keywordSelect, keywords, scoreEntry } from "../src/select.ts";

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
		const entries = ["a", "b", "c"].map((name) => entry({ filename: `${name}.md`, name: `tabs-${name}` }));
		expect(keywordSelect(entries, "tabs", 2)).toHaveLength(2);
	});

	it("matches CJK queries against CJK memories", () => {
		const memory = entry({ name: "缩进偏好", description: "用户喜欢缩进", body: "用 tab" });
		expect(keywordSelect([memory], "缩进用 tab 吗", 5)).toHaveLength(1);
	});
});
