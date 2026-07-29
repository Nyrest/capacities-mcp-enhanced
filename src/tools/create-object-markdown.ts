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
  markdownBodySchema,
  objectTitleSchema,
  structureSchema,
} from "../lib/schemas";

export const schema = {
  structure: structureSchema,
  title: objectTitleSchema,
  markdown: markdownBodySchema,
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
  name: "create_object_markdown",
  description:
    "Explicitly create a Capacities object from a Markdown body. Use create_object for the preferred structural JSON-block workflow; choose this tool only when the user specifically wants Markdown conversion.",
  annotations: {
    title: "Create Capacities object from Markdown",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
};

export default async function createObjectMarkdown({
  structure: structureIdentifier,
  title,
  markdown,
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
    const object = await client.object.markdown.create({
      structureId: structure.id,
      markdown: `# ${title}\n\n${markdown}`,
    });

    if (!fields && collections === undefined) {
      return toolResult({ status: "created", object });
    }

    try {
      const updated = await client.object.update({
        id: object.id,
        properties,
        collections,
      });
      return toolResult({ status: "created", object: updated });
    } catch (error) {
      return toolResult({
        status: "partial",
        object,
        warning:
          "The Markdown object was created, but the additional typed properties or collections could not be applied.",
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
