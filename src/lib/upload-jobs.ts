import { randomUUID } from "node:crypto";
import { open, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import { CapacitiesApiError } from "@capacities/api";
import {
  apiCall,
  getClient,
  McpToolError,
  normalizeError,
  type ToolError,
} from "./client";
import {
  abortMediaUpload,
  completeMediaUpload,
  initMediaUpload,
  type MediaUploadInit,
  type MediaUploadObject,
  uploadMediaPart,
} from "./media-upload";

const MAX_FILE_CONCURRENCY = 3;
const TERMINAL_RETENTION_MS = 30 * 60 * 1000;
const MAX_TERMINAL_JOBS = 100;

export type UploadFileInput = {
  path: string;
  title?: string;
  fileType?: string;
};

export type UploadMode = "wait" | "background";
export type UploadJobStatus =
  | "queued"
  | "running"
  | "waiting_rate_limit"
  | "completed"
  | "completed_with_warnings"
  | "partial"
  | "failed"
  | "cancelled";
export type UploadItemStatus =
  | "queued"
  | "initializing"
  | "uploading"
  | "completing"
  | "verifying"
  | "completed"
  | "completed_with_warnings"
  | "failed"
  | "cancelled";

export type UploadItemSnapshot = {
  index: number;
  fileName: string;
  status: UploadItemStatus;
  totalBytes: number;
  uploadedBytes: number;
  partSize?: number;
  partCount?: number;
  partsUploaded?: number;
  objectId?: string;
  object?: unknown;
  verification?: Record<string, unknown>;
  error?: ToolError;
  cleanup?: Record<string, unknown>;
};

export type UploadJobSnapshot = {
  jobId: string;
  status: UploadJobStatus;
  totalFiles: number;
  completedFiles: number;
  failedFiles: number;
  cancelledFiles: number;
  totalBytes: number;
  uploadedBytes: number;
  items: UploadItemSnapshot[];
  timedOut?: boolean;
};

type PreparedFile = UploadFileInput & {
  resolvedPath: string;
  fileName: string;
  fileSize: number;
  modifiedAt: number;
};

type UploadItem = UploadItemSnapshot & {
  sessionId?: string;
};

type ProgressListener = (snapshot: UploadJobSnapshot) => void | Promise<void>;

type UploadJob = {
  id: string;
  status: UploadJobStatus;
  apiToken?: string;
  collections?: string[];
  prepared: PreparedFile[];
  items: UploadItem[];
  totalBytes: number;
  uploadedBytes: number;
  controller: AbortController;
  cancelRequested: boolean;
  listeners: Set<ProgressListener>;
};

const jobs = new Map<string, UploadJob>();

function isTerminal(status: UploadJobStatus): boolean {
  return [
    "completed",
    "completed_with_warnings",
    "partial",
    "failed",
    "cancelled",
  ].includes(status);
}

async function prepareFiles(
  inputs: UploadFileInput[],
): Promise<PreparedFile[]> {
  const prepared: PreparedFile[] = [];

  for (const input of inputs) {
    if (!isAbsolute(input.path)) {
      throw new McpToolError(
        "mcp_upload_invalid_path",
        `Upload source must be an absolute path: ${input.path}`,
      );
    }
    const resolvedPath = await realpath(input.path).catch(() => {
      throw new McpToolError(
        "mcp_upload_file_not_found",
        `Upload source does not exist or is not readable: ${input.path}`,
      );
    });

    const file = await stat(resolvedPath);
    if (!file.isFile()) {
      throw new McpToolError(
        "mcp_upload_invalid_file",
        `Upload source is not a regular file: ${input.path}`,
      );
    }
    if (file.size <= 0 || !Number.isSafeInteger(file.size)) {
      throw new McpToolError(
        "mcp_upload_invalid_file",
        `Upload source must be a non-empty file with a safe byte size: ${input.path}`,
      );
    }

    const fileName = basename(resolvedPath);
    if (fileName.length < 1 || fileName.length > 512) {
      throw new McpToolError(
        "mcp_upload_invalid_file",
        `Upload file name must contain 1 to 512 characters: ${fileName}`,
      );
    }

    prepared.push({
      ...input,
      resolvedPath,
      fileName,
      fileSize: file.size,
      modifiedAt: file.mtimeMs,
    });
  }

  return prepared;
}

function snapshot(job: UploadJob): UploadJobSnapshot {
  const completedFiles = job.items.filter(
    (item) =>
      item.status === "completed" || item.status === "completed_with_warnings",
  ).length;
  const failedFiles = job.items.filter(
    (item) => item.status === "failed",
  ).length;
  const cancelledFiles = job.items.filter(
    (item) => item.status === "cancelled",
  ).length;

  return {
    jobId: job.id,
    status: job.status,
    totalFiles: job.items.length,
    completedFiles,
    failedFiles,
    cancelledFiles,
    totalBytes: job.totalBytes,
    uploadedBytes: job.uploadedBytes,
    items: job.items.map(({ sessionId: _sessionId, ...item }) => ({ ...item })),
  };
}

function emit(job: UploadJob): void {
  const current = snapshot(job);
  for (const listener of job.listeners) {
    void Promise.resolve(listener(current)).catch(() => undefined);
  }
}

function setItemStatus(
  job: UploadJob,
  item: UploadItem,
  status: UploadItemStatus,
): void {
  item.status = status;
  emit(job);
}

function isRateLimited(error: unknown): error is CapacitiesApiError {
  return (
    error instanceof CapacitiesApiError &&
    error.status === 429 &&
    error.code === "cap_rate_limit_exceeded"
  );
}

function rateLimitWaitMs(error: CapacitiesApiError): number {
  const details = error.details as Record<string, unknown> | undefined;
  const retryAfter =
    details && typeof details.retryAfter === "number"
      ? Math.max(1, details.retryAfter * 1000)
      : 2_000;
  return Math.min(Math.max(retryAfter + 250, 1_000), 65_000);
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? new Error("Upload cancelled."));
  }
  return new Promise((resolveDelay, reject) => {
    const timer = setTimeout(resolveDelay, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error("Upload cancelled."));
      },
      { once: true },
    );
  });
}

async function uploadCall<T>(
  job: UploadJob,
  operation: () => Promise<T>,
  stage:
    | "upload_init"
    | "upload_part"
    | "upload_complete"
    | "upload_abort"
    | "upload_readback",
  expiresAt?: string,
): Promise<T> {
  while (true) {
    try {
      return await apiCall(operation, { signal: job.controller.signal, stage });
    } catch (error) {
      if (!isRateLimited(error) || job.controller.signal.aborted) {
        throw error;
      }
      const waitMs = rateLimitWaitMs(error);
      if (expiresAt && Date.now() + waitMs >= Date.parse(expiresAt)) {
        throw error;
      }
      job.status = "waiting_rate_limit";
      emit(job);
      await delay(waitMs, job.controller.signal);
      if (!isTerminal(job.status)) {
        job.status = "running";
        emit(job);
      }
    }
  }
}

function mediaVerification(
  object: MediaUploadObject,
  file: PreparedFile,
  collections?: string[],
): Record<string, unknown> {
  const mismatches: string[] = [];
  const properties = object.properties as Record<string, unknown> | undefined;
  const files = object.files ?? [];
  if (!String(object.structureId).startsWith("Media"))
    mismatches.push("structureId");
  if (files.length === 0) mismatches.push("files");
  const readSize = (
    properties?.media_fileSize as { number?: { value?: unknown } } | undefined
  )?.number?.value;
  if (readSize !== file.fileSize) mismatches.push("fileSize");
  const readTitle = (
    properties?.title as { title?: { value?: unknown } } | undefined
  )?.title?.value;
  if (file.title && readTitle !== file.title) {
    mismatches.push("title");
  }
  if (file.fileType && files[0]?.fileType !== file.fileType) {
    mismatches.push("fileType");
  }
  if (collections !== undefined && collections.length > 0) {
    const actual = JSON.stringify(object.collections ?? []);
    const expected = JSON.stringify(collections);
    if (actual !== expected) mismatches.push("collections");
  }
  return {
    readbackPerformed: true,
    readbackVerified: mismatches.length === 0,
    snapshotSource: "server_readback",
    writeState: mismatches.length === 0 ? "verified" : "written_unverified",
    ...(mismatches.length === 0 ? {} : { mismatches }),
  };
}

async function abortSession(job: UploadJob, item: UploadItem): Promise<void> {
  if (!item.sessionId) return;
  const id = item.sessionId;
  item.sessionId = undefined;
  try {
    await abortMediaUpload(id, job.apiToken, AbortSignal.timeout(10_000));
    item.cleanup = { attempted: true, status: "aborted" };
  } catch (error) {
    item.cleanup = {
      attempted: true,
      status: "unverified",
      error: normalizeError(error),
    };
  }
}

function cancelled(job: UploadJob): boolean {
  return job.cancelRequested || job.controller.signal.aborted;
}

async function processFile(
  job: UploadJob,
  item: UploadItem,
  file: PreparedFile,
): Promise<void> {
  if (cancelled(job)) {
    setItemStatus(job, item, "cancelled");
    return;
  }

  let init: MediaUploadInit | undefined;
  try {
    setItemStatus(job, item, "initializing");
    init = await uploadCall(
      job,
      () =>
        initMediaUpload(
          {
            fileName: file.fileName,
            fileSize: file.fileSize,
            ...(file.fileType ? { fileType: file.fileType } : {}),
            ...(file.title ? { title: file.title } : {}),
            ...(job.collections === undefined
              ? {}
              : { collections: job.collections }),
          },
          job.apiToken,
          job.controller.signal,
        ),
      "upload_init",
    );
    item.sessionId = init.id;
    item.partSize = init.partSize;
    item.partCount = init.partCount;
    item.partsUploaded = 0;
    const activeInit = init;

    const handle = await open(file.resolvedPath, "r");
    try {
      setItemStatus(job, item, "uploading");
      let offset = 0;
      for (
        let partNumber = 1;
        partNumber <= activeInit.partCount;
        partNumber += 1
      ) {
        if (cancelled(job)) throw new Error("Upload cancelled.");
        const length = Math.min(activeInit.partSize, file.fileSize - offset);
        const bytes = Buffer.allocUnsafe(length);
        const result = await handle.read(bytes, 0, length, offset);
        if (result.bytesRead !== length) {
          throw new McpToolError(
            "mcp_upload_file_changed",
            `File ended before the expected bytes were read: ${file.fileName}`,
          );
        }
        const uploaded = await uploadCall(
          job,
          () =>
            uploadMediaPart(
              { id: activeInit.id, partNumber },
              bytes.subarray(0, result.bytesRead),
              job.apiToken,
              job.controller.signal,
            ),
          "upload_part",
          activeInit.expiresAt,
        );
        if (uploaded.number !== partNumber || uploaded.size !== length) {
          throw new McpToolError(
            "mcp_upload_part_mismatch",
            `Capacities acknowledged an unexpected part for ${file.fileName}.`,
            {
              expected: { number: partNumber, size: length },
              actual: uploaded,
            },
          );
        }
        offset += length;
        item.uploadedBytes += length;
        item.partsUploaded = partNumber;
        job.uploadedBytes += length;
        emit(job);
      }

      const after = await handle.stat();
      if (after.size !== file.fileSize || after.mtimeMs !== file.modifiedAt) {
        throw new McpToolError(
          "mcp_upload_file_changed",
          `File changed while it was being uploaded: ${file.fileName}`,
        );
      }
    } finally {
      await handle.close();
    }

    setItemStatus(job, item, "completing");
    const completed = await uploadCall(
      job,
      () =>
        completeMediaUpload(activeInit.id, job.apiToken, job.controller.signal),
      "upload_complete",
      activeInit.expiresAt,
    );
    item.sessionId = undefined;
    item.objectId = completed.id;
    setItemStatus(job, item, "verifying");
    const client = getClient(job.apiToken);
    let readback: unknown;
    try {
      readback = await uploadCall(
        job,
        () =>
          apiCall(() => client.object.get({ id: completed.id }), {
            signal: job.controller.signal,
            stage: "upload_readback",
          }),
        "upload_readback",
      );
    } catch (error) {
      if (cancelled(job)) throw error;
      item.object = completed;
      item.uploadedBytes = file.fileSize;
      item.verification = {
        readbackPerformed: true,
        readbackVerified: false,
        snapshotSource: "mutation_response",
        writeState: "written_unverified",
        readbackError: normalizeError(error),
      };
      setItemStatus(job, item, "completed_with_warnings");
      return;
    }
    const verification = mediaVerification(
      readback as MediaUploadObject,
      file,
      job.collections,
    );
    item.object = readback;
    item.verification = verification;
    item.uploadedBytes = file.fileSize;
    setItemStatus(
      job,
      item,
      verification.readbackVerified ? "completed" : "completed_with_warnings",
    );
  } catch (error) {
    if (cancelled(job)) {
      setItemStatus(job, item, "cancelled");
    } else {
      item.error = normalizeError(error);
      setItemStatus(job, item, "failed");
    }
  } finally {
    await abortSession(job, item);
  }
}

async function runJob(job: UploadJob): Promise<void> {
  job.status = "running";
  emit(job);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= job.prepared.length) return;
      await processFile(job, job.items[index], job.prepared[index]);
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(MAX_FILE_CONCURRENCY, job.prepared.length) },
      () => worker(),
    ),
  );

  const failed = job.items.filter((item) => item.status === "failed").length;
  const cancelledCount = job.items.filter(
    (item) => item.status === "cancelled",
  ).length;
  const warnings = job.items.filter(
    (item) => item.status === "completed_with_warnings",
  ).length;
  const completed = job.items.length - failed - cancelledCount;
  if (cancelledCount > 0 && completed === 0) job.status = "cancelled";
  else if (failed === job.items.length) job.status = "failed";
  else if (failed > 0 || cancelledCount > 0) job.status = "partial";
  else if (warnings > 0) job.status = "completed_with_warnings";
  else job.status = "completed";
  emit(job);

  const cleanup = setTimeout(() => {
    if (jobs.get(job.id) === job) jobs.delete(job.id);
  }, TERMINAL_RETENTION_MS);
  cleanup.unref?.();
  const terminal = [...jobs.values()].filter((candidate) =>
    isTerminal(candidate.status),
  );
  if (terminal.length > MAX_TERMINAL_JOBS) {
    jobs.delete(terminal[0].id);
  }
}

export async function startUploadJob(options: {
  files: UploadFileInput[];
  collections?: string[];
  mode: UploadMode;
  apiToken?: string;
  signal?: AbortSignal;
  onProgress?: ProgressListener;
}): Promise<UploadJobSnapshot> {
  const prepared = await prepareFiles(options.files);
  const job: UploadJob = {
    id: randomUUID(),
    status: "queued",
    apiToken: options.apiToken,
    collections: options.collections,
    prepared,
    items: prepared.map((file, index) => ({
      index,
      fileName: file.fileName,
      status: "queued",
      totalBytes: file.fileSize,
      uploadedBytes: 0,
    })),
    totalBytes: prepared.reduce((total, file) => total + file.fileSize, 0),
    uploadedBytes: 0,
    controller: new AbortController(),
    cancelRequested: false,
    listeners: new Set(options.onProgress ? [options.onProgress] : []),
  };
  jobs.set(job.id, job);
  if (options.mode === "wait" && options.signal) {
    if (options.signal.aborted) {
      job.cancelRequested = true;
      job.controller.abort(options.signal.reason);
    } else {
      options.signal.addEventListener(
        "abort",
        () => {
          job.cancelRequested = true;
          job.controller.abort(options.signal?.reason);
        },
        { once: true },
      );
    }
  }
  void runJob(job);

  if (options.mode === "background") {
    return snapshot(job);
  }
  return waitForUploadJob(job.id, Number.POSITIVE_INFINITY);
}

export function getUploadJob(jobId: string): UploadJobSnapshot {
  const job = jobs.get(jobId);
  if (!job) {
    throw new McpToolError(
      "mcp_upload_job_not_found",
      `Upload job is not available in this MCP process: ${jobId}`,
    );
  }
  return snapshot(job);
}

export async function waitForUploadJob(
  jobId: string,
  timeoutMs: number,
  signal?: AbortSignal,
  onProgress?: ProgressListener,
): Promise<UploadJobSnapshot> {
  const job = jobs.get(jobId);
  if (!job) {
    throw new McpToolError(
      "mcp_upload_job_not_found",
      `Upload job is not available in this MCP process: ${jobId}`,
    );
  }
  const started = Date.now();
  let lastProgress = -1;
  while (true) {
    const current = snapshot(job);
    if (onProgress && current.uploadedBytes !== lastProgress) {
      lastProgress = current.uploadedBytes;
      await onProgress(current);
    }
    if (isTerminal(current.status)) return current;
    if (Date.now() - started >= timeoutMs)
      return { ...current, timedOut: true };
    const remaining = Number.isFinite(timeoutMs)
      ? Math.max(1, timeoutMs - (Date.now() - started))
      : 500;
    await delay(
      Math.min(500, remaining),
      signal ?? new AbortController().signal,
    );
  }
}

export async function cancelUploadJob(
  jobId: string,
): Promise<UploadJobSnapshot> {
  const job = jobs.get(jobId);
  if (!job) {
    throw new McpToolError(
      "mcp_upload_job_not_found",
      `Upload job is not available in this MCP process: ${jobId}`,
    );
  }
  if (!isTerminal(job.status)) {
    job.cancelRequested = true;
    job.controller.abort(new Error("Upload cancelled by the agent."));
    await waitForUploadJob(jobId, 30_000);
  }
  return snapshot(job);
}
