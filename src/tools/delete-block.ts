import type { InferSchema, ToolMetadata } from "xmcp";
import { z } from "zod";
import { requireBlock } from "../lib/blocks";
import {
  apiCall,
  getClient,
  runTool,
  withObjectMutationLock,
} from "../lib/client";
import { checkObjectState, readbackObject } from "../lib/readback";
import { authSchema, objectIdSchema } from "../lib/schemas";

export { toolOutputSchema as outputSchema } from "../lib/schemas";

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

export default async function deleteBlock(
  { id, blockId, apiToken }: InferSchema<typeof schema>,
  extra?: { signal?: AbortSignal },
) {
  return runTool(() =>
    withObjectMutationLock(id, async () => {
      const client = getClient(apiToken);
      const before = await apiCall(() => client.object.get({ id }), {
        signal: extra?.signal,
        stage: "precondition_read",
      });
      const located = requireBlock(before, blockId);
      const object = await apiCall(
        () =>
          client.blocks.block.delete({
            objectId: id,
            blockId,
          }),
        { signal: extra?.signal, stage: "mutation" },
      );
      const readback = await readbackObject({
        client,
        id,
        fallback: object,
        signal: extra?.signal,
        check: checkObjectState({
          id,
          structureId: before.structureId,
          absentBlockIds: [blockId],
        }),
      });

      return {
        status: "deleted",
        object: readback.object,
        verification: {
          ...readback.verification,
          blockId,
          propertyId: located.propertyId,
          absent: readback.verification.readbackVerified,
        },
      };
    }),
  );
}
