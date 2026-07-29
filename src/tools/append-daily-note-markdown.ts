import type { InferSchema, ToolMetadata } from "xmcp";
import { z } from "zod";
import { getClient, runTool } from "../lib/client";
import { canonicalDailyDate } from "../lib/properties";
import { authSchema, markdownBodySchema } from "../lib/schemas";

export const schema = {
  markdown: markdownBodySchema,
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
  name: "append_daily_note_markdown",
  description:
    "Explicitly append Markdown to a Capacities daily note. Use append_daily_note for the preferred structural JSON-block workflow; choose this tool only when Markdown insertion is specifically requested. The API queues this write asynchronously.",
  annotations: {
    title: "Append Markdown to Capacities daily note",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
};

export default async function appendDailyNoteMarkdown({
  markdown,
  date,
  noTimestamp,
  apiToken,
}: InferSchema<typeof schema>) {
  return runTool(async () => {
    const client = getClient(apiToken);
    const canonicalDate = date ? canonicalDailyDate(date) : undefined;
    await client.blocks.dailyNote.append({
      markdown,
      date: canonicalDate,
      noTimeStamp: noTimestamp,
    });

    return {
      status: "queued",
      date: canonicalDate ?? "today_utc",
      noTimestamp: noTimestamp ?? false,
    };
  });
}
