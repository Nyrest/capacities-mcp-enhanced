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

export const agentIconValueSchema = z
  .object({
    type: z.enum(["emoji", "iconify"]),
    value: z.string().min(1),
  })
  .strict();

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
