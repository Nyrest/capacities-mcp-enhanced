import type { InferSchema, ToolMetadata } from "xmcp";
import { z } from "zod";
import { getClient, getStructures, runTool } from "../lib/client";
import {
  createAgentWriteGuide,
  resolveStructure,
  structureCreateTool,
} from "../lib/properties";
import { authSchema } from "../lib/schemas";

export const schema = {
  structure: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Optional structure ID or name. When supplied, returns its complete writable property and collection schema.",
    ),
  refresh: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "Refresh cached structure definitions after space settings changed.",
    ),
  ...authSchema,
};

export const metadata: ToolMetadata = {
  name: "inspect_space",
  description:
    "Inspect the token-bound Capacities space. Without a structure, returns a compact object-type catalog; with a structure ID/name, returns its property definitions, label options, allowed relation types, and collections. Call this before unfamiliar create/update operations.",
  annotations: {
    title: "Inspect Capacities space",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

export default async function inspectSpace({
  structure,
  refresh,
  apiToken,
}: InferSchema<typeof schema>) {
  return runTool(async () => {
    const client = getClient(apiToken);
    const [space, structures] = await Promise.all([
      client.space.get(),
      getStructures(client, refresh),
    ]);

    if (structure) {
      const resolved = resolveStructure(structures, structure);
      return {
        space,
        structure: resolved,
        writeGuide: createAgentWriteGuide(resolved),
      };
    }

    return {
      space,
      structures: structures.map((structure) => {
        const {
          id,
          title,
          pluralName,
          labelColor,
          collections,
          propertyDefinitions,
        } = structure;
        return {
          id,
          title,
          pluralName,
          labelColor,
          collections,
          propertyCount: propertyDefinitions.length,
          writablePropertyCount: propertyDefinitions.filter(
            ({ writable }) => writable,
          ).length,
          createTool: structureCreateTool(structure),
        };
      }),
    };
  });
}
