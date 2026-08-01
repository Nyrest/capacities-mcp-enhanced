# Tool Catalog and Parameter Guide

Use this reference to select tools and construct top-level arguments. Tool names may be namespaced by the host; match the semantic name shown here.

## Contents

- [Common conventions](#common-conventions)
- [Discovery and reads](#discovery-and-reads)
- [Object creation](#object-creation)
- [Object and block mutations](#object-and-block-mutations)
- [Daily Notes](#daily-notes)
- [Media uploads](#media-uploads)
- [Common sequencing patterns](#common-sequencing-patterns)

## Common conventions

All tools accept an optional `apiToken`. It may be one API key or a comma/semicolon-separated pool. Prefer the server's configured `CAPACITIES_API_TOKEN`; keys in one pool must belong to the same space and have the same permissions. Never place a key in object content or expose it in an answer.

Important identifier rules:

- Object, block, collection, structure, and property IDs originate from live MCP responses.
- Object and block IDs are UUIDs.
- `structure` and `structures` may accept IDs or names, but IDs avoid ambiguity.
- Parameters named `id` refer to an object UUID unless the tool says otherwise.
- Omitted optional fields preserve server defaults or current values. An empty list or `null` can have a specific clearing meaning; consult the property reference.

Read [responses-errors-and-recovery.md](responses-errors-and-recovery.md) before interpreting mutation success or retrying a failure.

## Discovery and reads

### `inspect_space`

Discover structures and their writable property definitions before creating or updating typed objects.

| Parameter | Type | Required | Meaning |
|---|---|---:|---|
| `structure` | string | No | Structure ID or name. Omit for a compact catalog; provide it for the full definition and write guide. |
| `refresh` | boolean | No | Default `false`. Set `true` only when structure definitions may have changed during the session. |
| `apiToken` | string | No | Per-call token override. Prefer environment configuration. |

Without `structure`, use the result to identify the correct structure and recommended create tool. With `structure`, use the returned property IDs, types, multiplicity, writable flags, label options, and write guide as the live contract.

### `search_objects`

Search object titles. This is discovery, not full-text content search.

| Parameter | Type | Required | Meaning |
|---|---|---:|---|
| `query` | string, 1–512 chars | Yes | Title search text. |
| `structures` | string[], 1–25 items | No | Restrict to structure IDs or unambiguous names. |
| `limit` | integer, 1–50 | No | Maximum results; default `20`. |
| `apiToken` | string | No | Per-call token override. |

Search results are candidates. Resolve ambiguity with structure, ID, and `get_object`; do not assume the first title match is correct.

### `get_object`

Read an object by UUID.

| Parameter | Type | Required | Meaning |
|---|---|---:|---|
| `id` | UUID | Yes | Object ID. |
| `format` | `"structured"` or `"markdown"` | No | Default `"structured"`. |
| `apiToken` | string | No | Per-call token override. |

Use `structured` before any precise mutation. It exposes property values, collections, block IDs, block types, and child trees. Use `markdown` for compact reading, summarization, or prose context; it is normalized and lossy.

## Object creation

### `create_object`

Create a Page, Tag, Task, or custom typed object with structured body blocks.

| Parameter | Type | Required | Meaning |
|---|---|---:|---|
| `structure` | string | Yes | Structure ID or unambiguous name from `inspect_space`. |
| `title` | one-line string, max 3000 chars | Yes | Object title. Do not embed newlines. |
| `blocks` | writable block[], at least 1 if present | No | Initial body content. See `structural-content.md`. |
| `fields` | property map | No | Typed property values. See `properties-and-objects.md`. |
| `collections` | UUID[] | No | Collection membership. `[]` means the structure's default collection. |
| `apiToken` | string | No | Per-call token override. |

Do not use this tool to create a URL object; use a URL-specific create tool. Creation and block append can be separate internal stages. If content append fails after object creation, reuse the reported recoverable object ID instead of creating a duplicate.

### `create_object_markdown`

Create a typed object and body from Markdown.

| Parameter | Type | Required | Meaning |
|---|---|---:|---|
| `structure` | string | Yes | Structure ID or unambiguous name. |
| `title` | one-line string, max 3000 chars | Yes | Object title. |
| `markdown` | nonblank string, max 200000 chars | Yes | Body Markdown with real newline characters. |
| `fields` | property map | No | Typed property values applied after Markdown creation. |
| `collections` | UUID[] | No | Collection membership; `[]` selects the default collection. |
| `apiToken` | string | No | Per-call token override. |

The server handles title/body composition. Do not add a duplicate title heading merely to emulate object creation. If the property or collection patch fails, the tool attempts hard-delete rollback and reports whether rollback was verified. Follow the recovery envelope; do not immediately recreate.

### `create_object_from_url`

Create a Capacities URL object with optional structured body content.

| Parameter | Type | Required | Meaning |
|---|---|---:|---|
| `url` | absolute HTTP/HTTPS URL | Yes | The saved URL. |
| `title` | one-line string, max 3000 chars | No | Optional explicit title. |
| `description` | string, max 10000 chars | No | Optional URL description. |
| `blocks` | writable block[], at least 1 if present | No | Optional structured body content. |
| `apiToken` | string | No | Per-call token override. |

If block append fails after URL creation, use the recoverable object ID to continue or clean up.

### `create_object_from_url_markdown`

Create a URL object with a Markdown body.

| Parameter | Type | Required | Meaning |
|---|---|---:|---|
| `url` | absolute HTTP/HTTPS URL | Yes | The saved URL. |
| `title` | one-line string, max 3000 chars | No | Optional explicit title. |
| `description` | string, max 10000 chars | No | Optional URL description. |
| `markdown` | nonblank string, max 200000 chars | Yes | Body Markdown. |
| `apiToken` | string | No | Per-call token override. |

Review the returned `lossReport`. If creation succeeded but a later stage failed, follow the reported `writeState` and recoverable ID.

## Object and block mutations

### `update_object`

Update object metadata, typed properties, or collections. This tool does not edit body blocks.

| Parameter | Type | Required | Meaning |
|---|---|---:|---|
| `id` | UUID | Yes | Object ID. |
| `title` | one-line string, max 3000 chars | Conditional | New title. |
| `fields` | property map | Conditional | Property replacements or clear operations. |
| `collections` | UUID[] | Conditional | Complete collection membership; `[]` selects the default collection. |
| `apiToken` | string | No | Per-call token override. |

At least one of `title`, `fields`, or `collections` is required. Read the object first. Supplied properties replace their current values; omitted properties remain unchanged.

### `append_content`

Append structured blocks to an object's body or another rich-text property.

| Parameter | Type | Required | Meaning |
|---|---|---:|---|
| `id` | UUID | Yes | Object ID. |
| `blocks` | writable block[], at least 1 | Yes | Blocks to append. |
| `position` | `"end"`, `"start"`, or `"after_block"` | No | Default `"end"`. |
| `afterBlockId` | UUID | Conditional | Required only for `after_block`. |
| `parentBlockId` | UUID | No | Parent for `start`/`end`; parent must be a TextBlock or GroupBlock. |
| `propertyId` | string | No | Target rich-text property. Omit for the main body. |
| `apiToken` | string | No | Per-call token override. |

Rules:

- `afterBlockId` is valid only with `position: "after_block"`.
- `parentBlockId` cannot be combined with `after_block`.
- Read structured content first when placement or nesting matters.

### `append_content_markdown`

Append Markdown-converted content.

| Parameter | Type | Required | Meaning |
|---|---|---:|---|
| `id` | UUID | Yes | Object ID. |
| `markdown` | nonblank string, max 200000 chars | Yes | Markdown to append. |
| `position` | `"end"`, `"start"`, or `"after_block"` | No | Default `"end"`. |
| `afterBlockId` | UUID | Conditional | Required only for `after_block`. |
| `parentBlockId` | UUID | No | Parent for `start`/`end`; not valid with `after_block`. |
| `propertyId` | string | No | Target rich-text property; omit for main body. |
| `apiToken` | string | No | Per-call token override. |

Placement rules match `append_content`. Review `lossReport` and entity-link warnings.

### `update_block`

Replace one existing block while preserving its identity when the type remains the same.

| Parameter | Type | Required | Meaning |
|---|---|---:|---|
| `id` | UUID | Yes | Object ID. |
| `blockId` | UUID | Yes | Existing block ID from structured `get_object`. |
| `block` | writable block | Yes | Replacement content with the same block type. Do not include an ID. |
| `propertyId` | string | No | Rich-text property containing the block; omit for main body. |
| `apiToken` | string | No | Per-call token override. |

Never guess a block ID. The replacement block's type must match the existing type. For TextBlock, GroupBlock, or GridBlock, omitting `blocks`/`columns` preserves descendants; supplying them replaces the complete child list and produces new child IDs.

### `delete_block`

Delete a block and its descendants.

| Parameter | Type | Required | Meaning |
|---|---|---:|---|
| `id` | UUID | Yes | Object ID. |
| `blockId` | UUID | Yes | Block ID from structured `get_object`. |
| `apiToken` | string | No | Per-call token override. |

Read before deleting and identify the full subtree. The tool locates the block across the object's block properties; deleting a parent removes every nested child.

### `delete_object`

Soft-delete or permanently delete an object.

| Parameter | Type | Required | Meaning |
|---|---|---:|---|
| `id` | UUID | Yes | Object ID. |
| `permanent` | boolean | No | Default `false`. `true` hard-deletes irreversibly. |
| `apiToken` | string | No | Per-call token override. |

Use soft deletion unless the user explicitly requests permanent deletion and understands it cannot be recovered. A verified deletion may be represented by a readback not-found result.

## Media uploads

### `upload_files`

Upload one or more local files as Capacities media objects. The server streams
multipart parts from disk, never expects Base64 in the MCP payload, and verifies
each completed object with an independent `GET /object`.

| Parameter | Type | Required | Meaning |
|---|---|---:|---|
| `files` | object[], 1–100 | Yes | Each item has an absolute local `path`, optional `title`, and optional `fileType`. Relative paths are rejected. |
| `collections` | UUID[] | No | Collection IDs shared by every file; `[]` selects the media structure default. |
| `mode` | `wait` or `background` | No | Default `wait`; background returns a job ID immediately. |
| `apiToken` | string | No | Per-call token override. |

Use `mode: "background"` for large or long batches. A successful upload item
contains the media object and readback verification. A `partial` job means
independent files succeeded and failed separately; do not replay the entire
batch.

### `manage_upload_job`

Manage a background job in the current MCP process.

| Parameter | Type | Required | Meaning |
|---|---|---:|---|
| `jobId` | UUID | Yes | ID returned by `upload_files`. |
| `action` | `status`, `wait`, or `cancel` | Yes | Immediate status, bounded wait, or cancellation. |
| `timeoutSeconds` | integer 1–300 | No | Maximum wait duration for `action: "wait"`; default 60. |
| `apiToken` | string | No | Per-call token override. |

Cancellation aborts pending upload sessions but preserves media objects that
already completed. Job state is in-process only and is not recoverable after a
server restart.

## Daily Notes

Daily Note writes are asynchronous. They are queued and do not receive synchronous object readback.

### `append_daily_note`

| Parameter | Type | Required | Meaning |
|---|---|---:|---|
| `blocks` | writable block[], at least 1 | Yes | Structured blocks to append. |
| `date` | valid `YYYY-MM-DD` | No | Calendar date. Omit for the current UTC day used by the API. |
| `noTimestamp` | boolean | No | Control automatic timestamp insertion. |
| `apiToken` | string | No | Per-call token override. |

Resolve relative dates in the user's timezone before sending a date. Do not send an ISO timestamp in `date`.

### `append_daily_note_markdown`

| Parameter | Type | Required | Meaning |
|---|---|---:|---|
| `markdown` | nonblank string, max 200000 chars | Yes | Markdown to append. |
| `date` | valid `YYYY-MM-DD` | No | Calendar date; omit for API default. |
| `noTimestamp` | boolean | No | Control automatic timestamp insertion. |
| `apiToken` | string | No | Per-call token override. |

The loss report is preflight-only because the operation is asynchronous. Capacities entity-link conversion is disabled for Daily Note Markdown; entity-like Markdown remains literal.

## Common sequencing patterns

### Precise edit

1. `get_object(format: "structured")`
2. Select the exact block ID and preserve any descendants not being changed.
3. `update_block`
4. Inspect `verification`; re-read if not verified.

### Append prose to an existing object

1. Resolve the object with search plus structured get.
2. Use `append_content_markdown` at `end`, unless exact layout requires structured blocks.
3. Inspect `lossReport` and `verification`.

### Create a custom typed object

1. `inspect_space` for the structure.
2. Resolve label options, entity targets, and collection IDs.
3. Choose `create_object` for exact structure or `create_object_markdown` for prose.
4. Inspect rollback/partial-failure details before any manual replay.

### Recover an interrupted multi-stage create

1. Read the error envelope's `stage`, `writeState`, and `recoverableObjectId`.
2. If an object ID exists, call `get_object` before doing anything else.
3. Continue the missing stage on that object or delete it if the user wants cleanup.
4. Create a new object only when the prior object is confirmed absent or rolled back.
