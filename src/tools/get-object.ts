import type { InferSchema, ToolMetadata } from "xmcp";
import { z } from "zod";
import { getClient, runTool } from "../lib/client";
import { authSchema, objectIdSchema } from "../lib/schemas";

export const schema = {
  id: objectIdSchema,
  format: z
    .enum(["markdown", "structured"])
    .optional()
    .default("structured")
    .describe(
      "structured is the default and returns properties, collections, block IDs, files, and exact block trees. markdown is a read-only proposal/context view; never use it to plan an edit payload.",
    ),
  ...authSchema,
};

export const metadata: ToolMetadata = {
  name: "get_object",
  description:
    "Read one Capacities object by UUID. Structured JSON is the default and is safe to feed into follow-up edits; request markdown only for a compact, read-only proposal or context view.",
  annotations: {
    title: "Read Capacities object",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

export default async function getObject({
  id,
  format,
  apiToken,
}: InferSchema<typeof schema>) {
  return runTool(async () => {
    const client = getClient(apiToken);
    const object =
      format === "structured"
        ? await client.object.get({ id })
        : await client.object.markdown.get({ id });

    return { format, object };
  });
}
