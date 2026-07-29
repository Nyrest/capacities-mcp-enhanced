import type { CreateObjectFromUrlProperties } from "@capacities/api";
import { z } from "zod";
import { objectTitleSchema } from "./schemas";

export const sourceUrlSchema = z
  .string()
  .url()
  .regex(/^https?:\/\//i)
  .describe("HTTP or HTTPS URL to import as a Capacities web-resource object.");

export const sourceTitleSchema = objectTitleSchema
  .optional()
  .describe("Optional title for the imported web-resource object.");

export const sourceDescriptionSchema = z
  .string()
  .max(10_000)
  .optional()
  .describe("Optional description for the imported web-resource object.");

export function createUrlProperties(
  title?: string,
  description?: string,
): CreateObjectFromUrlProperties | undefined {
  if (title === undefined && description === undefined) {
    return undefined;
  }

  return {
    ...(title === undefined
      ? {}
      : { title: { type: "title" as const, title: { value: title } } }),
    ...(description === undefined
      ? {}
      : {
          description: {
            type: "text" as const,
            text: { value: description },
          },
        }),
  };
}
