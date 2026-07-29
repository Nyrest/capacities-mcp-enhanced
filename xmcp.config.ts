import type { XmcpConfig } from "xmcp";

const config: XmcpConfig = {
  stdio: true,
  http: true,
  paths: {
    tools: "./src/tools",
    prompts: false,
    resources: false,
  },
  template: {
    name: "Capacities MCP",
    description:
      "Agent-oriented CRUD and daily-note tools for the Capacities API 2.0.",
    instructions:
      "Use inspect_space with a structure before unfamiliar property writes and follow its writeGuide. search_objects is title-only; use returned UUIDs with get_object and entity fields. Prefer structural tools for exact edits and use *_markdown only for explicit prose/Markdown workflows. Use only canonical hierarchy pairs Base/0, H1/1, H2/2, H3/3 and documented HTTP(S)/entity LinkToken targets. Read structured blocks before update_block or delete_block: block type cannot change, omitted children are preserved, supplied children replace them, and delete removes the subtree. Soft-delete objects unless permanent deletion is explicit. Only daily-note writes are asynchronous and return queued; synchronous writes return and verify the updated object. On cap_rate_limit_exceeded, wait for the endpoint reset window instead of retrying immediately.",
    icons: [{ src: "./xmcp.svg" }],
    homePage: "https://developers.capacities.io",
  },
};

export default config;
