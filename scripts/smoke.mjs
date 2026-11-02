/**
 * End-to-end smoke test: run `pi` against a fake OpenAI-compatible endpoint and check what the
 * model actually received.
 *
 *   node scripts/smoke.mjs
 *
 * Verifies the three moving parts of the extension:
 *   1. the MEMORY.md catalog reaches the system prompt,
 *   2. relevant memories are recalled into the request,
 *   3. facts extracted after the run are written to the store.
 *
 * Exits non-zero on the first failed assertion. Every request payload is kept in
 * `<tmp>/requests.jsonl` for inspection.
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const extension = resolve(here, "..", "src", "index.ts");

const root = mkdtempSync(join(tmpdir(), "pi-memory-smoke-"));
const agentDir = join(root, "agent");
const home = join(root, "home");
const store = join(root, "memory");
const requestsFile = join(root, "requests.jsonl");

for (const dir of [agentDir, home, store]) mkdirSync(dir, { recursive: true });

// Seed a store the extension will read, in the same shape a real one has.
writeFileSync(
	join(store, "tabs.md"),
	"---\nname: tabs-preference\ndescription: 用户用 tab 缩进，不用空格\nmetadata:\n  type: user\n---\n\n写代码时用 tab 缩进。\n",
);
writeFileSync(join(store, "MEMORY.md"), "- [tabs-preference](tabs.md) — 用户用 tab 缩进，不用空格\n");

const EXTRACTION_REPLY = JSON.stringify([
	{
		name: "smoke-extracted-fact",
		type: "feedback",
		description: "smoke test extracted this fact",
		body: "Written by the extraction pass at the end of the run.",
		scope: "global",
	},
]);

const requests = [];

function sse(res, text) {
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
	const base = { id: "chatcmpl-smoke", object: "chat.completion.chunk", created: 0, model: "fake-1" };
	res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] })}\n\n`);
	res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`);
	res.write(
		`data: ${JSON.stringify({
			...base,
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
		})}\n\n`,
	);
	res.write("data: [DONE]\n\n");
	res.end();
}

const server = createServer((req, res) => {
	let body = "";
	req.on("data", (chunk) => {
		body += chunk;
	});
	req.on("end", () => {
		let payload;
		try {
			payload = JSON.parse(body);
		} catch {
			res.writeHead(400).end("bad json");
			return;
		}
		requests.push(payload);
		writeFileSync(requestsFile, requests.map((item) => JSON.stringify(item)).join("\n"));

		const text = JSON.stringify(payload.messages ?? []);
		const isExtraction = text.includes("Already stored") && text.includes("Dialogue:");
		sse(res, isExtraction ? EXTRACTION_REPLY : "ok");
	});
});

await new Promise((done) => server.listen(0, "127.0.0.1", done));
const port = server.address().port;

writeFileSync(
	join(agentDir, "models.json"),
	JSON.stringify(
		{
			providers: {
				fake: {
					name: "Fake",
					baseUrl: `http://127.0.0.1:${port}/v1`,
					apiKey: "smoke",
					authHeader: true,
					api: "openai-completions",
					models: [
						{
							id: "fake-1",
							name: "Fake 1",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 200_000,
							maxTokens: 4_096,
						},
					],
				},
			},
		},
		null,
		2,
	),
);

writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "fake", defaultModel: "fake-1" }, null, 2));
writeFileSync(
	join(agentDir, "memory.json"),
	JSON.stringify(
		{
			store: { global: store, project: false },
			extract: { enabled: true, model: "fake/fake-1", minIntervalMs: 0, skipChildSessions: true },
			recall: { useModel: true, timeoutMs: 5_000 },
			consolidate: { enabled: false },
		},
		null,
		2,
	),
);

const child = spawn(
	"pi",
	["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "-e", extension, "-p", "我写代码时缩进应该用 tab 还是空格，为什么？"],
	{
		env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agentDir, NO_COLOR: "1" },
		stdio: ["ignore", "pipe", "pipe"],
	},
);

let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => {
	stdout += chunk;
});
child.stderr.on("data", (chunk) => {
	stderr += chunk;
});

const code = await new Promise((done) => child.on("close", done));
server.close();

const failures = [];
const check = (name, condition, detail) => {
	if (condition) {
		console.log(`ok   ${name}`);
		return;
	}
	failures.push(name);
	console.log(`FAIL ${name}${detail ? `\n     ${detail}` : ""}`);
};

console.log(`pi exited with ${code}`);
console.log(`requests: ${requests.length}, payloads in ${requestsFile}`);

const serialized = JSON.stringify(requests);
check("extension reached the model", requests.length > 0, stderr.slice(0, 800));
check("catalog injected into the system prompt", /<memory>/.test(serialized) && serialized.includes("tabs-preference"));
check("recalled memory reached the request", serialized.includes("<memory-recall>") && serialized.includes("写代码时用 tab 缩进"));

const extracted = join(store, "smoke-extracted-fact.md");
check("extraction wrote a memory file", existsSync(extracted));
if (existsSync(extracted)) {
	check("extracted memory reached the catalog", readFileSync(join(store, "MEMORY.md"), "utf8").includes("smoke-extracted-fact.md"));
}
check("catalog line for the seeded memory survived", readFileSync(join(store, "MEMORY.md"), "utf8").includes("(tabs.md)"));

console.log(`\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`);
if (failures.length > 0) {
	console.log(`\n${failures.length} failed: ${failures.join(", ")}`);
	process.exit(1);
}
console.log("\nsmoke test passed");
