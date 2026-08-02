import type { InferSchema, ToolMetadata } from "xmcp";
import { z } from "zod";
import { runTool } from "../lib/client";
import { authSchema, uploadJobIdSchema } from "../lib/schemas";
import {
  cancelUploadJob,
  getUploadJob,
  type UploadJobSnapshot,
  waitForUploadJob,
} from "../lib/upload-jobs";

export { manageUploadJobOutputSchema as outputSchema } from "../lib/tool-output-schemas";

export const schema = {
  jobId: uploadJobIdSchema,
  action: z
    .enum(["status", "wait", "cancel"])
    .describe(
      "Inspect progress, wait for a terminal result, or cancel the job.",
    ),
  timeoutSeconds: z
    .number()
    .int()
    .min(1)
    .max(300)
    .optional()
    .default(60)
    .describe("Maximum wait duration for action=wait, from 1 to 300 seconds."),
  ...authSchema,
};

export const metadata: ToolMetadata = {
  name: "manage_upload_job",
  description:
    "Manage an in-process Capacities upload job returned by upload_files in background mode. status is immediate, wait blocks up to timeoutSeconds, and cancel aborts pending sessions while preserving already completed media objects.",
  annotations: {
    title: "Manage Capacities upload job",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
};

type ToolExtra = {
  signal?: AbortSignal;
  _meta?: { progressToken?: string | number };
  sendNotification?: (notification: unknown) => Promise<void>;
};

function progressReporter(extra?: ToolExtra) {
  const token = extra?._meta?.progressToken;
  if (token === undefined || !extra?.sendNotification) return undefined;
  return async (snapshot: UploadJobSnapshot) => {
    await extra.sendNotification?.({
      method: "notifications/progress",
      params: {
        progressToken: token,
        progress: snapshot.uploadedBytes,
        total: snapshot.totalBytes,
        message: `Uploaded ${snapshot.completedFiles}/${snapshot.totalFiles} files (${snapshot.uploadedBytes}/${snapshot.totalBytes} bytes).`,
      },
    });
  };
}

export default async function manageUploadJob(
  { jobId, action, timeoutSeconds }: InferSchema<typeof schema>,
  extra?: ToolExtra,
) {
  return runTool(async () => {
    if (action === "status") return { action, ...getUploadJob(jobId) };
    if (action === "cancel") {
      return { action, ...(await cancelUploadJob(jobId)) };
    }
    return {
      action,
      ...(await waitForUploadJob(
        jobId,
        timeoutSeconds * 1000,
        extra?.signal,
        progressReporter(extra),
      )),
    };
  });
}
