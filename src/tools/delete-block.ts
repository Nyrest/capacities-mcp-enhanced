import type { InferSchema, ToolMetadata } from "xmcp";
import { z } from "zod";
import { findBlock, requireBlock } from "../lib/blocks";
import { getClient, runTool } from "../lib/client";
import { authSchema, objectIdSchema } from "../lib/schemas";

export const schema = {
  id: objectIdSchema,
  blockId: z.string().uuid().describe("UUID of the block to delete."),
  ...authSchema,
};

export const metadata: ToolMetadata = {
  name: "delete_block",
  description:
    "Delete one existing Capacities block by object ID and block ID. Nested child blocks are deleted with their parent; read structured content first and use only when the deletion is intentional.",
  annotations: {
    title: "Delete Capacities block",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
};

export default async function deleteBlock({
  id,
  blockId,
  apiToken,
}: InferSchema<typeof schema>) {
  return runTool(async () => {
    const client = getClient(apiToken);
    const before = await client.object.get({ id });
    const located = requireBlock(before, blockId);
    const object = await client.blocks.block.delete({
      objectId: id,
      blockId,
    });
    if (findBlock(object, blockId)) {
      throw new Error(
        "Capacities returned from delete_block but the target block is still present.",
      );
    }

    return {
      status: "deleted",
      object,
      verification: { blockId, propertyId: located.propertyId, absent: true },
    };
  });
}
