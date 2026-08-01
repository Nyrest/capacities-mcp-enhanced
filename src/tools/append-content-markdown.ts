import type { InferSchema, ToolMetadata } from "xmcp";
import { z } from "zod";
import { resolveAppendPropertyId } from "../lib/blocks";
import {
  apiCall,
  getClient,
  runTool,
  withObjectMutationLock,
} from "../lib/client";
import { createMarkdownLossReport } from "../lib/markdown";
import {
  convertMarkdownEntityMarkers,
  prepareMarkdownForTool,
} from "../lib/markdown-entities";
import { allBlockIds, checkObjectState, readbackObject } from "../lib/readback";
import { authSchema, markdownBodySchema, objectIdSchema } from "../lib/schemas";

export { toolOutputSchema as outputSchema } from "../lib/schemas";

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
  markdown: markdownBodySchema,
  position: z
    .enum(["end", "start", "after_block"])
    .optional()
    .default("end")
    .describe("Where to insert the Markdown."),
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
  name: "append_content_markdown",
  description:
    "Explicitly append Markdown to an existing object. Use append_content for the preferred structural JSON-block workflow. Markdown conversion is lossy for exact underline styling, toggle details, Grid layout, and HTML background colors; inspect lossReport.",
  annotations: {
    title: "Append Markdown to Capacities object",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
};

export default async function appendContentMarkdown(
  {
    id,
    markdown,
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
      const prepared = await prepareMarkdownForTool(
        client,
        markdown,
        extra?.signal,
      );
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
            markdown: prepared.markdown,
            propertyId: resolvedPropertyId,
            parentBlockId,
            position: getInsertPosition(position, afterBlockId),
          }),
        { signal: extra?.signal, stage: "mutation" },
      );
      const converted =
        prepared.entities.length === 0
          ? object
          : await convertMarkdownEntityMarkers({
              client,
              objectId: id,
              object,
              entities: prepared.entities,
              entityLinks: prepared.entityLinks,
              signal: extra?.signal,
            });
      const beforeIds = new Set(allBlockIds(before));
      const appendedIds = allBlockIds(converted).filter(
        (blockId) => !beforeIds.has(blockId),
      );
      const baseCheck = checkObjectState({
        id,
        structureId: before.structureId,
        presentBlockIds: appendedIds,
      });
      const readback = await readbackObject({
        client,
        id,
        fallback: converted,
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
        lossReport: createMarkdownLossReport(
          markdown,
          readback.verification.snapshotSource === "server_readback"
            ? readback.object
            : undefined,
          appendedIds,
          prepared.entityLinks,
        ),
      };
    }),
  );
}
