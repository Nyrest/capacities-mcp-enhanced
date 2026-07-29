import type { InferSchema, ToolMetadata } from "xmcp";
import { formatError, getClient, toolResult } from "../lib/client";
import { authSchema, writableBlocksSchema } from "../lib/schemas";
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
  blocks: writableBlocksSchema.optional(),
  ...authSchema,
};

export const metadata: ToolMetadata = {
  name: "create_object_from_url",
  description:
    "Create a Capacities web-resource object from a URL, optionally adding structural API 2.0 blocks. This is the preferred URL-import tool; use create_object_from_url_markdown only when Markdown authoring is specifically requested.",
  annotations: {
    title: "Create Capacities object from URL",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
};

export default async function createObjectFromUrl({
  url,
  title,
  description,
  blocks,
  apiToken,
}: InferSchema<typeof schema>) {
  const operation = async () => {
    const client = getClient(apiToken);
    const object = await client.object.createFromUrl({
      url,
      properties: createUrlProperties(title, description),
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
          "The URL object was created, but its structural blocks could not be appended.",
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
