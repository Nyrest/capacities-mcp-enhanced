import {
  textOrBackgroundColorThemeSchema,
  type WritableApiBlock,
  type WritableApiToken,
} from "@capacities/api";
import { z } from "zod";

const textStyleSchema = z
  .object({
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    strikethrough: z.boolean().optional(),
    underline: z.boolean().optional(),
  })
  .strict();

const textTokenSchema = z
  .object({
    type: z.literal("TextToken"),
    text: z.string(),
    style: textStyleSchema,
    color: textOrBackgroundColorThemeSchema.optional(),
  })
  .strict();

const urlLinkTokenSchema = z
  .object({
    type: z.literal("LinkToken"),
    text: z.string(),
    url: z
      .string()
      .url()
      .regex(/^https?:\/\//i),
  })
  .strict()
  .describe(
    "External hyperlink with display text and one absolute URL target.",
  );

const entityLinkTokenSchema = z
  .object({
    type: z.literal("LinkToken"),
    text: z.string(),
    entityId: z.string().uuid(),
  })
  .strict()
  .describe(
    "Link to one existing Capacities object. Discover its UUID with search_objects, then confirm it with get_object when needed.",
  );

const mathTokenSchema = z
  .object({
    type: z.literal("MathToken"),
    text: z.string(),
  })
  .strict();

const codeTokenSchema = z
  .object({
    type: z.literal("CodeToken"),
    text: z.string(),
  })
  .strict();

/**
 * Documented writable token subset. The SDK also exposes date-backed links,
 * but the public concept documentation only promises URL and entity targets.
 */
export const agentWritableTokenSchema: z.ZodType<WritableApiToken> = z
  .union([
    textTokenSchema,
    urlLinkTokenSchema,
    entityLinkTokenSchema,
    mathTokenSchema,
    codeTokenSchema,
  ])
  .describe(
    "Inline token. LinkToken must contain exactly one target: url or entityId.",
  );

const hierarchySchema = z
  .union([
    z.object({ key: z.literal("Base"), val: z.literal(0) }).strict(),
    z.object({ key: z.literal("H1"), val: z.literal(1) }).strict(),
    z.object({ key: z.literal("H2"), val: z.literal(2) }).strict(),
    z.object({ key: z.literal("H3"), val: z.literal(3) }).strict(),
  ])
  .describe("Canonical Capacities outline pair: Base/0, H1/1, H2/2, or H3/3.");

const listSchema = z
  .object({
    type: z.enum(["bullet", "alphabetical", "numerical", "roman"]),
  })
  .strict();

const todoSchema = z.object({ isDone: z.boolean() }).strict();
const toggleSchema = z.object({ isOpen: z.boolean() }).strict();
const quoteSchema = z
  .object({ layout: z.enum(["normal", "standout"]) })
  .strict();

/**
 * Strict agent-facing block schema. It intentionally omits SDK-only date
 * links, empty entity embeds, textAlignment, and highlight annotations because
 * they are not part of the documented, reliably round-trippable concept API.
 */
export const agentWritableBlockSchema: z.ZodType<WritableApiBlock> = z.lazy(
  () =>
    z.union([
      z
        .object({
          type: z.literal("TextBlock"),
          tokens: z.array(agentWritableTokenSchema).optional(),
          blocks: z.array(agentWritableBlockSchema).optional(),
          hierarchy: hierarchySchema.optional(),
          list: listSchema.nullable().optional(),
          todo: todoSchema.optional(),
          toggle: toggleSchema.nullable().optional(),
          quote: quoteSchema.optional(),
          colorTheme: textOrBackgroundColorThemeSchema.optional(),
        })
        .strict(),
      z
        .object({
          type: z.literal("GroupBlock"),
          blocks: z.array(agentWritableBlockSchema).optional(),
          list: listSchema.nullable().optional(),
          todo: todoSchema.optional(),
          toggle: toggleSchema.nullable().optional(),
          colorTheme: textOrBackgroundColorThemeSchema.optional(),
        })
        .strict(),
      z
        .object({
          type: z.literal("GridBlock"),
          columns: z.array(z.array(agentWritableBlockSchema)).min(2).optional(),
          dividers: z.array(z.number()),
          gridLayout: z.enum(["columns", "grid"]).optional(),
          colorTheme: textOrBackgroundColorThemeSchema.optional(),
        })
        .strict(),
      z
        .object({
          type: z.literal("CodeBlock"),
          lang: z.string(),
          text: z.string(),
        })
        .strict(),
      z
        .object({
          type: z.literal("MathBlock"),
          text: z.string(),
          colorTheme: textOrBackgroundColorThemeSchema.optional(),
        })
        .strict(),
      z
        .object({
          type: z.literal("EntityBlock"),
          entityId: z.string().uuid(),
        })
        .strict(),
      z.object({ type: z.literal("HorizontalLineBlock") }).strict(),
    ]),
);

export const agentWritableBlocksSchema = z
  .array(agentWritableBlockSchema)
  .min(1)
  .describe(
    "One or more strict structural Capacities blocks. Use canonical hierarchy pairs and documented token targets only; omit block IDs on new blocks.",
  );
