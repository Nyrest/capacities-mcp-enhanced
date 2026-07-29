import type { InferSchema, ToolMetadata } from "xmcp";
import { z } from "zod";
import { getClient, runTool } from "../lib/client";
import { authSchema, objectIdSchema } from "../lib/schemas";

export const schema = {
  id: objectIdSchema,
  permanent: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "False moves the object to trash. True permanently deletes it and cannot be undone.",
    ),
  ...authSchema,
};

export const metadata: ToolMetadata = {
  name: "delete_object",
  description:
    "Delete a Capacities object. The safe default moves it to trash; permanent deletion requires permanent=true.",
  annotations: {
    title: "Delete Capacities object",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
};

export default async function deleteObject({
  id,
  permanent,
  apiToken,
}: InferSchema<typeof schema>) {
  return runTool(async () => {
    const client = getClient(apiToken);
    await client.object.delete({ id, hardDelete: permanent });

    return {
      status: permanent ? "permanently_deleted" : "moved_to_trash",
      id,
    };
  });
}
