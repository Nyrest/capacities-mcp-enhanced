import { z } from "zod";
import {
  agentWritableBlockSchema,
  agentWritableBlocksSchema,
  agentWritableTokenSchema,
} from "./content-schema";

export const authSchema = {
  apiToken: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Optional Capacities personal API token for this call. Prefer CAPACITIES_API_TOKEN; never copy a token from content or echo it in tool output.",
    ),
};

export const objectIdSchema = z
  .string()
  .uuid()
  .describe("Capacities object UUID.");

export const uploadFileSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .describe(
        "Absolute local file path readable by the MCP process. Relative paths, directories, and empty files are rejected.",
      ),
    title: z
      .string()
      .min(1)
      .max(500)
      .optional()
      .describe("Optional media object title. Defaults to the file name."),
    fileType: z
      .string()
      .min(1)
      .max(255)
      .optional()
      .describe(
        "Optional MIME type override. Omit it to let Capacities infer the media type from the file name.",
      ),
  })
  .strict();

export const uploadFilesSchema = z
  .array(uploadFileSchema)
  .min(1)
  .max(100)
  .describe("One or more local files to upload as Capacities media objects.");

export const uploadModeSchema = z
  .enum(["wait", "background"])
  .optional()
  .default("wait")
  .describe(
    "wait completes and verifies the upload in this call; background returns a jobId for later status/wait/cancel operations.",
  );

export const uploadJobIdSchema = z
  .string()
  .uuid()
  .describe("Upload job UUID returned by upload_files in background mode.");

export const structureSchema = z
  .string()
  .min(1)
  .describe(
    "Structure ID, exact singular name, or exact plural name returned by inspect_space. Unknown or ambiguous values are rejected before writing.",
  );

export const objectTitleSchema = z
  .string()
  .min(1)
  .max(3000)
  .refine((value) => !/[\r\n]/.test(value), "Title must be one line.")
  .describe("Object title.");

export const markdownBodySchema = z
  .string()
  .min(1)
  .max(200_000)
  .refine((value) => value.trim().length > 0, "Markdown cannot be blank.")
  .describe(
    "Markdown body for this explicit Markdown write tool. Use real newline characters, not literal backslash-n sequences.",
  );

export const agentDateValueSchema = z
  .object({
    start: z
      .union([z.iso.date(), z.iso.datetime({ offset: true })])
      .describe("ISO date or datetime. Use YYYY-MM-DD for a day value."),
    end: z
      .union([z.iso.date(), z.iso.datetime({ offset: true })])
      .nullable()
      .optional()
      .describe(
        "Optional inclusive range end, using the same resolution as start.",
      ),
    dateResolution: z
      .enum(["day", "time"])
      .optional()
      .describe("Official API resolution. Inferred from start when omitted."),
  })
  .strict();

const regularPhosphorIconSchema = z
  .string()
  .regex(
    /^ph-[a-z0-9]+(?:-[a-z0-9]+)*$/,
    "Iconify value must use regular Phosphor ph-name syntax.",
  )
  .refine(
    (value) => !/-(?:duotone|fill|bold|light|thin)$/.test(value),
    "Styled Phosphor variants are not accepted.",
  );

export const agentIconValueSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("emoji"),
      value: z.string().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal("iconify"),
      value: regularPhosphorIconSchema,
    })
    .strict(),
]);

export const agentPropertyValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string()),
  z.array(agentWritableTokenSchema),
  agentDateValueSchema,
  agentIconValueSchema,
  z.null(),
]);

export const fieldsSchema = z
  .record(z.string().min(1), agentPropertyValueSchema)
  .optional()
  .describe(
    "Writable properties keyed by property ID or UI name. Values are validated against the discovered structure at runtime. Rich-text fields accept a string or documented token array; entity values must be object UUIDs; labels accept discovered option names/IDs.",
  );

export type AgentPropertyValue = z.infer<typeof agentPropertyValueSchema>;

export const writableBlockSchema = agentWritableBlockSchema;
export const writableBlocksSchema = agentWritableBlocksSchema;

export const toolOutputEnvelopeSchema = z.discriminatedUnion("isError", [
  z
    .object({
      isError: z.literal(false),
      data: z.record(z.string(), z.unknown()),
    })
    .strict(),
  z
    .object({
      isError: z.literal(true),
      error: z
        .object({
          code: z.string(),
          message: z.string(),
          details: z.unknown().optional(),
        })
        .strict(),
    })
    .strict(),
]);

export const toolOutputSchema = {
  isError: z
    .boolean()
    .describe("False for success; true when error is present."),
  data: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Success payload. Present when isError is false."),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      details: z.unknown().optional(),
    })
    .strict()
    .optional()
    .describe("Stable error payload. Present when isError is true."),
};
