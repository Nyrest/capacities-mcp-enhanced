# Capacities MCP — API 2.0 for AI Agents

🧠 Give Codex, Claude, Hermes, and any MCP-compatible agent a reliable way to work with your Capacities space.

> Built for the new **Capacities API 2.0**

Capacities MCP brings rich, read-write access to your knowledge base through one agent-friendly server. Agents can discover your object types, understand custom properties, create polished content, make precise edits, save web resources, and work with Daily Notes.

## ✨ Why Capacities MCP

- **Two first-class authoring engines** — fast Markdown writing and precise structured blocks in one server.
- **Full CRUD with Capacities API 2.0** — objects, custom properties, collections, blocks, web links, tasks, tags, and Daily Notes.
- **Designed for autonomous agents** — live schema discovery, consistent responses, focused tools, and clear recovery information.
- **Safer writes** — independent readback verification, soft deletion by default, scoped rate-limit retries, and rollback for failed multi-stage Markdown creates.
- **Concurrency-safe object operations** — same-object reads can run concurrently, while writes use an exclusive lock and automatically wait for active reads or other writes; different objects proceed concurrently.
- **Faithful rich content** — headings, nested blocks, grids, toggles, tasks, links, entity references, colors, code, and math.
- **Bundled best-practice skill** — a complete agent operating guide is included, so a model can use the server correctly without already knowing Capacities.

## 🚀 Quick start

### Requirements

- Node.js 20+ or Bun 1.3+
- A personal token from the new Capacities API with the permissions you need

### Installation

Configure your MCP client to use the Capacities MCP server:

Generate a token in **Capacities → Settings → Capacities API → Generate new token**. New API tokens begin with `cap-api-`.

#### Claude Code

```json
{
  "mcpServers": {
    "capacities": {
      "command": "npx",
      "args": ["--yes", "capacities-mcp-v2@latest"],
      "env": {
        "CAPACITIES_API_TOKEN": "cap-api-your-token"
      }
    }
  }
}
```

#### Hermes Agent

```yaml
mcp_servers:
  capacities:
    command: "npx"
    args:
      - "--yes"
      - "capacities-mcp-v2@latest"
    env:
      CAPACITIES_API_TOKEN: "cap-api-your-token"
    supports_parallel_tool_calls: true
```

### Install the bundled skills (Optional)

By installing the Capacities MCP Best Practices skill, your agent can learn the full workflow, strict content schemas, safe mutation patterns, rate-limit recovery, and common pitfalls.

```bash
npx skills add nyrest/capacities-mcp-v2
```

## 🧰 What agents can do

| Category | Tool | What it does |
| --- | --- | --- |
| Discover and read | `inspect_space` | Discover structures, properties, labels, and available write options. |
| Discover and read | `search_objects` | Find objects by title, optionally within selected structures. |
| Discover and read | `get_object` | Read a complete object as structured content or Markdown. |
| Create objects | `create_object` | Create a Page, Task, Tag, or custom object with structured content. |
| Create objects | `create_object_markdown` | Create an object from a Markdown document. |
| Create objects | `create_object_from_url` | Save a web resource with structured notes. |
| Create objects | `create_object_from_url_markdown` | Save a web resource with Markdown notes. |
| Update content | `update_object` | Update titles, typed properties, and collections. |
| Update content | `append_content` | Add structured blocks to an object. |
| Update content | `append_content_markdown` | Add Markdown content to an object. |
| Update content | `update_block` | Precisely edit one existing block. |
| Update content | `delete_block` | Remove one block and its nested content. |
| Update content | `delete_object` | Move an object to trash or permanently delete it when explicitly requested. |
| Daily Notes | `append_daily_note` | Add structured blocks to today's or a dated Daily Note. |
| Daily Notes | `append_daily_note_markdown` | Add Markdown to today's or a dated Daily Note. |

## ⚙️ Optional controls

```text
CAPACITIES_MCP_MAX_RATE_LIMIT_RETRIES=1
CAPACITIES_MCP_MAX_RATE_LIMIT_WAIT_MS=30000
CAPACITIES_MCP_READBACK=on
```

Set either rate-limit value to `0` to disable automatic retry waiting. Set `CAPACITIES_MCP_READBACK=off` to disable ordinary mutation readback when minimizing API usage is more important than immediate verification.

Reads for the same object can run concurrently. A mutation obtains an exclusive
object lock, so it waits for active reads and other writes; reads arriving
during a write wait as well. Operations for different objects proceed
concurrently. This protects the full read → mutate → readback lifecycle against
last-write-wins races.
The current Capacities SDK does not expose request cancellation/timeout
configuration, so this server does not use an unsafe client-side timeout race
for mutations.

## 🛠️ Development

```bash
bun run lint
bun run typecheck
bun test
bun run verify:tools
bun run build
```

The final local release gate is:

```bash
npm run release:check
npm publish --dry-run --access public
```

`npm publish --dry-run` validates the package without publishing it. Actual
publishing additionally requires an authenticated npm account.

Live API tests are available through `bun run test:live` when a dedicated test token is configured.

## 📚 Documentation

- [Capacities API 2.0 Developer Portal](https://developers.capacities.io/api/overview)
- [Capacities API 2.0 announcement](https://capacities.io/whats-new/release-67)
- [Model Context Protocol](https://modelcontextprotocol.io/)
