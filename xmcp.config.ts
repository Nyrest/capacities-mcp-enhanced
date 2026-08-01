import type { XmcpConfig } from "xmcp";

const config: XmcpConfig = {
  stdio: { silent: true },
  paths: {
    tools: "./src/tools",
    prompts: false,
    resources: false,
  },
  template: {
    name: "Capacities MCP",
    description:
      "Agent-oriented CRUD and daily-note tools for the Capacities API 2.0, v4 safety contract.",
    instructions:
      "All tool results use {isError:false,data} or {isError:true,error}. Use inspect_space with a structure before unfamiliar property writes and follow its writeGuide. search_objects is title-only with limit 1-50; use returned UUIDs with get_object and entity fields. Prefer structural tools for exact edits and use *_markdown only for explicit prose/Markdown workflows, then inspect actual lossReport and entityLinks. Markdown entity conversion is strict: only a standalone non-empty link to an existing object in the current space is converted; bare hashtags, cross-space links, empty labels, and inline links remain literal text. Use only canonical hierarchy pairs Base/0, H1/1, H2/2, H3/3 and documented HTTP(S)/entity LinkToken targets. Read structured blocks before update_block or delete_block: block type cannot change, omitted children are preserved, supplied children replace them, and delete removes the subtree. Soft-delete objects unless permanent deletion is explicit. Only daily-note writes are asynchronous and return queued; synchronous writes return verification from an independent readback unless CAPACITIES_MCP_READBACK=off. Rollback deletion verification remains enabled even when normal readback is off. HTTP 429 retries are per SDK request; CAPACITIES_MCP_MAX_RATE_LIMIT_RETRIES=0 or CAPACITIES_MCP_MAX_RATE_LIMIT_WAIT_MS=0 disables all automatic waiting, and each error exposes stage/retry history.",
    icons: [{ src: "./xmcp.svg" }],
    homePage: "https://developers.capacities.io",
  },
};

export default config;
