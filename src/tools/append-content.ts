import type { InferSchema, ToolMetadata } from "xmcp";
import { z } from "zod";
import { resolveAppendPropertyId } from "../lib/blocks";
import {
  apiCall,
  getClient,
  runTool,
  withObjectMutationLock,
} from "../lib/client";
import { allBlockIds, checkObjectState, readbackObject } from "../lib/readback";
import {
  authSchema,
  objectIdSchema,
  writableBlocksSchema,
} from "../lib/schemas";

export { objectMutationOutputSchema as outputSchema } from "../lib/tool-output-schemas";

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

export default async function appendContent(
  {
    id,
    blocks,
    position,
    afterBlockId,
    parentBlockId,
    propertyId,
    apiToken,
  }: InferSchema<typeof schema>,
  extra?: { signal?: AbortSignal },
) {
  return runTool(() =>
    withObjectMutationLock(id, async () => {
      if (position === "after_block" && !afterBlockId) {
        throw new Error(
          "afterBlockId is required when position is after_block.",
        );
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
      const before = await apiCall(() => client.object.get({ id }), {
        signal: extra?.signal,
        stage: "precondition_read",
      });
      const resolvedPropertyId = resolveAppendPropertyId(before, {
        propertyId,
        parentBlockId,
        afterBlockId,
      });
      const object = await apiCall(
        () =>
          client.blocks.append({
            id,
            blocks,
            propertyId: resolvedPropertyId,
            parentBlockId,
            position: getInsertPosition(position, afterBlockId),
          }),
        { signal: extra?.signal, stage: "mutation" },
      );
      const beforeIds = new Set(allBlockIds(before));
      const appendedIds = allBlockIds(object).filter(
        (id) => !beforeIds.has(id),
      );
      const baseCheck = checkObjectState({
        id,
        structureId: before.structureId,
        presentBlockIds: appendedIds,
      });
      const readback = await readbackObject({
        client,
        id,
        fallback: object,
        signal: extra?.signal,
        check: (snapshot) => [
          ...(appendedIds.length === 0
            ? [
                {
                  code: "append_no_new_block" as const,
                  path: "/blocks",
                  message:
                    "Mutation response identified no newly appended block IDs.",
                },
              ]
            : []),
          ...baseCheck(snapshot),
        ],
      });

      return {
        status: "appended",
        object: readback.object,
        verification: readback.verification,
      };
    }),
  );
}
