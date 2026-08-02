import type { InferSchema, ToolMetadata } from "xmcp";
import { z } from "zod";
import { apiCall, getClient, runTool } from "../lib/client";
import { canonicalDailyDate } from "../lib/properties";
import { asynchronousVerification } from "../lib/readback";
import { authSchema, writableBlocksSchema } from "../lib/schemas";

export { dailyNoteOutputSchema as outputSchema } from "../lib/tool-output-schemas";

export const schema = {
  blocks: writableBlocksSchema,
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe(
      "Daily-note date as YYYY-MM-DD. Omit to use the API's current UTC day.",
    ),
  noTimestamp: z
    .boolean()
    .optional()
    .describe("True omits Capacities' automatic timestamp heading."),
  ...authSchema,
};

export const metadata: ToolMetadata = {
  name: "append_daily_note",
  description:
    "Append structural API 2.0 blocks to today's or a specified Capacities daily note. The Capacities API queues this write asynchronously, so success means accepted/queued rather than immediately readable.",
  annotations: {
    title: "Append Capacities daily note",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
};

export default async function appendDailyNote(
  { blocks, date, noTimestamp, apiToken }: InferSchema<typeof schema>,
  extra?: { signal?: AbortSignal },
) {
  return runTool(async () => {
    const client = getClient(apiToken);
    const canonicalDate = date ? canonicalDailyDate(date) : undefined;
    await apiCall(
      () =>
        client.blocks.dailyNote.append({
          blocks,
          date: canonicalDate,
          noTimeStamp: noTimestamp,
        }),
      { signal: extra?.signal, stage: "daily_note_enqueue" },
    );

    return {
      status: "queued",
      date: canonicalDate ?? "today_utc",
      noTimestamp: noTimestamp ?? false,
      verification: asynchronousVerification(),
    };
  });
}
