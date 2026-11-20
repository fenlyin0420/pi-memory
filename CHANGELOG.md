# Changelog

## Unreleased

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
