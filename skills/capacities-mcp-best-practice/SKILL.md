---
name: capacities-mcp-best-practice
description: Operate Capacities safely and precisely through the Capacities MCP server. Use whenever a user asks to inspect, search, read, create, update, append to, delete, or upload Capacities objects, pages, tasks, tags, web links, media files, blocks, properties, collections, or Daily Notes; when choosing structured blocks versus Markdown; or when recovering from validation, partial-write, readback, upload-job, or rate-limit errors.
---

# Capacities MCP Best Practices

Use this skill as the operating manual for the Capacities MCP server. Assume no prior knowledge of Capacities. Treat the server's current tool schemas and live `inspect_space` output as authoritative when they are more specific than this guide.

## Load only the references needed

- Read [references/tools.md](references/tools.md) before selecting or calling a tool. It documents all tools and parameters.
- Read [references/properties-and-objects.md](references/properties-and-objects.md) when working with structures, properties, fields, collections, dates, labels, entities, aliases, or icons.
- Read [references/structural-content.md](references/structural-content.md) before constructing or editing structured blocks or tokens.
- Read [references/markdown-and-entities.md](references/markdown-and-entities.md) before any Markdown write or when interpreting Markdown output.
- Read [references/responses-errors-and-recovery.md](references/responses-errors-and-recovery.md) before a mutation, and whenever a call fails, is unverified, is partial, or is rate-limited.

Do not load every reference for a simple read-only lookup.

## Mental model

Capacities stores typed **objects** inside a **space**:

- A **structure** is an object type, such as Page, Tag, Task, or a custom type.
- A structure defines typed **properties**. Object property values must conform to the live definition.
- An object can belong to zero or more **collections**.
- Object body content is a tree of **blocks**. Rich text inside blocks is an ordered array of **tokens**.
- Markdown is a convenient, intentionally lossy representation of body content. It does not replace typed properties or exact block editing.

Never infer a custom structure, property ID, label option, collection ID, or target object ID from a display name alone when live discovery can resolve it.

## Required workflow

1. **Interpret the request.** Separate object metadata, typed properties, collections, body content, and destructive intent. Determine whether the user wants a read, an append, an exact edit, or replacement.
2. **Discover the live model.** Call `inspect_space`. For a write to a named or unfamiliar structure, request that structure's full definition and write guide. Use `refresh: true` only when definitions may have changed during the session.
3. **Resolve existing objects.** Use `search_objects` for title discovery, then `get_object` by UUID. Search is title-only and is not proof of object contents.
4. **Choose a content representation.** Use the decision table below. Do not mix Markdown assumptions into structural edits.
5. **Construct a valid payload.** Use live property definitions plus the exact schemas in the references. Omit unchanged values. Treat supplied property arrays and child arrays as replacements where documented.
6. **Establish a before snapshot for edits.** Call `get_object` with `format: "structured"` before updating metadata, properties, collections, blocks, or deleting content. Keep the relevant IDs and subtree.
7. **Use concurrency-safe object operations.** Same-object reads may run concurrently; mutations use an exclusive object lock and wait for active reads or other writes, while different objects proceed concurrently. Do not replay a multi-stage create blindly after a timeout, rate limit, or partial failure.
8. **Interpret verification.** Synchronous mutation responses include readback verification. Check both the response envelope and `verification`; do not equate transport success with confirmed persistence.
9. **Confirm the result.** When precision matters, or verification is disabled, mismatched, or failed, call `get_object` again and compare the requested fields or block subtree with the before snapshot. For deletion, verify not-found as documented.
10. **Report honestly.** State what changed, whether readback verified it, and any loss, warning, recoverable object ID, or unresolved ambiguity.

## Structured or Markdown?

| Need | Use | Reason |
|---|---|---|
| Generate or append ordinary prose, headings, lists, quotes, or code quickly | Markdown | Compact and model-friendly |
| Create a page from a substantial text draft | Markdown create | One concise content payload plus typed property patching |
| Read content for summarization or semantic analysis | Markdown read | Compact normalized representation |
| Update or delete one existing block | Structured | Requires stable block IDs and exact block types |
| Preserve or create Grid layout, toggles, exact token styles, colors, nested block trees, or entity blocks | Structured | Markdown cannot represent these faithfully |
| Set typed properties, labels, dates, entities, icons, or collections | Object fields/collections | These are not body Markdown |
| Perform exact round-trip editing | Structured | Markdown export is normalized and lossy |

If one task contains both prose and exact components, split it: write prose with Markdown, then use structured tools for exact blocks. Re-read between stages so later calls use current block IDs.

## Intent-to-tool routing

| User intent | Preferred sequence |
|---|---|
| “What structures/properties are available?” | `inspect_space` |
| “Find my page/task/tag…” | `search_objects` → `get_object` |
| “Show/summarize this object” | `get_object` with Markdown for prose analysis; structured for exact inspection |
| “Create a normal typed object” | `inspect_space` → `create_object` or `create_object_markdown` |
| “Save this URL” | `create_object_from_url` or `create_object_from_url_markdown` |
| “Change title/properties/collections” | structured `get_object` → `update_object` |
| “Add content” | structured `get_object` when placement matters → `append_content` or `append_content_markdown` |
| “Edit this specific content” | structured `get_object` → `update_block` |
| “Remove this section/block” | structured `get_object` → `delete_block` |
| “Move to trash” | structured `get_object` → `delete_object` with `permanent: false` |
| “Permanently delete” | confirm explicit intent → `delete_object` with `permanent: true` |
| “Add to today's/a dated Daily Note” | `append_daily_note` or `append_daily_note_markdown` |

## Non-negotiable safety rules

- Prefer the configured `CAPACITIES_API_TOKEN`. Pass `apiToken` only when the runtime requires it. Never reveal, log, or copy the token into content.
- Use UUIDs from live responses. Do not fabricate IDs.
- Inspect a structure before writing custom fields. Property display names are accepted only when unambiguous; property IDs are safer.
- Never invent label values. Select from the live `labelOptions` catalog.
- Treat every supplied property value as replacement of that property's current value. Use omission to preserve; use the documented null or empty form to clear.
- Treat supplied `blocks` or `columns` on `update_block` as replacement of that child collection. Omit them to preserve descendants.
- Never change a block's type with `update_block`. Delete and recreate only when the user accepts new block IDs and subtree replacement.
- Do not use Markdown for exact layout or style preservation.
- Do not use Markdown output as an editable source of truth. It is a normalized view.
- Do not infer success from an `isError: false` envelope alone. Inspect `verification` and `lossReport` when present.
- Never blindly retry a create or append after an ambiguous failure. First determine `stage`, `writeState`, and whether a recoverable object ID exists.
- Serialize writes to the same object. Capacities does not provide optimistic locking through this MCP.
- Default to soft deletion. Permanent deletion is irreversible and requires clear user intent.

## Resolving ambiguity

Ask a focused question only when the unresolved choice materially changes data or cannot be discovered safely. Otherwise:

- Multiple title matches: compare structure and properties; if still ambiguous, present the candidates.
- “Add” means append or merge, not replace, unless the target is a single-valued property.
- “Set” or “change to” means replace the targeted value only.
- “Clear” means send the documented clear value for that property.
- “Update the page” without a target block means append only if that is semantically safe; otherwise inspect and identify the block.
- Relative dates such as “today” should be resolved in the user's stated timezone before sending `YYYY-MM-DD`. Daily Note dates are calendar dates, not timestamps.

## Completion standard

A Capacities task is complete only when:

- the intended object and structure were resolved;
- the chosen representation matches the required fidelity;
- the payload conforms to live definitions and the schemas in this skill;
- mutation verification or a follow-up read confirms the intended state, or uncertainty is explicitly reported;
- Markdown losses and warnings are surfaced when relevant;
- recoverable partial writes are reused or cleaned up instead of duplicated;
- the user receives a concise result with object identity and verification status.
