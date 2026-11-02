import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	deleteMemoryFile,
	INDEX_FILENAME,
	type MemoryScope,
	parseFrontmatter,
	parseIndex,
	pruneIndex,
	readIndex,
	removeIndexLine,
	renderMemoryFile,
	scanScope,
	slugify,
	truncateBytes,
	upsertIndexLine,
	writeMemoryFile,
} from "../src/memory.ts";

const directories: string[] = [];

function tempScope(): MemoryScope {
	const dir = mkdtempSync(join(tmpdir(), "pi-memory-store-"));
	directories.push(dir);
	return { name: "global", dir };
}

afterEach(() => {
	for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("frontmatter", () => {
	it("reads metadata.type, the format the existing store uses", () => {
		const parsed = parseFrontmatter(
			"---\nname: user-profile\ndescription: 用户画像\nmetadata:\n  type: user\n---\n\n正文\n",
		);
		expect(parsed.fields.name).toBe("user-profile");
		expect(parsed.fields.description).toBe("用户画像");
		expect(parsed.fields["metadata.type"]).toBe("user");
		expect(parsed.body).toBe("正文");
	});

	it("reads a top-level type", () => {
		const parsed = parseFrontmatter("---\nname: x\ntype: feedback\n---\nbody");
		expect(parsed.fields.type).toBe("feedback");
	});

	it("treats a file without frontmatter as body only", () => {
		const parsed = parseFrontmatter("just prose");
		expect(parsed.fields).toEqual({});
		expect(parsed.body).toBe("just prose");
	});

	it("quotes values that would break YAML", () => {
		const rendered = renderMemoryFile({ name: "a: b", description: "why # not", type: "user", body: "x" });
		expect(rendered).toContain('name: "a: b"');
		const parsed = parseFrontmatter(rendered);
		expect(parsed.fields.name).toBe("a: b");
		expect(parsed.fields.type).toBe("user");
	});

	it("writes name, description, type in that order with no nested block", () => {
		const rendered = renderMemoryFile({ name: "tabs", description: "d", type: "reference", body: "b" });
		expect(rendered.split("\n").slice(0, 5)).toEqual([
			"---",
			"name: tabs",
			"description: d",
			"type: reference",
			"---",
		]);
		expect(rendered).not.toContain("metadata");
	});
});

describe("slugify", () => {
	it("keeps readable slugs and CJK names", () => {
		expect(slugify("Tabs Not Spaces")).toBe("tabs-not-spaces");
		expect(slugify("用户画像")).toBe("用户画像");
		expect(slugify("a/b:c")).toBe("a-b-c");
		expect(slugify("  ")).toBe("memory");
	});
});

describe("catalog", () => {
	it("adds a line without touching hand-written ones", () => {
		const existing = "- [用户画像](user-profile.md) — 手写的长描述\n- [keep](keep.md) — x\n";
		const next = upsertIndexLine(existing, { name: "tabs", filename: "tabs.md", description: "tabs" });
		expect(next).toContain("- [用户画像](user-profile.md) — 手写的长描述");
		expect(next).toContain("- [keep](keep.md) — x");
		expect(next).toContain("- [tabs](tabs.md) — tabs");
	});

	it("replaces the line for an existing file instead of duplicating it", () => {
		const next = upsertIndexLine("- [old](tabs.md) — old\n", {
			name: "tabs",
			filename: "tabs.md",
			description: "new",
		});
		expect(next.trim().split("\n")).toHaveLength(1);
		expect(next).toContain("- [tabs](tabs.md) — new");
	});

	it("prunes lines whose file disappeared and keeps everything else", () => {
		const text = "- [gone](gone.md) — x\n- [kept](kept.md) — y\n# 分组标题\n";
		const pruned = pruneIndex(text, new Set(["kept.md"]));
		expect(pruned).not.toContain("gone.md");
		expect(pruned).toContain("kept.md");
		expect(pruned).toContain("# 分组标题");
	});

	it("removes one line", () => {
		const next = removeIndexLine("- [a](a.md) — x\n- [b](b.md) — y\n", "a.md");
		expect(parseIndex(next).map((entry) => entry.filename)).toEqual(["b.md"]);
	});
});

describe("store", () => {
	it("writes a memory and its catalog line, then deletes both", () => {
		const scope = tempScope();
		const path = writeMemoryFile(scope, "tabs.md", {
			name: "tabs",
			description: "User prefers tabs",
			type: "user",
			body: "Use tabs.",
		});

		expect(readFileSync(path, "utf8")).toContain("description: User prefers tabs");
		expect(readIndex(scope)).toContain("(tabs.md)");
		expect(scanScope(scope).map((entry) => entry.filename)).toEqual(["tabs.md"]);

		expect(deleteMemoryFile(scope, "tabs.md")).toBe(true);
		expect(readIndex(scope).trim()).toBe("");
		expect(scanScope(scope)).toEqual([]);
	});

	it("skips MEMORY.md and dotfiles when scanning", () => {
		const scope = tempScope();
		mkdirSync(scope.dir, { recursive: true });
		writeFileSync(join(scope.dir, INDEX_FILENAME), "- [a](a.md) — x\n");
		writeFileSync(join(scope.dir, ".hidden.md"), "---\nname: h\n---\n");
		writeFileSync(join(scope.dir, "a.md"), "---\nname: a\ndescription: x\n---\nbody");
		expect(scanScope(scope).map((entry) => entry.filename)).toEqual(["a.md"]);
	});

	it("ignores a file with no frontmatter and no body", () => {
		const scope = tempScope();
		mkdirSync(scope.dir, { recursive: true });
		writeFileSync(join(scope.dir, "empty.md"), "");
		writeFileSync(join(scope.dir, "blank.md"), "\n\n");
		expect(scanScope(scope)).toEqual([]);
	});

	it("keeps a file readable when its frontmatter has no description", () => {
		const scope = tempScope();
		mkdirSync(scope.dir, { recursive: true });
		writeFileSync(join(scope.dir, "bare.md"), "---\nname: bare\n---\nbody text");
		const [entry] = scanScope(scope);
		expect(entry.description).toBe("");
		expect(entry.body).toBe("body text");
	});
});

describe("truncation", () => {
	it("cuts on a character boundary", () => {
		const text = "中文内容";
		const cut = truncateBytes(text, 4);
		expect(cut.length).toBeLessThanOrEqual(4);
		expect(cut.endsWith("…")).toBe(true);
		expect(truncateBytes("short", 100)).toBe("short");
	});
});
