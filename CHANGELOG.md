# Changelog

## 0.2.3

- Consolidation's output budget now covers the model's thinking, and the failure says so. Replaying the real call against `opencode-go/deepseek-v4.1-flash` on a 227-entry store: with `maxTokens: 2000` the model returned 2000 reasoning tokens and 0 characters of text in 65s, which the command reported as `Nothing to consolidate: empty response`. `consolidate.maxTokens` (default 12000) is now configurable, a reply that is thinking only reads `only reasoning came back (stopReason=length, maxTokens=…)`, and an empty reply names its stop reason instead of a bare `empty response`.
- `consolidate.timeoutMs` default is 240s, because the same call takes 65s with a starved budget and 207s when it actually finishes. Entry bodies go into the prompt cut at 160 characters instead of 400, which halves the 49k-token input.
- Consolidation tells the truth about a failed call. A store of a few hundred memories goes into a single prompt, and when the provider aborted it the command reported `Nothing to consolidate: Request was aborted` — indistinguishable from "nothing worth merging". Our own budget firing now reads `timed out after Xs (timeoutMs=…)`, a provider cancel keeps its own message, and a failed call is reported as `Consolidation did not run` instead of "nothing to consolidate". The merging call also gets `consolidate.timeoutMs` (default 120s) instead of the old hard-coded 45s, and `PI_MEMORY_DEBUG` logs entry count, prompt size, and duration.
- `consolidate.minIntervalMs` now measures wall-clock time instead of process lifetime. The timestamp of the last run lives in `<agent dir>/memory-state.json`, so "at most once a day" holds across sessions; before, every session started from zero, the interval counted as elapsed, and consolidation was eligible again on the first settled run. `/memory status` reports the last run.
- An explicit "nothing is relevant" from the selecting model is now an answer, so recall no longer overrides an empty reply with the keyword fallback and re-injects the memories the model just rejected.
- The keyword fallback counts name and description hits only, blanks code, URLs, and path tokens out of the prompt, and keeps entries within half of the best score, so one long prompt can no longer drag half the store into the request.
- Keyword hits are weighed by token rarity (`ln(1 + N/df)`), so a rare word outranks one that half the store shares, and the fallback stays silent when the best candidate does not clearly beat the runner-up. A prompt with no real match used to come back with a whole family of memories that shared one generic word.
- The top-scoring memory gets its own byte allowance, so a tight `recall.maxTotalBytes` can no longer truncate away the entry that mattered most.
- Extraction refuses a candidate whose prose collapsed into a repeated filler token (`…里里 serving 里里 this 里里…`), which used to be written to the store and recalled on every later turn.
- Every recall now appends a `memory-report` session entry and, with `PI_MEMORY_DEBUG`, logs signature, count, bytes, and filenames, so what was injected can be audited afterwards.

## 0.2.2

- Model side queries carry the session id. Providers that route per conversation, OpenCode among them, rejected them with `400 MissingSessionID`, so recall always fell back to keyword matching and extraction never wrote a memory.
- The same queries opt out of provider-side conversation threads (`disableContinuation`), so they cannot break the continuation the real turn resumes from.

## 0.2.1

- The selector sees the whole catalog: its budget grew from 4 KB to 12 KB, so a store of ~80 memories no longer loses the tail of the list silently.

## 0.2.0

- Memory frontmatter is flat: `name`, `description`, `type`. The nested `metadata.type` block is gone from the writer and still read from existing files.
- `scripts/migrate-frontmatter.mjs` rewrites a store in place (`--dry-run` by default, `--apply` copies to `~/.cache/pi-memory-migration/` first).

## 0.1.0

- Markdown memory store shared between `~/.agents/memory` and `<repo>/.agents/memory`, with `MEMORY.md` as the catalog.
- Catalog injected as a system prompt section; relevant memories recalled per request by a model side-query with keyword fallback.
- Facts extracted after each settled run, deduplicated against the catalog, with interval and per-run limits.
- `memory_save` and `memory_search` tools; `/memory status|list|search|show|add|forget|consolidate|auto|reload`.
- Optional consolidation with backups under `.backup/`.
