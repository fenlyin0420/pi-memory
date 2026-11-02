/**
 * Rewrite memory frontmatter from the legacy nested field to a top-level `type`.
 *
 *   node scripts/migrate-frontmatter.mjs --dry-run <dir>...   (default)
 *   node scripts/migrate-frontmatter.mjs --apply  <dir>...
 *
 * `metadata:\n  type: x` and `metadata.type: x` both become `type: x`, in place; every other
 * line is preserved byte for byte. With `--apply` the directory is copied to
 * `~/.cache/pi-memory-migration/<timestamp>/` first, outside the store so a memory directory
 * that lives inside a git repository stays clean. Without arguments every `.agents/memory`
 * under $HOME is used.
 */

import { cpSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const explicit = args.filter((arg) => !arg.startsWith("--"));

function discover(root) {
	const found = [];
	const walk = (dir, depth) => {
		if (depth > 6) return;
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			if (entry.name === "node_modules" || entry.name.startsWith(".git")) continue;
			const path = join(dir, entry.name);
			if (entry.name === ".agents") {
				const memory = join(path, "memory");
				if (existsSync(memory) && statSync(memory).isDirectory()) found.push(memory);
				continue;
			}
			walk(path, depth + 1);
		}
	};
	walk(root, 0);
	return found;
}

/** Rewrite one frontmatter block. Returns undefined when nothing changes. */
export function migrateFrontmatter(raw) {
	const text = raw.replace(/^\uFEFF/, "");
	if (!text.startsWith("---\n")) return undefined;

	const close = text.indexOf("\n---", 3);
	if (close === -1) return undefined;

	const header = text.slice(4, close).split("\n");
	const body = text.slice(close);
	const out = [];
	let changed = false;

	for (let i = 0; i < header.length; i++) {
		const line = header[i];
		const nested = /^metadata:\s*$/.test(line) && /^\s+type:\s*(?<value>.+)$/.exec(header[i + 1] ?? "");
		if (nested) {
			out.push(`type: ${nested.groups.value.trim()}`);
			i++;
			changed = true;
			continue;
		}
		const flat = /^metadata\.type:\s*(?<value>.+)$/.exec(line);
		if (flat) {
			out.push(`type: ${flat.groups.value.trim()}`);
			changed = true;
			continue;
		}
		out.push(line);
	}

	if (!changed) return undefined;
	return `---\n${out.join("\n")}${body}`;
}

const dirs = explicit.length > 0 ? explicit.map((dir) => resolve(dir)) : discover(homedir());
if (dirs.length === 0) {
	console.error("no memory directories found");
	process.exit(1);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupRoot = join(homedir(), ".cache", "pi-memory-migration", stamp);
let totalChanged = 0;
let totalFiles = 0;

for (const dir of dirs) {
	let names;
	try {
		names = readdirSync(dir).filter((name) => name.endsWith(".md") && name !== "MEMORY.md");
	} catch {
		console.log(`skip  ${dir} (unreadable)`);
		continue;
	}

	const rewrites = [];
	for (const name of names) {
		totalFiles++;
		const path = join(dir, name);
		const raw = readFileSync(path, "utf8");
		const next = migrateFrontmatter(raw);
		if (next !== undefined) rewrites.push({ name, path, next });
	}

	console.log(`${rewrites.length.toString().padStart(3)}/${names.length}  ${dir}`);
	for (const item of rewrites) {
		if (!apply) console.log(`     would rewrite ${item.name}`);
	}

	if (rewrites.length === 0 || !apply) continue;

	const backup = join(backupRoot, dir.replace(/^\/+/, "").replace(/\//g, "__"));
	cpSync(dir, backup, { recursive: true });
	for (const item of rewrites) writeFileSync(item.path, item.next, "utf8");
	console.log(`     rewritten, backup at ${backup}`);
	totalChanged += rewrites.length;
}

console.log(
	apply
		? `\nrewrote ${totalChanged} of ${totalFiles} files`
		: `\n${totalFiles} files scanned; pass --apply to write`,
);
