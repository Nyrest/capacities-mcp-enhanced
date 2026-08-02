import type { InferSchema, ToolMetadata } from "xmcp";
import {
  apiCall,
  getClient,
  McpToolError,
  normalizeError,
  runTool,
} from "../lib/client";
import { allBlockIds, checkObjectState, readbackObject } from "../lib/readback";
import { authSchema, writableBlocksSchema } from "../lib/schemas";
import {
  createUrlProperties,
  sourceDescriptionSchema,
  sourceTitleSchema,
  sourceUrlSchema,
} from "../lib/url";

export { objectMutationOutputSchema as outputSchema } from "../lib/tool-output-schemas";

export const schema = {
  url: sourceUrlSchema,
  title: sourceTitleSchema,
  description: sourceDescriptionSchema,
  blocks: writableBlocksSchema.optional(),
  ...authSchema,
};

export const metadata: ToolMetadata = {
  name: "create_object_from_url",
  description:
    "Create a Capacities web-resource object from a URL, optionally adding structural API 2.0 blocks. This is the preferred URL-import tool; use create_object_from_url_markdown only when Markdown authoring is specifically requested.",
  annotations: {
    title: "Create Capacities object from URL",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
};

export default async function createObjectFromUrl(
  { url, title, description, blocks, apiToken }: InferSchema<typeof schema>,
  extra?: { signal?: AbortSignal },
) {
  return runTool(async () => {
    const client = getClient(apiToken);
    const properties = createUrlProperties(title, description);
    const object = await apiCall(
      () =>
        client.object.createFromUrl({
          url,
          properties,
        }),
      { signal: extra?.signal, stage: "mutation" },
    );

    if (!blocks) {
      const readback = await readbackObject({
        client,
        id: object.id,
        fallback: object,
        signal: extra?.signal,
        check: checkObjectState({
          id: object.id,
          structureId: object.structureId,
          properties,
        }),
      });
      return {
        status: "created",
        object: readback.object,
        verification: readback.verification,
      };
    }

    try {
      const updated = await apiCall(
        () =>
          client.blocks.append({
            id: object.id,
            blocks,
          }),
        { signal: extra?.signal, stage: "mutation" },
      );
      const readback = await readbackObject({
        client,
        id: object.id,
        fallback: updated,
        signal: extra?.signal,
        check: checkObjectState({
          id: object.id,
          structureId: object.structureId,
          properties,
          presentBlockIds: allBlockIds(updated),
        }),
      });
      return {
        status: "created",
        object: readback.object,
        verification: readback.verification,
      };
    } catch (error) {
      throw new McpToolError(
        "mcp_partial_failure",
        "The URL object was created, but its structural blocks could not be appended.",
        {
          stage: "append_blocks",
          recoverableObjectId: object.id,
          cause: normalizeError(error),
          recovery:
            "Retry append_content for this object ID, or delete the object.",
        },
      );
    }
  });
}
