import type { InferSchema, ToolMetadata } from "xmcp";
import { z } from "zod";
import { childBlocks, findBlock, requireBlock } from "../lib/blocks";
import { getClient, runTool } from "../lib/client";
import {
  authSchema,
  objectIdSchema,
  writableBlockSchema,
} from "../lib/schemas";

export const schema = {
  id: objectIdSchema,
  blockId: z.string().uuid().describe("UUID of the existing block to replace."),
  propertyId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Optional block-property ID when the target block belongs to a non-main content property.",
    ),
  block: writableBlockSchema.describe(
    "Replacement content for the target block. Its type must match. For TextBlock/GroupBlock/GridBlock, omit blocks/columns to preserve existing children; include them to replace the child list.",
  ),
  ...authSchema,
};

export const metadata: ToolMetadata = {
  name: "update_block",
  description:
    "Update one existing Capacities block in place using strict structural API 2.0 JSON. Read get_object in structured mode first. The type must match; omitted blocks/columns preserve children, while supplied children replace them.",
  annotations: {
    title: "Update Capacities block",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

export default async function updateBlock({
  id,
  blockId,
  propertyId,
  block,
  apiToken,
}: InferSchema<typeof schema>) {
  return runTool(async () => {
    const client = getClient(apiToken);
    const before = await client.object.get({ id });
    const located = requireBlock(before, blockId, propertyId);
    if (located.block.type !== block.type) {
      throw new Error(
        `Block type mismatch: existing block is ${located.block.type}, replacement is ${block.type}. Capacities requires the type to remain unchanged.`,
      );
    }

    const childrenWereSupplied =
      block.type === "TextBlock" || block.type === "GroupBlock"
        ? block.blocks !== undefined
        : block.type === "GridBlock"
          ? block.columns !== undefined
          : undefined;
    const previousChildIds = childBlocks(located.block).map(({ id }) => id);

    const object = await client.blocks.block.update({
      id,
      blockId,
      propertyId: located.propertyId,
      block,
    });

    const persisted = findBlock(object, blockId, located.propertyId);
    if (!persisted || persisted.block.type !== block.type) {
      throw new Error(
        "Capacities returned from update_block without the requested block persisted.",
      );
    }
    const persistedChildIds = childBlocks(persisted.block).map(({ id }) => id);
    if (
      childrenWereSupplied === false &&
      JSON.stringify(persistedChildIds) !== JSON.stringify(previousChildIds)
    ) {
      throw new Error(
        "Capacities returned from update_block but omitted children were not preserved.",
      );
    }

    return {
      status: "updated",
      object,
      verification: {
        blockId,
        propertyId: located.propertyId,
        type: persisted.block.type,
        childBehavior:
          childrenWereSupplied === undefined
            ? "not_applicable"
            : childrenWereSupplied
              ? "replaced"
              : "preserved",
      },
    };
  });
}
