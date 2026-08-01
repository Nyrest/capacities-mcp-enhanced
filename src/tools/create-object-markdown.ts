import type { InferSchema, ToolMetadata } from "xmcp";
import { z } from "zod";
import {
  apiCall,
  getClient,
  getStructures,
  normalizeError,
  runTool,
} from "../lib/client";
import { createMarkdownLossReport } from "../lib/markdown";
import {
  convertMarkdownEntityMarkers,
  prepareMarkdownForTool,
} from "../lib/markdown-entities";
import {
  assertStandardObjectCreateSupported,
  normalizePropertyFields,
  resolveStructure,
} from "../lib/properties";
import {
  checkObjectState,
  readbackDeletedObject,
  readbackObject,
} from "../lib/readback";
import {
  authSchema,
  fieldsSchema,
  markdownBodySchema,
  objectTitleSchema,
  structureSchema,
} from "../lib/schemas";
import { rollbackMarkdownCreate } from "../lib/transactions";

export { toolOutputSchema as outputSchema } from "../lib/schemas";

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
    "Explicitly create a Capacities object from a Markdown body. Use create_object for the preferred structural JSON-block workflow; Markdown conversion is lossy for exact underline styling, toggle details, Grid layout, and HTML background colors, so inspect lossReport.",
  annotations: {
    title: "Create Capacities object from Markdown",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
};

export default async function createObjectMarkdown(
  {
    structure: structureIdentifier,
    title,
    markdown,
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
    const prepared = await prepareMarkdownForTool(
      client,
      markdown,
      extra?.signal,
    );
    const object = await apiCall(
      () =>
        client.object.markdown.create({
          structureId: structure.id,
          markdown: `# ${title}\n\n${prepared.markdown}`,
        }),
      { signal: extra?.signal, stage: "mutation" },
    );

    try {
      const converted =
        prepared.entities.length === 0
          ? object
          : await convertMarkdownEntityMarkers({
              client,
              objectId: object.id,
              object,
              entities: prepared.entities,
              entityLinks: prepared.entityLinks,
              signal: extra?.signal,
            });

      if (!fields && collections === undefined) {
        const readback = await readbackObject({
          client,
          id: object.id,
          fallback: converted,
          signal: extra?.signal,
          check: checkObjectState({
            id: object.id,
            structureId: structure.id,
            properties,
          }),
        });
        return {
          status: "created",
          object: readback.object,
          verification: readback.verification,
          lossReport: createMarkdownLossReport(
            markdown,
            readback.verification.snapshotSource === "server_readback"
              ? readback.object
              : undefined,
            undefined,
            prepared.entityLinks,
          ),
        };
      }

      const updated = await apiCall(
        () =>
          client.object.update({
            id: object.id,
            properties,
            collections,
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
        }),
      });
      return {
        status: "created",
        object: readback.object,
        verification: readback.verification,
        lossReport: createMarkdownLossReport(
          markdown,
          readback.verification.snapshotSource === "server_readback"
            ? readback.object
            : undefined,
          undefined,
          prepared.entityLinks,
        ),
      };
    } catch (patchError) {
      const cause = normalizeError(patchError);
      return rollbackMarkdownCreate({
        objectId: object.id,
        cause,
        deleteObject: () =>
          apiCall(
            () => client.object.delete({ id: object.id, hardDelete: true }),
            { signal: extra?.signal, stage: "rollback_delete" },
          ),
        verifyDeleted: () =>
          readbackDeletedObject(
            client,
            object.id,
            extra?.signal,
            true,
            "rollback_readback",
          ),
      });
    }
  });
}
