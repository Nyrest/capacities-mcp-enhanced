import { createSTDIOClient, disconnectSTDIOClient } from "xmcp";

type JsonSchema = {
  type?: string;
  const?: unknown;
  format?: string;
  pattern?: string;
  minItems?: number;
  minimum?: number;
  maximum?: number;
  description?: string;
  required?: string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  enum?: unknown[];
  definitions?: Record<string, JsonSchema>;
  additionalProperties?: boolean | JsonSchema;
};

const expectedTools = [
  "append_content",
  "append_content_markdown",
  "append_daily_note",
  "append_daily_note_markdown",
  "create_object",
  "create_object_from_url",
  "create_object_from_url_markdown",
  "create_object_markdown",
  "delete_block",
  "delete_object",
  "get_object",
  "inspect_space",
  "manage_upload_job",
  "search_objects",
  "update_block",
  "update_object",
  "upload_files",
];

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Generated MCP schema regression: ${message}`);
  }
}

function variants(schema: JsonSchema): JsonSchema[] {
  return schema.anyOf ?? [];
}

function objectVariant(schema: JsonSchema, discriminator: string): JsonSchema {
  const match = variants(schema).find(
    (candidate) => candidate.properties?.type?.const === discriminator,
  );
  expect(match, `missing ${discriminator} variant`);
  return match;
}

function assertStrictObject(schema: JsonSchema, label: string): void {
  expect(schema.type === "object", `${label} must be an object`);
  expect(
    schema.additionalProperties === false,
    `${label} must reject unknown keys`,
  );
}

function verifyOutputEnvelope(toolName: string, schema?: JsonSchema): void {
  expect(schema, `${toolName}.outputSchema is missing`);
  expect(
    schema.type === "object",
    `${toolName}.outputSchema must be an object`,
  );
  expect(
    schema.required?.includes("isError"),
    `${toolName}.outputSchema must require isError`,
  );
  expect(
    schema.properties?.isError?.type === "boolean",
    `${toolName}.outputSchema.isError must be boolean`,
  );
  expect(
    schema.properties?.data?.type === "object" &&
      schema.properties.data.additionalProperties !== false,
    `${toolName}.outputSchema must expose the success data object`,
  );
  expect(
    schema.properties?.error?.type === "object",
    `${toolName}.outputSchema must expose the error object`,
  );
  expect(
    schema.properties?.error?.required?.includes("code") &&
      schema.properties.error.required.includes("message"),
    `${toolName}.outputSchema.error must require code and message`,
  );
}

function verifyStructuralSchema(schema: JsonSchema): void {
  const blockRef = schema.properties?.blocks?.items;
  expect(blockRef, "create_object.blocks.items is missing");

  const blockDefinition = Object.values(schema.definitions ?? {}).find(
    (definition) =>
      variants(definition).some(
        (candidate) => candidate.properties?.type?.const === "TextBlock",
      ),
  );
  expect(blockDefinition, "recursive writable block definition is missing");

  const textBlock = objectVariant(blockDefinition, "TextBlock");
  const gridBlock = objectVariant(blockDefinition, "GridBlock");
  const entityBlock = objectVariant(blockDefinition, "EntityBlock");
  assertStrictObject(textBlock, "TextBlock");
  assertStrictObject(gridBlock, "GridBlock");
  assertStrictObject(entityBlock, "EntityBlock");

  expect(
    !textBlock.properties?.textAlignment && !textBlock.properties?.highlight,
    "TextBlock exposes undocumented textAlignment/highlight fields",
  );

  const headingPairs = variants(textBlock.properties?.hierarchy ?? {}).map(
    (candidate) => [
      candidate.properties?.key?.const,
      candidate.properties?.val?.const,
    ],
  );
  expect(
    JSON.stringify(headingPairs) ===
      JSON.stringify([
        ["Base", 0],
        ["H1", 1],
        ["H2", 2],
        ["H3", 3],
      ]),
    "hierarchy must expose only canonical Base/0 through H3/3 pairs",
  );

  expect(
    gridBlock.properties?.columns?.minItems === 2,
    "GridBlock.columns must require at least two columns",
  );
  expect(
    entityBlock.required?.includes("entityId") &&
      entityBlock.properties?.entityId?.format === "uuid",
    "EntityBlock.entityId must be a required UUID",
  );

  const tokenSchema = textBlock.properties?.tokens?.items;
  expect(tokenSchema, "TextBlock token schema is missing");
  const linkVariants = variants(tokenSchema).filter(
    (candidate) => candidate.properties?.type?.const === "LinkToken",
  );
  expect(
    linkVariants.length === 2,
    "LinkToken must have separate URL and entity variants",
  );
  const requiredTargets = linkVariants
    .map((candidate) =>
      candidate.required?.includes("url")
        ? "url"
        : candidate.required?.includes("entityId")
          ? "entityId"
          : "missing",
    )
    .sort();
  expect(
    JSON.stringify(requiredTargets) === JSON.stringify(["entityId", "url"]),
    "each LinkToken variant must require exactly one documented target",
  );
  expect(
    linkVariants.every(
      (candidate) =>
        candidate.additionalProperties === false && !candidate.properties?.date,
    ),
    "LinkToken variants must reject extra and undocumented date targets",
  );
  const urlLink = linkVariants.find((candidate) =>
    candidate.required?.includes("url"),
  );
  expect(
    urlLink?.properties?.url?.pattern?.includes("https?"),
    "URL LinkToken targets must be schema-constrained to HTTP(S)",
  );

  const fieldVariants = variants(
    schema.properties?.fields?.additionalProperties as JsonSchema,
  );
  expect(
    fieldVariants.some(
      (candidate) =>
        candidate.type === "array" &&
        variants(candidate.items ?? {}).some(
          (item) => item.properties?.type?.const === "TextToken",
        ),
    ),
    "fields must expose documented rich-text token arrays",
  );
}

const connection = await createSTDIOClient({
  // Verify the npm runtime target explicitly. Running this script through Bun
  // must not leave a Bun child process holding dist files on Windows.
  command: process.platform === "win32" ? "node.exe" : "node",
  args: ["dist/stdio.js"],
  cwd: process.cwd(),
  stderr: "pipe",
});

try {
  const response = await connection.client.listTools();
  const tools = response.tools;
  const names = tools.map(({ name }) => name).sort();

  if (JSON.stringify(names) !== JSON.stringify(expectedTools)) {
    throw new Error(
      `Unexpected MCP tool surface.\nExpected: ${expectedTools.join(", ")}\nActual: ${names.join(", ")}`,
    );
  }

  for (const tool of tools) {
    if (!tool.description || !tool.inputSchema) {
      throw new Error(
        `Tool ${tool.name} is missing a description or input schema.`,
      );
    }
    verifyOutputEnvelope(
      tool.name,
      tool.outputSchema as JsonSchema | undefined,
    );
  }

  const createObject = tools.find(({ name }) => name === "create_object");
  expect(createObject, "create_object tool is missing");
  verifyStructuralSchema(createObject.inputSchema as JsonSchema);

  const search = tools.find(({ name }) => name === "search_objects");
  expect(
    search?.description?.toLowerCase().includes("title-only"),
    "search_objects must clearly disclose title-only search",
  );
  const searchLimit = (search?.inputSchema as JsonSchema | undefined)
    ?.properties?.limit;
  expect(
    searchLimit?.minimum === 1 && searchLimit.maximum === 50,
    "search_objects.limit must expose the 1-50 range",
  );
  expect(
    searchLimit?.description?.includes("1 to 50") ||
      searchLimit?.description?.includes("1–50"),
    "search_objects.limit description must disclose the maximum of 50",
  );

  const createFromUrl = tools.find(
    ({ name }) => name === "create_object_from_url",
  );
  const sourceUrl = (createFromUrl?.inputSchema as JsonSchema | undefined)
    ?.properties?.url;
  expect(
    sourceUrl?.pattern?.includes("https?"),
    "create_object_from_url.url must be schema-constrained to HTTP(S)",
  );

  const upload = tools.find(({ name }) => name === "upload_files");
  expect(upload, "upload_files tool is missing");
  const uploadSchema = upload.inputSchema as JsonSchema;
  expect(
    uploadSchema.properties?.files?.type === "array" &&
      uploadSchema.properties.files.minItems === 1 &&
      uploadSchema.properties.files.maxItems === 100,
    "upload_files.files must expose the 1-100 range",
  );
  expect(
    uploadSchema.properties?.mode?.enum?.includes("background"),
    "upload_files.mode must expose background mode",
  );

  const manage = tools.find(({ name }) => name === "manage_upload_job");
  expect(manage, "manage_upload_job tool is missing");
  const manageSchema = manage.inputSchema as JsonSchema;
  expect(
    manageSchema.properties?.action?.enum?.join(",") === "status,wait,cancel",
    "manage_upload_job.action must expose status, wait, and cancel",
  );

  console.log(
    `Verified ${tools.length} MCP tools and strict generated structural schemas: ${names.join(", ")}`,
  );
} finally {
  await disconnectSTDIOClient(connection);
}
