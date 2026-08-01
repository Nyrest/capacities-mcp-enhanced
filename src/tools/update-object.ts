import type { InferSchema, ToolMetadata } from "xmcp";
import { z } from "zod";
import {
  apiCall,
  getClient,
  getStructures,
  runTool,
  withObjectMutationLock,
} from "../lib/client";
import { normalizePropertyFields, resolveStructure } from "../lib/properties";
import { checkObjectState, readbackObject } from "../lib/readback";
import { authSchema, fieldsSchema, objectIdSchema } from "../lib/schemas";

export { toolOutputSchema as outputSchema } from "../lib/schemas";

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

export default async function updateObject(
  { id, title, fields, collections, apiToken }: InferSchema<typeof schema>,
  extra?: { signal?: AbortSignal },
) {
  return runTool(() =>
    withObjectMutationLock(id, async () => {
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
        apiCall(() => client.object.get({ id }), {
          signal: extra?.signal,
          stage: "precondition_read",
        }),
        getStructures(client, false, extra?.signal),
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
      const updated = await apiCall(
        () =>
          client.object.update({
            id,
            properties,
            collections,
          }),
        { signal: extra?.signal, stage: "mutation" },
      );
      const readback = await readbackObject({
        client,
        id,
        fallback: updated,
        signal: extra?.signal,
        check: checkObjectState({
          id,
          structureId: object.structureId,
          properties,
          collections,
        }),
      });

      return {
        status: "updated",
        object: readback.object,
        verification: readback.verification,
      };
    }),
  );
}
