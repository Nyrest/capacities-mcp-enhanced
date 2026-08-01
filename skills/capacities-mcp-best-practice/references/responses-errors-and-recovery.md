# Responses, Verification, Errors, Rate Limits, and Recovery

Every call has two layers: MCP transport and the JSON envelope. Every synchronous mutation adds a third layer: server readback verification. Inspect all applicable layers before deciding what happened.

## Contents

- [Unified envelopes](#unified-envelopes)
- [Mutation verification](#mutation-verification)
- [Stable error categories](#stable-error-categories)
- [Recovery by error type](#recovery-by-error-type)
- [Rate-limit behavior](#rate-limit-behavior)
- [Retry decision procedure](#retry-decision-procedure)
- [Concurrency and duplicate prevention](#concurrency-and-duplicate-prevention)

## Unified envelopes

Successful tool result:

```json
{
  "isError": false,
  "data": {
    "...": "tool-specific fields"
  }
}
```

Failed tool result:

```json
{
  "isError": true,
  "error": {
    "code": "mcp_invalid_request",
    "message": "Human-readable explanation",
    "details": {
      "stage": "precondition_read"
    }
  }
}
```

The MCP transport's `isError` and `structuredContent` mirror this envelope. Parse `structuredContent` when available; the text content carries the same JSON for hosts that expose only text.

Schema validation can fail before the tool handler runs. In that case, the MCP framework may return a native invalid-parameters error such as JSON-RPC `-32602`, not the unified envelope. Correct the payload against the tool schema and this skill; do not retry unchanged input.

## Mutation verification

Synchronous mutation `data` includes a `verification` object similar to:

```json
{
  "status": "verified",
  "readbackPerformed": true,
  "readbackVerified": true,
  "snapshotAt": "2026-08-01T08:00:00.000Z",
  "snapshotSource": "server_readback",
  "writeState": "verified"
}
```

Status meanings:

| `status` | Meaning | Agent action |
|---|---|---|
| `verified` | Independent GET matched the intended state | Treat as confirmed |
| `mismatch` | GET succeeded but semantic checks found differences | Inspect `mismatches`; do not replay mutation blindly |
| `readback_failed` | Mutation returned, but verification GET failed | State is uncertain; perform a separate `get_object` |
| `disabled` | Readback disabled by server configuration | Treat as written but unverified; re-read when important |
| `not_applicable` | Operation cannot be synchronously verified | Expected for asynchronous Daily Note writes |

`snapshotSource`:

- `server_readback`: `data.object` is the independent GET snapshot.
- `mutation_response`: object snapshot came only from the mutation response.
- `none`: no object snapshot applies.

`writeState`:

- `verified`: requested state was confirmed.
- `written_unverified`: mutation likely wrote, but exact state was not confirmed.
- `not_written`: no write occurred.
- `unknown`: the server cannot determine whether a write persisted.
- `not_applicable`: no synchronous state conclusion applies.

Possible mismatch codes include property/collection mismatch, missing or still-present blocks, block type/content mismatch, child-ID mismatch, object still present after deletion, or no new block after append. Compare the reported `path` and message with user intent.

The server operator can set `CAPACITIES_MCP_READBACK=off` to remove normal mutation readback overhead. Agents cannot assume it is on. Rollback verification for transactional Markdown create remains forced for safety.

## Stable error categories

Capacities API errors retain `cap_*` codes. Important local MCP codes:

| Code | Meaning |
|---|---|
| `mcp_invalid_request` | Payload or requested operation is invalid after entering the handler |
| `mcp_partial_failure` | An earlier stage wrote data, but a later stage failed and recovery may be needed |
| `mcp_transaction_rolled_back` | Markdown create's later patch failed and the new object was permanently deleted and verified absent |
| `mcp_configuration_error` | Token or environment configuration is missing/invalid |
| `mcp_unexpected` | Unexpected local failure |
| `mcp_upload_invalid_path` | A local upload source was not an absolute path |
| `mcp_upload_file_not_found` | A local upload source was missing or unreadable |
| `mcp_upload_job_not_found` | A background job is not retained by this MCP process |

Common Capacities codes include `cap_not_found`, authentication/permission errors, validation errors, and `cap_rate_limit_exceeded`. Preserve the exact `code`, `message`, and `details` when explaining a failure.

Stages can include:

- `discovery`
- `precondition_read`
- `mutation`
- `readback`
- `rollback_delete`
- `rollback_readback`
- `daily_note_enqueue`
- tool-specific composite stages such as `property_patch` or `markdown_entity_conversion`

## Recovery by error type

### Invalid request or schema error

1. Read the tool schema and the relevant skill reference.
2. Resolve live structure/property choices with `inspect_space`.
3. Correct the payload.
4. Retry only after changing the invalid input.

### `mcp_transaction_rolled_back`

The failed create no longer exists. Read `details.objectId`, `cause`, and rollback verification. Correct the property/collection input, then a new create is safe because rollback was verified.

### `mcp_partial_failure`

Do not create another object immediately.

1. Read `details.stage`, `recoverableObjectId`, `cause`, fallback/rollback information, and `recovery`.
2. If an object ID exists, call `get_object` on it.
3. If it exists, continue the missing stage using `update_object`, `append_content`, or `update_block`, or clean it up at the user's direction.
4. If it is not found and rollback evidence is reliable, correct the cause and restart.
5. Report unresolved markers or entity-conversion fallback failures explicitly.

### Readback mismatch or failure on a success envelope

The mutation itself must not be replayed automatically. A repeated create/append can duplicate data.

1. Call `get_object(format: "structured")` separately.
2. Compare the exact requested property, collection list, block ID/type/content, subtree, or deletion state.
3. Apply only a narrowly scoped corrective mutation if the current state is known.

### Not found

- During normal read/update: verify the ID and search again; do not substitute a similarly titled object silently.
- During deletion readback: `cap_not_found` is the expected proof of successful deletion.
- During rollback verification: not found confirms the new object was removed.

## Rate-limit behavior

The MCP retries only an individual SDK request that fails with `cap_rate_limit_exceeded`. It does not replay an entire multi-stage tool.

Server configuration:

| Environment variable | Default | Behavior |
|---|---:|---|
| `CAPACITIES_MCP_MAX_RATE_LIMIT_RETRIES` | `1` | Maximum per-request retries. `0` disables retries. |
| `CAPACITIES_MCP_MAX_RATE_LIMIT_WAIT_MS` | `30000` | Maximum allowed single wait in milliseconds. `0` disables waiting. |

Both variables require non-negative safe integers. Invalid, negative, fractional, or nonnumeric values produce `mcp_configuration_error`.

Wait calculation uses the greater of upstream retry/reset guidance and exponential backoff, plus up to 250 ms jitter. If the required delay exceeds the configured wait cap, the MCP returns the rate-limit error instead of waiting.

Rate-limit error details can include:

```json
{
  "retryAfter": 12,
  "resetAt": "2026-08-01T08:00:12.000Z",
  "attempts": 2,
  "maxRetries": 1,
  "totalWaitMs": 12207,
  "maxWaitMs": 30000,
  "stage": "readback",
  "retryHistory": [],
  "retrySuppressed": false,
  "rateLimitMetadataAvailable": true
}
```

If metadata is unavailable, `retryAfter` and `resetAt` may be `null`. Never hammer the server with immediate repeated calls.

## Retry decision procedure

When `cap_rate_limit_exceeded` escapes the MCP:

1. Inspect `stage`, `attempts`, `retryAfter`, `resetAt`, `retrySuppressed`, and `writeState` if supplied.
2. Wait until `resetAt`, or for `retryAfter` seconds, adding a small safety margin. If neither exists, use conservative exponential backoff.
3. For a read-only call, retry the same call after the wait.
4. For `stage: "mutation"` or an ambiguous network outcome, inspect the target before retrying.
5. For create/append, search or get using any returned object ID; do not duplicate an already completed stage.
6. For `stage: "readback"`, re-run only `get_object`, not the mutation.
7. For `stage: "rollback_delete"` or `rollback_readback`, inspect the recoverable object before deciding to patch or delete it.
8. Stop and report if repeated waits would exceed the user's time budget or the server continues returning 429.

For upload jobs, inspect the per-file state before retrying. Retry only failed
items; never re-submit completed media objects. A completed item with
`written_unverified` readback state requires a separate `get_object`, not a new
upload. `manage_upload_job(action: "cancel")` preserves completed items and
only aborts pending sessions.

## Concurrency and duplicate prevention

This MCP provides concurrency-safe object operations with a per-object reader/writer policy: same-object reads may run concurrently, while mutations use an exclusive lock and wait for active reads or other writes. Operations for different objects proceed concurrently. This prevents same-instance last-write-wins races while preserving the required before/after verification discipline.

- Serialize mutations to the same object.
- Re-read after another agent, user, or workflow may have edited the object.
- Before replacing multi-valued fields, merge desired changes with the current list explicitly.
- Before updating a parent block, decide whether child arrays should be preserved or replaced.
- Use idempotent reads freely, but avoid speculative writes.
- If cancellation or transport failure occurs during a write, inspect current state before any retry.
