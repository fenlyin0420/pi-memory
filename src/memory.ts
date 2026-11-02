/**
 * Memory files on disk.
 *
 * A memory is one markdown file with YAML frontmatter:
 *
 *   ---
 *   name: tabs-preference
 *   description: User prefers tabs for indentation
 *   type: user
 *   ---
 *
 *   User prefers tabs, not spaces. **Why:** …
 *
 * `MEMORY.md` is the catalog: one link per memory, one line each. Lines that already
 * exist are preserved verbatim, so hand-written descriptions survive an update.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MemoryType } from "./config.ts";

export const INDEX_FILENAME = "MEMORY.md";

/** Files larger than this are treated as prose, not memory (keeps scans cheap). */
const MAX_MEMORY_FILE_BYTES = 64 * 1024;

export type ScopeName = "global" | "project";

export interface MemoryScope {
	name: ScopeName;
	/** Absolute directory holding the markdown files. */
	dir: string;
}

export interface MemoryEntry {
	filename: string;
	name: string;
	description: string;
	type: MemoryType;
	body: string;
	path: string;
	scope: ScopeName;
	mtimeMs: number;
}

export interface MemoryDraft {
	name: string;
	description: string;
	type: MemoryType;
	body: string;
}

export interface IndexEntry {
	label: string;
	filename: string;
	description: string;
	/** Line exactly as it appears in MEMORY.md. */
	raw: string;
}

const INDEX_LINE = /^\s*[-*]\s+\[(?<label>.*?)\]\((?<target>[^)\s]+\.md)\)\s*(?:[—–:-]\s*(?<description>.*))?$/;

export function indexFile(scope: MemoryScope): string {
	return join(scope.dir, INDEX_FILENAME);
}

export function isMemoryFilename(filename: string): boolean {
	return filename.endsWith(".md") && filename !== INDEX_FILENAME && !filename.startsWith(".");
}

export function unquote(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length >= 2) {
		const first = trimmed[0];
		const last = trimmed[trimmed.length - 1];
		if ((first === '"' || first === "'") && last === first) return trimmed.slice(1, -1);
	}
	return trimmed;
}

export interface Frontmatter {
	fields: Record<string, string>;
	body: string;
}

/**
 * Parse the leading `---` block. Unknown keys are kept in `fields`.
 * A nested `metadata:` block is still read, so files written before `type` became
 * top-level keep their type instead of silently degrading to `reference`.
 */
export function parseFrontmatter(raw: string): Frontmatter {
	const text = raw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
	if (!text.startsWith("---\n")) return { fields: {}, body: text.trim() };

	const close = text.indexOf("\n---", 3);
	if (close === -1) return { fields: {}, body: text.trim() };

	let headerEnd = close + 4;
	while (headerEnd < text.length && text[headerEnd] === "\n") headerEnd++;

	const header = text.slice(4, close);
	const fields: Record<string, string> = {};
	let parent: string | undefined;

	for (const line of header.split("\n")) {
		const match = /^(?<indent>\s*)(?<key>[\w.-]+)\s*:\s*(?<value>.*)$/.exec(line);
		if (!match?.groups) continue;
		const value = unquote(match.groups.value);
		if (!match.groups.indent) {
			if (value === "") {
				parent = match.groups.key;
				continue;
			}
			parent = undefined;
			fields[match.groups.key] = value;
			continue;
		}
		if (parent) fields[`${parent}.${match.groups.key}`] = value;
	}

	return { fields, body: text.slice(headerEnd).trim() };
}

function scalar(value: string): string {
	const flat = value.replace(/\s*\n\s*/g, " ").trim();
	if (flat === "") return '""';
	if (/^[>|&*!%@`{[]/.test(flat) || /: | #|\t/.test(flat)) {
		return `"${flat.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
	}
	return flat;
}

export function renderMemoryFile(draft: MemoryDraft): string {
	return [
		"---",
		`name: ${scalar(draft.name)}`,
		`description: ${scalar(draft.description)}`,
		`type: ${draft.type}`,
		"---",
		"",
		draft.body.trim(),
		"",
	].join("\n");
}

export function slugify(name: string): string {
	const slug = name
		.normalize("NFC")
		.trim()
		.toLowerCase()
		.replace(/[\\/:*?"<>|\p{C}]/gu, "-")
		.replace(/\s+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^[-.]+|[-.]+$/g, "");
	return (slug || "memory").slice(0, 80);
}

function pickType(fields: Record<string, string>): MemoryType {
	const raw = (fields.type ?? fields["metadata.type"] ?? "reference").toLowerCase();
	if (raw === "user" || raw === "feedback" || raw === "project" || raw === "reference") return raw;
	return "reference";
}

/** Read one memory file. Returns undefined for unreadable or oversized files. */
export function readMemoryFile(scope: MemoryScope, filename: string): MemoryEntry | undefined {
	const path = join(scope.dir, filename);
	try {
		const stat = statSync(path);
		if (!stat.isFile() || stat.size > MAX_MEMORY_FILE_BYTES) return undefined;
		const parsed = parseFrontmatter(readFileSync(path, "utf8"));
		// An empty file carries nothing: no frontmatter, no body. Listing it would only add a
		// blank catalog line, so it is not a memory.
		if (parsed.body === "" && Object.keys(parsed.fields).length === 0) return undefined;
		const name = parsed.fields.name?.trim() || filename.replace(/\.md$/, "");
		return {
			filename,
			name,
			description: parsed.fields.description?.trim() ?? "",
			type: pickType(parsed.fields),
			body: parsed.body,
			path,
			scope: scope.name,
			mtimeMs: stat.mtimeMs,
		};
	} catch {
		return undefined;
	}
}

/** List memory files, newest first. */
export function scanScope(scope: MemoryScope, limit = 400): MemoryEntry[] {
	if (!existsSync(scope.dir)) return [];
	let names: string[];
	try {
		names = readdirSync(scope.dir).filter(isMemoryFilename);
	} catch {
		return [];
	}
	const entries: MemoryEntry[] = [];
	for (const filename of names) {
		const entry = readMemoryFile(scope, filename);
		if (entry) entries.push(entry);
	}
	return entries.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit);
}

export function readIndex(scope: MemoryScope): string {
	try {
		return readFileSync(indexFile(scope), "utf8");
	} catch {
		return "";
	}
}

export function parseIndexLine(line: string): IndexEntry | undefined {
	const match = INDEX_LINE.exec(line);
	if (!match?.groups) return undefined;
	return {
		label: match.groups.label.trim(),
		filename: match.groups.target.replace(/^\.\//, ""),
		description: (match.groups.description ?? "").trim(),
		raw: line,
	};
}

export function parseIndex(text: string): IndexEntry[] {
	const entries: IndexEntry[] = [];
	for (const line of text.split("\n")) {
		const entry = parseIndexLine(line);
		if (entry) entries.push(entry);
	}
	return entries;
}

export function renderIndexLine(entry: Pick<MemoryEntry, "name" | "filename" | "description">): string {
	const description = entry.description.trim();
	return description
		? `- [${entry.name}](${entry.filename}) — ${description}`
		: `- [${entry.name}](${entry.filename})`;
}

/** Add or replace the line for one memory, leaving every other line untouched. */
export function upsertIndexLine(text: string, entry: Pick<MemoryEntry, "name" | "filename" | "description">): string {
	const line = renderIndexLine(entry);
	const lines = text.length > 0 ? text.replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n") : [];
	const existing = lines.findIndex((candidate) => parseIndexLine(candidate)?.filename === entry.filename);
	if (existing >= 0) lines[existing] = line;
	else lines.push(line);
	return `${lines.join("\n")}\n`;
}

/** Drop the line for one memory. */
export function removeIndexLine(text: string, filename: string): string {
	const lines = text.replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n");
	const kept = lines.filter((line) => parseIndexLine(line)?.filename !== filename);
	if (kept.length === 0) return "";
	return `${kept.join("\n")}\n`;
}

/** Drop lines that point at files which no longer exist. */
export function pruneIndex(text: string, existingFilenames: Set<string>): string {
	const lines = text.replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n");
	const kept = lines.filter((line) => {
		const entry = parseIndexLine(line);
		return !entry || existingFilenames.has(entry.filename);
	});
	if (kept.length === 0) return "";
	return `${kept.join("\n")}\n`;
}

export function ensureScopeDir(scope: MemoryScope): void {
	mkdirSync(scope.dir, { recursive: true });
}

/** Write a memory file atomically, then update the catalog. */
export function writeMemoryFile(scope: MemoryScope, filename: string, draft: MemoryDraft): string {
	ensureScopeDir(scope);
	const target = join(scope.dir, filename);
	const temp = `${target}.${process.pid}.tmp`;
	writeFileSync(temp, renderMemoryFile(draft), "utf8");
	renameSync(temp, target);
	writeIndex(scope, upsertIndexLine(readIndex(scope), { name: draft.name, filename, description: draft.description }));
	return target;
}

export function writeIndex(scope: MemoryScope, text: string): void {
	ensureScopeDir(scope);
	const target = indexFile(scope);
	const temp = `${target}.${process.pid}.tmp`;
	writeFileSync(temp, text, "utf8");
	renameSync(temp, target);
}

export function deleteMemoryFile(scope: MemoryScope, filename: string): boolean {
	const path = join(scope.dir, filename);
	if (!existsSync(path)) return false;
	rmSync(path, { force: true });
	writeIndex(scope, removeIndexLine(readIndex(scope), filename));
	return true;
}

/** mtimes used to detect concurrent writes while extraction runs. */
export function scopeSignature(scope: MemoryScope): string {
	const dirTime = safeMtime(scope.dir);
	const indexTime = safeMtime(indexFile(scope));
	return `${scope.name}:${dirTime}:${indexTime}`;
}

export function safeMtime(path: string): number {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return 0;
	}
}

/** Trim to a character budget, keeping whole characters and one ellipsis. */
export function truncateText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

/** Trim to a UTF-8 byte budget without splitting a multi-byte character. */
export function truncateBytes(text: string, maxBytes: number): string {
	const buffer = Buffer.from(text, "utf8");
	if (buffer.length <= maxBytes) return text;
	let end = maxBytes;
	while (end > 0 && (buffer[end] & 0b1100_0000) === 0b1000_0000) end--;
	return `${buffer.subarray(0, end).toString("utf8").trimEnd()}…`;
}
