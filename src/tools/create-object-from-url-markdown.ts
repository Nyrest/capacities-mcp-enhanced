import type { InferSchema, ToolMetadata } from "xmcp";
import { apiCall, getClient, runTool } from "../lib/client";
import { createMarkdownLossReport } from "../lib/markdown";
import {
  convertMarkdownEntityMarkers,
  prepareMarkdownForTool,
} from "../lib/markdown-entities";
import { checkObjectState, readbackObject } from "../lib/readback";
import { authSchema, markdownBodySchema } from "../lib/schemas";
import {
  createUrlProperties,
  sourceDescriptionSchema,
  sourceTitleSchema,
  sourceUrlSchema,
} from "../lib/url";

export { toolOutputSchema as outputSchema } from "../lib/schemas";

export const schema = {
  url: sourceUrlSchema,
  title: sourceTitleSchema,
  description: sourceDescriptionSchema,
  markdown: markdownBodySchema,
  ...authSchema,
};

export const metadata: ToolMetadata = {
  name: "create_object_from_url_markdown",
  description:
    "Explicitly create a Capacities web-resource object from a URL and Markdown notes. Use create_object_from_url for the preferred structural-block workflow; conversion is lossy for exact underline styling, toggle details, Grid layout, and HTML background colors, so inspect lossReport.",
  annotations: {
    title: "Create Capacities URL object from Markdown",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
};

export default async function createObjectFromUrlMarkdown(
  { url, title, description, markdown, apiToken }: InferSchema<typeof schema>,
  extra?: { signal?: AbortSignal },
) {
  return runTool(async () => {
    const client = getClient(apiToken);
    const properties = createUrlProperties(title, description);
    const prepared = await prepareMarkdownForTool(
      client,
      markdown,
      extra?.signal,
    );
    const object = await apiCall(
      () =>
        client.object.createFromUrl({
          url,
          markdown: prepared.markdown,
          properties,
        }),
      { signal: extra?.signal, stage: "mutation" },
    );
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
    const readback = await readbackObject({
      client,
      id: object.id,
      fallback: converted,
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
      lossReport: createMarkdownLossReport(
        markdown,
        readback.verification.snapshotSource === "server_readback"
          ? readback.object
          : undefined,
        undefined,
        prepared.entityLinks,
      ),
    };
  });
}
