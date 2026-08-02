import type { InferSchema, ToolMetadata } from "xmcp";
import { z } from "zod";
import { apiCall, getClient, runTool } from "../lib/client";
import { createMarkdownLossReport } from "../lib/markdown";
import { prepareMarkdownForTool } from "../lib/markdown-entities";
import { canonicalDailyDate } from "../lib/properties";
import { asynchronousVerification } from "../lib/readback";
import { authSchema, markdownBodySchema } from "../lib/schemas";

export { dailyNoteMarkdownOutputSchema as outputSchema } from "../lib/tool-output-schemas";

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
    "Explicitly append Markdown to a Capacities daily note. Use append_daily_note for the preferred structural JSON-block workflow. The API queues this write asynchronously and lossReport is preflight-only; Markdown conversion is lossy for exact underline styling, toggle details, Grid layout, and HTML background colors.",
  annotations: {
    title: "Append Markdown to Capacities daily note",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
};

export default async function appendDailyNoteMarkdown(
  { markdown, date, noTimestamp, apiToken }: InferSchema<typeof schema>,
  extra?: { signal?: AbortSignal },
) {
  return runTool(async () => {
    const client = getClient(apiToken);
    const canonicalDate = date ? canonicalDailyDate(date) : undefined;
    const prepared = await prepareMarkdownForTool(
      client,
      markdown,
      extra?.signal,
      { convertEntities: false },
    );
    await apiCall(
      () =>
        client.blocks.dailyNote.append({
          markdown: prepared.markdown,
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
      lossReport: createMarkdownLossReport(
        markdown,
        undefined,
        undefined,
        prepared.entityLinks,
      ),
    };
  });
}
