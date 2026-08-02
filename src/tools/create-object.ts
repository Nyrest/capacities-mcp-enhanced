import type { InferSchema, ToolMetadata } from "xmcp";
import { z } from "zod";
import {
  apiCall,
  getClient,
  getStructures,
  McpToolError,
  normalizeError,
  runTool,
} from "../lib/client";
import {
  assertStandardObjectCreateSupported,
  normalizePropertyFields,
  resolveStructure,
} from "../lib/properties";
import { allBlockIds, checkObjectState, readbackObject } from "../lib/readback";
import {
  authSchema,
  fieldsSchema,
  objectTitleSchema,
  structureSchema,
  writableBlocksSchema,
} from "../lib/schemas";

export { objectMutationOutputSchema as outputSchema } from "../lib/tool-output-schemas";

export const schema = {
  structure: structureSchema,
  title: objectTitleSchema,
  blocks: writableBlocksSchema.optional(),
  fields: fieldsSchema,
  collections: z
    .array(z.string().uuid())
    .optional()
    .describe(
      "Optional collection UUIDs. Pass [] to use the structure's default collection.",
    ),
  ...authSchema,
};

export const metadata: ToolMetadata = {
  name: "create_object",
  description:
    "Preferred structural creator for Page, Tag, Task, or custom structures. It loads the live structure, rejects unsupported types and invalid properties, resolves label names, and accepts only strict documented API 2.0 blocks. Use create_object_from_url for weblinks.",
  annotations: {
    title: "Create Capacities object",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
};

export default async function createObject(
  {
    structure: structureIdentifier,
    title,
    blocks,
    fields,
    collections,
    apiToken,
  }: InferSchema<typeof schema>,
  extra?: { signal?: AbortSignal },
) {
  return runTool(async () => {
    const client = getClient(apiToken);
    const structures = await getStructures(client, false, extra?.signal);
    const structure = resolveStructure(structures, structureIdentifier);
    assertStandardObjectCreateSupported(structure);
    const properties = {
      ...(fields ? normalizePropertyFields(structure, fields) : {}),
      ...normalizePropertyFields(structure, { title }),
    };

    const object = await apiCall(
      () =>
        client.object.create({
          structureId: structure.id,
          properties,
          collections,
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
          structureId: structure.id,
          properties,
          collections,
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
          structureId: structure.id,
          properties,
          collections,
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
        "The object and its structural properties were created, but the structural blocks could not be appended.",
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
