/**
 * Opt-in diagnostics. Set `PI_MEMORY_DEBUG=1` to see why recall or extraction did nothing;
 * the messages go to stderr so they never reach the conversation.
 */

const enabled = Boolean(process.env.PI_MEMORY_DEBUG);

export function debug(message: string): void {
	if (!enabled) return;
	process.stderr.write(`[pi-memory] ${message}\n`);
}
