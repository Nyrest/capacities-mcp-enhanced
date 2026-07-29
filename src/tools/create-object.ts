import type { InferSchema, ToolMetadata } from "xmcp";
import { z } from "zod";
import {
  formatError,
  getClient,
  getStructures,
  toolResult,
} from "../lib/client";
import {
  assertStandardObjectCreateSupported,
  normalizePropertyFields,
  resolveStructure,
} from "../lib/properties";
import {
  authSchema,
  fieldsSchema,
  objectTitleSchema,
  structureSchema,
  writableBlocksSchema,
} from "../lib/schemas";

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

export default async function createObject({
  structure: structureIdentifier,
  title,
  blocks,
  fields,
  collections,
  apiToken,
}: InferSchema<typeof schema>) {
  const operation = async () => {
    const client = getClient(apiToken);
    const structures = await getStructures(client);
    const structure = resolveStructure(structures, structureIdentifier);
    assertStandardObjectCreateSupported(structure);
    const properties = {
      ...(fields ? normalizePropertyFields(structure, fields) : {}),
      ...normalizePropertyFields(structure, { title }),
    };

    const object = await client.object.create({
      structureId: structure.id,
      properties,
      collections,
    });

    if (!blocks) {
      return toolResult({ status: "created", object });
    }

    try {
      const updated = await client.blocks.append({
        id: object.id,
        blocks,
      });
      return toolResult({ status: "created", object: updated });
    } catch (error) {
      return toolResult({
        status: "partial",
        object,
        warning:
          "The object and its structural properties were created, but the structural blocks could not be appended.",
        error: formatError(error),
      });
    }
  };

  try {
    return await operation();
  } catch (error) {
    throw new Error(formatError(error));
  }
}
