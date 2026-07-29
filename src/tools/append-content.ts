import type { InferSchema, ToolMetadata } from "xmcp";
import { z } from "zod";
import { resolveAppendPropertyId } from "../lib/blocks";
import { getClient, runTool } from "../lib/client";
import {
  authSchema,
  objectIdSchema,
  writableBlocksSchema,
} from "../lib/schemas";

function getInsertPosition(
  position: "end" | "start" | "after_block",
  afterBlockId?: string,
) {
  if (position === "after_block") {
    if (!afterBlockId) {
      throw new Error("afterBlockId is required when position is after_block.");
    }
    return { type: "after_block" as const, after_block: { id: afterBlockId } };
  }

  return { type: position };
}

export const schema = {
  id: objectIdSchema,
  blocks: writableBlocksSchema,
  position: z
    .enum(["end", "start", "after_block"])
    .optional()
    .default("end")
    .describe("Where to insert content."),
  afterBlockId: z
    .string()
    .uuid()
    .optional()
    .describe("Required only when position is after_block."),
  parentBlockId: z
    .string()
    .uuid()
    .optional()
    .describe(
      "Optional parent block for nested start/end insertion. Cannot be used with after_block.",
    ),
  propertyId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Optional block-property ID. Omit to use the structure's main content field.",
    ),
  ...authSchema,
};

export const metadata: ToolMetadata = {
  name: "append_content",
  description:
    "Append structural API 2.0 blocks to an existing object, optionally at the start, after a known block, inside a parent block, or in a specific block property.",
  annotations: {
    title: "Append Capacities content",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
};

export default async function appendContent({
  id,
  blocks,
  position,
  afterBlockId,
  parentBlockId,
  propertyId,
  apiToken,
}: InferSchema<typeof schema>) {
  return runTool(async () => {
    if (position === "after_block" && !afterBlockId) {
      throw new Error("afterBlockId is required when position is after_block.");
    }
    if (position !== "after_block" && afterBlockId) {
      throw new Error(
        "afterBlockId can only be used when position is after_block.",
      );
    }
    if (position === "after_block" && parentBlockId) {
      throw new Error(
        "parentBlockId cannot be combined with position after_block.",
      );
    }

    const client = getClient(apiToken);
    const resolvedPropertyId =
      parentBlockId || afterBlockId
        ? resolveAppendPropertyId(await client.object.get({ id }), {
            propertyId,
            parentBlockId,
            afterBlockId,
          })
        : propertyId;
    const object = await client.blocks.append({
      id,
      blocks,
      propertyId: resolvedPropertyId,
      parentBlockId,
      position: getInsertPosition(position, afterBlockId),
    });

    return { status: "appended", object };
  });
}
