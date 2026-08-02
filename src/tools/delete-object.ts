import type { InferSchema, ToolMetadata } from "xmcp";
import { z } from "zod";
import {
  apiCall,
  getClient,
  runTool,
  withObjectMutationLock,
} from "../lib/client";
import { readbackDeletedObject } from "../lib/readback";
import { authSchema, objectIdSchema } from "../lib/schemas";

export { deleteObjectOutputSchema as outputSchema } from "../lib/tool-output-schemas";

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

export default async function deleteObject(
  { id, permanent, apiToken }: InferSchema<typeof schema>,
  extra?: { signal?: AbortSignal },
) {
  return runTool(() =>
    withObjectMutationLock(id, async () => {
      const client = getClient(apiToken);
      await apiCall(() => client.object.delete({ id, hardDelete: permanent }), {
        signal: extra?.signal,
        stage: "mutation",
      });
      const verification = await readbackDeletedObject(
        client,
        id,
        extra?.signal,
      );

      return {
        status: permanent ? "permanently_deleted" : "moved_to_trash",
        id,
        verification,
      };
    }),
  );
}
