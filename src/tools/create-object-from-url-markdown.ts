import type { InferSchema, ToolMetadata } from "xmcp";
import { getClient, runTool } from "../lib/client";
import { authSchema, markdownBodySchema } from "../lib/schemas";
import {
  createUrlProperties,
  sourceDescriptionSchema,
  sourceTitleSchema,
  sourceUrlSchema,
} from "../lib/url";

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
    "Explicitly create a Capacities web-resource object from a URL and Markdown notes. Use create_object_from_url for the preferred structural-block workflow.",
  annotations: {
    title: "Create Capacities URL object from Markdown",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
};

export default async function createObjectFromUrlMarkdown({
  url,
  title,
  description,
  markdown,
  apiToken,
}: InferSchema<typeof schema>) {
  return runTool(async () => {
    const client = getClient(apiToken);
    const object = await client.object.createFromUrl({
      url,
      markdown,
      properties: createUrlProperties(title, description),
    });

    return { status: "created", object };
  });
}
