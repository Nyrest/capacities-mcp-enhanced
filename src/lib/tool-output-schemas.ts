import { z } from "zod";

const objectSchema = z
  .record(z.string(), z.unknown())
  .describe("Capacities API object returned by the server.");

const toolErrorSchema = z
  .object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  })
  .passthrough()
  .describe("Stable error information returned when the operation fails.");

const verificationSchema = z
  .object({
    status: z.enum([
      "verified",
      "mismatch",
      "readback_failed",
      "disabled",
      "not_applicable",
    ]),
    readbackPerformed: z.boolean(),
    readbackVerified: z.boolean(),
    snapshotAt: z.string(),
    snapshotSource: z.enum(["server_readback", "mutation_response", "none"]),
    writeState: z.enum([
      "verified",
      "written_unverified",
      "not_written",
      "unknown",
      "not_applicable",
    ]),
    mismatches: z
      .array(
        z
          .object({
            code: z.string(),
            path: z.string(),
            message: z.string(),
          })
          .passthrough(),
      )
      .optional(),
    readbackError: toolErrorSchema.optional(),
    reason: z.string().optional(),
  })
  .passthrough()
  .describe("Readback and persistence verification status.");

const lossReportSchema = z
  .object({
    analysisLevel: z.enum(["preflight_and_readback", "preflight_only"]),
    analysisMethod: z.literal("syntax_heuristic"),
    detectedLosses: z.array(
      z
        .object({
          code: z.string(),
          feature: z.string(),
          severity: z.literal("warning"),
          source: z.enum(["preflight", "readback"]),
          persistedAs: z.string(),
          blockId: z.string().uuid().optional(),
          entityId: z.string().uuid().optional(),
          inferredVisibleText: z.string().optional(),
        })
        .passthrough(),
    ),
    entityLinks: z.array(
      z
        .object({
          source: z.string(),
          label: z.string(),
          outcome: z.enum(["converted", "literalized"]),
          reason: z.string().optional(),
          entityId: z.string().uuid().optional(),
          blockId: z.string().uuid().optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough()
  .describe("Markdown conversion loss and entity-link report.");

const outputEnvelope = (data: z.ZodType) => ({
  isError: z
    .boolean()
    .describe("False for success; true when error is present."),
  data: data.optional().describe("Success payload for this tool."),
  error: toolErrorSchema.optional(),
});

const objectMutationData = (statuses: [string, ...string[]]) =>
  z
    .object({
      status: z.enum(statuses as [string, ...string[]]),
      object: objectSchema,
      verification: verificationSchema,
    })
    .passthrough();

const markdownMutationData = (statuses: [string, ...string[]]) =>
  objectMutationData(statuses).extend({ lossReport: lossReportSchema });

export const objectMutationOutputSchema = outputEnvelope(
  objectMutationData(["created", "updated", "appended"]),
);

export const markdownMutationOutputSchema = outputEnvelope(
  markdownMutationData(["created", "appended"]),
);

export const dailyNoteOutputSchema = outputEnvelope(
  z
    .object({
      status: z.literal("queued"),
      date: z.string(),
      noTimestamp: z.boolean(),
      verification: verificationSchema,
    })
    .passthrough(),
);

export const dailyNoteMarkdownOutputSchema = outputEnvelope(
  z
    .object({
      status: z.literal("queued"),
      date: z.string(),
      noTimestamp: z.boolean(),
      verification: verificationSchema,
      lossReport: lossReportSchema,
    })
    .passthrough(),
);

export const getObjectOutputSchema = outputEnvelope(
  z
    .object({
      format: z.enum(["markdown", "structured"]),
      object: objectSchema,
    })
    .passthrough(),
);

export const deleteBlockOutputSchema = outputEnvelope(
  z
    .object({
      status: z.literal("deleted"),
      object: objectSchema,
      verification: verificationSchema.extend({
        blockId: z.string().uuid(),
        propertyId: z.string(),
        absent: z.boolean(),
      }),
    })
    .passthrough(),
);

export const deleteObjectOutputSchema = outputEnvelope(
  z
    .object({
      status: z.enum(["moved_to_trash", "permanently_deleted"]),
      id: z.string().uuid(),
      verification: verificationSchema,
    })
    .passthrough(),
);

export const searchObjectsOutputSchema = outputEnvelope(
  z
    .object({
      query: z.string(),
      count: z.number().int().nonnegative(),
      results: z.array(
        z
          .object({
            id: z.string().uuid(),
            title: z.string(),
            structureId: z.string(),
            structureTitle: z.string().optional(),
          })
          .passthrough(),
      ),
    })
    .passthrough(),
);

export const inspectSpaceOutputSchema = outputEnvelope(
  z.union([
    z
      .object({
        space: objectSchema,
        structure: objectSchema,
        writeGuide: objectSchema,
      })
      .passthrough(),
    z
      .object({
        space: objectSchema,
        structures: z.array(objectSchema),
      })
      .passthrough(),
  ]),
);

const uploadItemSchema = z
  .object({
    index: z.number().int().nonnegative(),
    fileName: z.string(),
    status: z.enum([
      "queued",
      "initializing",
      "uploading",
      "completing",
      "verifying",
      "completed",
      "completed_with_warnings",
      "failed",
      "cancelled",
    ]),
    totalBytes: z.number().nonnegative(),
    uploadedBytes: z.number().nonnegative(),
    partSize: z.number().int().positive().optional(),
    partCount: z.number().int().positive().optional(),
    partsUploaded: z.number().int().nonnegative().optional(),
    objectId: z.string().uuid().optional(),
    object: z.unknown().optional(),
    verification: z.record(z.string(), z.unknown()).optional(),
    error: toolErrorSchema.optional(),
    cleanup: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

const uploadJobData = z
  .object({
    jobId: z.string().uuid(),
    status: z.enum([
      "queued",
      "running",
      "completed",
      "completed_with_warnings",
      "partial",
      "failed",
      "cancelled",
    ]),
    totalFiles: z.number().int().nonnegative(),
    completedFiles: z.number().int().nonnegative(),
    failedFiles: z.number().int().nonnegative(),
    cancelledFiles: z.number().int().nonnegative(),
    totalBytes: z.number().nonnegative(),
    uploadedBytes: z.number().nonnegative(),
    items: z.array(uploadItemSchema),
    timedOut: z.boolean().optional(),
  })
  .passthrough();

export const uploadFilesOutputSchema = outputEnvelope(uploadJobData);

export const manageUploadJobOutputSchema = outputEnvelope(
  uploadJobData.extend({
    action: z.enum(["status", "wait", "cancel"]),
  }),
);
