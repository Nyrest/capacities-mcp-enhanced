import type { InferSchema, ToolMetadata } from "xmcp";
import { z } from "zod";
import { runTool } from "../lib/client";
import {
  authSchema,
  uploadFilesSchema,
  uploadModeSchema,
} from "../lib/schemas";
import { startUploadJob, type UploadJobSnapshot } from "../lib/upload-jobs";

export { uploadFilesOutputSchema as outputSchema } from "../lib/tool-output-schemas";

export const schema = {
  files: uploadFilesSchema,
  collections: z
    .array(z.string().uuid())
    .optional()
    .describe(
      "Optional collection UUIDs shared by every uploaded media object.",
    ),
  mode: uploadModeSchema,
  ...authSchema,
};

export const metadata: ToolMetadata = {
  name: "upload_files",
  description:
    "Upload one or more local files to Capacities as media objects. Streams multipart files without loading them into the model or memory, verifies each completed object with GET, and returns partial results when independent files fail. Use mode=background for long or large batches, then manage_upload_job for status, wait, or cancel.",
  annotations: {
    title: "Upload Capacities media files",
    readOnlyHint: false,
    destructiveHint: false,
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

export default async function uploadFiles(
  { files, collections, mode, apiToken }: InferSchema<typeof schema>,
  extra?: ToolExtra,
) {
  return runTool(() =>
    startUploadJob({
      files,
      collections,
      mode,
      apiToken,
      signal: extra?.signal,
      onProgress: progressReporter(extra),
    }),
  );
}
