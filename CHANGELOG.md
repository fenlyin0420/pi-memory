# Changelog

## 0.2.0

- Memory frontmatter is flat: `name`, `description`, `type`. The nested `metadata.type` block is gone from the writer and still read from existing files.
- `scripts/migrate-frontmatter.mjs` rewrites a store in place (`--dry-run` by default, `--apply` copies to `~/.cache/pi-memory-migration/` first).

## 0.1.0

- Markdown memory store shared between `~/.agents/memory` and `<repo>/.agents/memory`, with `MEMORY.md` as the catalog.
- Catalog injected as a system prompt section; relevant memories recalled per request by a model side-query with keyword fallback.
- Facts extracted after each settled run, deduplicated against the catalog, with interval and per-run limits.
- `memory_save` and `memory_search` tools; `/memory status|list|search|show|add|forget|consolidate|auto|reload`.
- Optional consolidation with backups under `.backup/`.
