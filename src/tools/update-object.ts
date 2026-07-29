import type { InferSchema, ToolMetadata } from "xmcp";
import { z } from "zod";
import { getClient, getStructures, runTool } from "../lib/client";
import { normalizePropertyFields, resolveStructure } from "../lib/properties";
import { authSchema, fieldsSchema, objectIdSchema } from "../lib/schemas";

export const schema = {
  id: objectIdSchema,
  title: z
    .string()
    .min(1)
    .max(3000)
    .refine((value) => !/[\r\n]/.test(value), "Title must be one line.")
    .optional()
    .describe("Optional replacement title."),
  fields: fieldsSchema,
  collections: z
    .array(z.string().uuid())
    .optional()
    .describe(
      "Optional replacement collection UUID list. Pass [] for the default collection.",
    ),
  ...authSchema,
};

export const metadata: ToolMetadata = {
  name: "update_object",
  description:
    "Update an object's title, writable typed properties, or collections after loading its live structure schema. Supplied fields replace that property; omitted fields stay unchanged. Use append_content or update_block for body content.",
  annotations: {
    title: "Update Capacities object",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

export default async function updateObject({
  id,
  title,
  fields,
  collections,
  apiToken,
}: InferSchema<typeof schema>) {
  return runTool(async () => {
    if (
      title === undefined &&
      fields === undefined &&
      collections === undefined
    ) {
      throw new Error(
        "Provide at least one of title, fields, or collections to update.",
      );
    }

    const client = getClient(apiToken);
    const [object, structures] = await Promise.all([
      client.object.get({ id }),
      getStructures(client),
    ]);
    const structure = resolveStructure(structures, object.structureId);
    const properties =
      fields !== undefined || title !== undefined
        ? {
            ...(fields ? normalizePropertyFields(structure, fields) : {}),
            ...(title !== undefined
              ? normalizePropertyFields(structure, { title })
              : {}),
          }
        : undefined;
    const updated = await client.object.update({
      id,
      properties,
      collections,
    });

    return { status: "updated", object: updated };
  });
}
