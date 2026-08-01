import type { InferSchema, ToolMetadata } from "xmcp";
import { z } from "zod";
import { childBlocks, findBlock, requireBlock } from "../lib/blocks";
import {
  apiCall,
  getClient,
  runTool,
  withObjectMutationLock,
} from "../lib/client";
import {
  containsExpectedState,
  type ReadbackMismatch,
  readbackObject,
} from "../lib/readback";
import {
  authSchema,
  objectIdSchema,
  writableBlockSchema,
} from "../lib/schemas";

export { toolOutputSchema as outputSchema } from "../lib/schemas";

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

export default async function updateBlock(
  { id, blockId, propertyId, block, apiToken }: InferSchema<typeof schema>,
  extra?: { signal?: AbortSignal },
) {
  return runTool(() =>
    withObjectMutationLock(id, async () => {
      const client = getClient(apiToken);
      const before = await apiCall(() => client.object.get({ id }), {
        signal: extra?.signal,
        stage: "precondition_read",
      });
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

      const object = await apiCall(
        () =>
          client.blocks.block.update({
            id,
            blockId,
            propertyId: located.propertyId,
            block,
          }),
        { signal: extra?.signal, stage: "mutation" },
      );
      const mutationPersisted = findBlock(object, blockId, located.propertyId);
      const expectedChildIds =
        childrenWereSupplied === true && mutationPersisted
          ? childBlocks(mutationPersisted.block).map(({ id }) => id)
          : previousChildIds;
      const readback = await readbackObject({
        client,
        id,
        fallback: object,
        signal: extra?.signal,
        check: (snapshot) => {
          const persisted = findBlock(snapshot, blockId, located.propertyId);
          if (!persisted) {
            return [
              {
                code: "block_missing",
                path: `/blocks/${blockId}`,
                message: `Block ${blockId} was not present.`,
              },
            ];
          }
          const mismatches: ReadbackMismatch[] = [];
          if (persisted.block.type !== block.type) {
            mismatches.push({
              code: "block_type_mismatch",
              path: `/blocks/${blockId}/type`,
              message:
                "Expected " +
                block.type +
                ", received " +
                persisted.block.type +
                ".",
            });
          }
          if (!containsExpectedState(persisted.block, block)) {
            mismatches.push({
              code: "block_content_mismatch",
              path: `/blocks/${blockId}`,
              message: "Block content did not match the requested replacement.",
            });
          }
          if (childrenWereSupplied !== undefined) {
            const persistedChildIds = childBlocks(persisted.block).map(
              ({ id }) => id,
            );
            if (
              JSON.stringify(persistedChildIds) !==
              JSON.stringify(expectedChildIds)
            ) {
              mismatches.push({
                code: "child_ids_mismatch",
                path: `/blocks/${blockId}/children`,
                message:
                  "Child IDs did not match the expected " +
                  (childrenWereSupplied ? "replacement" : "preservation") +
                  ".",
              });
            }
          }
          return mismatches;
        },
      });

      return {
        status: "updated",
        object: readback.object,
        verification: {
          ...readback.verification,
          blockId,
          propertyId: located.propertyId,
          type: block.type,
          childBehavior:
            childrenWereSupplied === undefined
              ? "not_applicable"
              : childrenWereSupplied
                ? "replaced"
                : "preserved",
        },
      };
    }),
  );
}
