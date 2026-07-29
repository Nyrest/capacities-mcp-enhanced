# Capacities MCP

An agent-oriented [MCP](https://modelcontextprotocol.io/) server for Capacities API 2.0, built with TypeScript, [xmcp](https://xmcp.dev), and the official [`@capacities/api`](https://www.npmjs.com/package/@capacities/api) SDK.

- Structural JSON blocks are the default for every write.
- `get_object` returns structured JSON by default; its Markdown mode is a compact, read-only proposal/context view.
- Separate `*_markdown` write tools are available for explicit Markdown authoring; agents should choose the structural tools first.
- Personal API tokens only (OAuth is not included).
- Strict generated JSON Schemas, live structure/property discovery, verified block mutations, web-resource import, and daily-note support.

## Requirements

- Node.js 20+ or Bun 1.3+
- Capacities personal API token with `api:read` and/or `api:write`

Create a token in **Capacities → Settings → Capacities API**.

## Install

```bash
bun install
bun run build
node dist/stdio.js
```

For development: `bun run dev`.

Set authentication in the process environment (or pass `apiToken` for one call):

```bash
export CAPACITIES_API_TOKEN="cap-api-..."
```

```powershell
$env:CAPACITIES_API_TOKEN = "cap-api-..."
```

Never commit tokens or include them in shared prompts and logs.

## MCP client configuration

Use an absolute path to the built entry point:

```json
{
  "mcpServers": {
    "capacities": {
      "command": "node",
      "args": ["/absolute/path/to/capacities-mcp-v2/dist/stdio.js"],
      "env": { "CAPACITIES_API_TOKEN": "cap-api-..." }
    }
  }
}
```

## Tools

| Tool | Purpose | Main inputs |
| --- | --- | --- |
| `inspect_space` | Discover structures, properties, labels, and collections | `structure?`, `refresh?` |
| `search_objects` | Find objects by title | `query`, `structures?`, `limit?` |
| `get_object` | Read exact object data (default) or read-only Markdown view | `id`, `format?` (`structured` default) |
| `create_object` | Create an object with typed properties and optional structural blocks | `structure`, `title`, `blocks?`, `fields?`, `collections?` |
| `create_object_markdown` | Explicitly create an object from Markdown | `structure`, `title`, `markdown`, `fields?`, `collections?` |
| `create_object_from_url` | Import a URL as a web-resource with optional structural notes | `url`, `title?`, `description?`, `blocks?` |
| `create_object_from_url_markdown` | Explicitly import a URL with Markdown notes | `url`, `title?`, `description?`, `markdown` |
| `update_object` | Patch title, properties, or collections | `id`, `title?`, `fields?`, `collections?` |
| `append_content` | Insert structural blocks into an object | `id`, `blocks`, insertion options |
| `append_content_markdown` | Explicitly insert Markdown into an object | `id`, `markdown`, insertion options |
| `delete_object` | Move to trash or permanently delete | `id`, `permanent?` |
| `append_daily_note` | Queue structural blocks for a daily note | `blocks`, `date?`, `noTimestamp?` |
| `append_daily_note_markdown` | Explicitly queue Markdown for a daily note | `markdown`, `date?`, `noTimestamp?` |
| `update_block` | Replace one existing block in place using structural JSON | `id`, `blockId`, `block`, `propertyId?` |
| `delete_block` | Delete one block and any nested children | `id`, `blockId` |

All tools accept an optional `apiToken`; prefer the environment variable.

## Recommended agent workflow

1. Call `inspect_space({ structure })` before an unfamiliar write and follow its `writeGuide`. Property IDs are safest.
2. Use `search_objects` to find candidates by title, then `get_object` to inspect exact content. Search is title-only, not full-text.
3. Read with `get_object` (structured mode is the default) before updating or deleting.
4. Use `fields` for properties and `blocks` for content. Use `create_object_from_url` for web resources; ordinary create supports pages, tags, tasks, and custom object types.
5. Use `update_block` for precise in-place edits. Its block ID and type stay unchanged. Omitting `blocks` preserves existing children; supplying `blocks` replaces them.
6. Use `get_object({ format: "markdown" })` only when a compact, non-editing proposal or context view is useful.
7. Use a `*_markdown` write tool only when Markdown authoring/conversion is specifically requested; do not use it as the default editing path.
8. Prefer soft delete; set `permanent: true` only when irreversible deletion is explicit.

Example structural create:

```json
{
  "structure": "Page",
  "title": "Meeting notes",
  "blocks": [
    {
      "type": "TextBlock",
      "tokens": [
        { "type": "TextToken", "text": "Decisions: ship v1", "style": {} }
      ],
      "hierarchy": { "key": "Base", "val": 0 }
    }
  ]
}
```

Block inputs are a strict, documented subset of the SDK schema:

- Heading pairs are exactly `Base/0`, `H1/1`, `H2/2`, or `H3/3`.
- `LinkToken` has exactly one target: HTTP(S) `url` or Capacities `entityId`.
- `EntityBlock.entityId` is a non-null UUID; `GridBlock.columns`, when supplied, has at least two columns.
- Unknown block/token keys are rejected. New blocks omit IDs.

`fields` accepts property IDs or exact UI names. The `writeGuide` reports each field's live type and allowed values. Inputs include primitives, UUID arrays for entity fields, label names/IDs, `null` to clear, ISO dates or `{ start, end?, dateResolution? }`, rich-text token arrays, and `{ "type": "emoji" | "iconify", "value": "..." }` icons. Unknown, ambiguous, read-only, and invalid values are rejected before a write.

## Operational notes

- Structured reads include properties, collections, exact block trees, block IDs, and media metadata.
- Only `TextBlock` and `GroupBlock` accept appended child blocks.
- Synchronous block updates/deletes are checked against the returned object. Daily-note writes alone are queued asynchronously.
- Existing media may expose temporary signed URLs; API 2.0 has no upload endpoint.
- Daily-note `queued` means accepted, not immediately readable.
- Rate-limit and API errors retain Capacities' stable `cap_*` error code. On `cap_rate_limit_exceeded`, wait for the endpoint reset window rather than retrying immediately.
- `permanent: true` cannot be undone.

## Checks

```bash
bun run lint
bun run typecheck
bun test
bun run build
bun run verify:tools
```

With a token, run `bun run test:live` to exercise discovery, title search, both read modes, structural and Markdown create/append, child-preserving in-place block update, block deletion, URL imports, soft/permanent object deletion, and both daily-note variants. The harness serializes live requests to avoid provider burst limits. Temporary objects are permanently removed; daily-note test markers remain because the API queues those writes.

## References

- [Capacities API overview](https://developers.capacities.io/api/overview)
- [Authentication](https://developers.capacities.io/api/overview/authentication)
- [Structures](https://developers.capacities.io/api/concepts/structures)
- [Properties](https://developers.capacities.io/api/concepts/properties)
- [Objects](https://developers.capacities.io/api/concepts/objects)
- [Blocks](https://developers.capacities.io/api/concepts/blocks)
- [Text tokens](https://developers.capacities.io/api/concepts/text-tokens)
- [Markdown](https://developers.capacities.io/api/concepts/markdown)
- [xmcp tools](https://xmcp.dev/docs/core-concepts/tools)
