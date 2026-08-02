import type { InferSchema, ToolMetadata } from "xmcp";
import { z } from "zod";
import { apiCall, getClient, getStructures, runTool } from "../lib/client";
import { resolveStructure } from "../lib/properties";
import { authSchema, structureSchema } from "../lib/schemas";

export { searchObjectsOutputSchema as outputSchema } from "../lib/tool-output-schemas";

export const schema = {
  query: z
    .string()
    .min(1)
    .max(512)
    .describe("Text to match against object titles."),
  structures: z
    .array(structureSchema)
    .min(1)
    .max(25)
    .optional()
    .describe("Optional structure IDs or names to search within."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .default(20)
    .describe("Maximum results: integer from 1 to 50. Default: 20."),
  ...authSchema,
};

export const metadata: ToolMetadata = {
  name: "search_objects",
  description:
    "TITLE-ONLY search for Capacities objects, optionally filtered by discovered structure names or IDs. It never searches body blocks or property values. Returns IDs and titles for get_object or relation fields.",
  annotations: {
    title: "Search Capacities objects",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

export default async function searchObjects(
  {
    query,
    structures: requestedStructures,
    limit,
    apiToken,
  }: InferSchema<typeof schema>,
  extra?: { signal?: AbortSignal },
) {
  return runTool(async () => {
    const client = getClient(apiToken);
    const structures = await getStructures(client, false, extra?.signal);
    const structureIds = requestedStructures?.map(
      (identifier) => resolveStructure(structures, identifier).id,
    );
    const response = await apiCall(
      () =>
        client.objects.search({
          query,
          structureIds,
          limit,
        }),
      { signal: extra?.signal, stage: "discovery" },
    );
    const titlesById = new Map(structures.map(({ id, title }) => [id, title]));

    return {
      query,
      count: response.results.length,
      results: response.results.map((result) => ({
        ...result,
        structureTitle: titlesById.get(result.structureId),
      })),
    };
  });
}
