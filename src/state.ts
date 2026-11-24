/**
 * Cross-session bookkeeping for maintenance tasks. This is not user config: it records what
 * has already run, and it is written by the extension rather than edited by hand.
 *
 * `consolidate.minIntervalMs` has to mean wall-clock time. The extension is loaded fresh in
 * every session, so a timestamp kept only in memory dies with the process: every session
 * would start from zero, read the interval as long elapsed, and consolidate again. That is
 * why the timestamp lives on disk, next to `memory.json`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface MemoryState {
	/** Epoch ms of the last applied consolidation, 0 when it never ran. */
	lastConsolidateAt: number;
}

export const EMPTY_STATE: MemoryState = { lastConsolidateAt: 0 };

export function statePath(agentDir = getAgentDir()): string {
	return join(agentDir, "memory-state.json");
}

/** Read the state file; anything missing or unreadable means "nothing has run yet". */
export function readState(path = statePath()): MemoryState {
	try {
		if (!existsSync(path)) return { ...EMPTY_STATE };
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ...EMPTY_STATE };
		const value = (parsed as { lastConsolidateAt?: unknown }).lastConsolidateAt;
		return {
			lastConsolidateAt: typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0,
		};
	} catch {
		return { ...EMPTY_STATE };
	}
}

/** Merge `patch` into the state file. Best-effort: a failed write must not disturb a session. */
export function writeState(patch: Partial<MemoryState>, path = statePath()): void {
	try {
		const next = { ...readState(path), ...patch };
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
	} catch {
		/* bookkeeping only */
	}
}
