import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EMPTY_STATE, readState, statePath, writeState } from "../src/state.ts";

const directories: string[] = [];
let previousAgentDir: string | undefined;

function tempStatePath(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-memory-state-"));
	directories.push(root);
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	return join(agentDir, "memory-state.json");
}

beforeEach(() => {
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const root = mkdtempSync(join(tmpdir(), "pi-memory-agentdir-"));
	directories.push(root);
	process.env.PI_CODING_AGENT_DIR = root;
});

afterEach(() => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("state", () => {
	it("defaults to an empty state when the file is missing", () => {
		expect(readState(tempStatePath())).toEqual(EMPTY_STATE);
	});

	it("round-trips the timestamp and creates the directory", () => {
		const path = tempStatePath();
		writeState({ lastConsolidateAt: 1_700_000_000_000 }, path);
		expect(readState(path)).toEqual({ lastConsolidateAt: 1_700_000_000_000 });
	});

	it("treats a corrupt or nonsensical file as empty", () => {
		const path = tempStatePath();
		writeFileSync(path, "{not json", "utf8");
		expect(readState(path)).toEqual(EMPTY_STATE);

		writeFileSync(path, JSON.stringify({ lastConsolidateAt: -5 }), "utf8");
		expect(readState(path)).toEqual(EMPTY_STATE);

		writeFileSync(path, JSON.stringify({ lastConsolidateAt: "yesterday" }), "utf8");
		expect(readState(path)).toEqual(EMPTY_STATE);
	});

	it("keeps other fields when merging a patch", () => {
		const path = tempStatePath();
		writeState({ lastConsolidateAt: 42 }, path);
		writeState({ lastConsolidateAt: 43 }, path);
		expect(readState(path)).toEqual({ lastConsolidateAt: 43 });
	});

	it("lives beside the config in the agent dir", () => {
		expect(statePath()).toBe(join(process.env.PI_CODING_AGENT_DIR as string, "memory-state.json"));
	});
});
