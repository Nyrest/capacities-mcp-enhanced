import { describe, expect, test } from "bun:test";
import { writableApiBlockSchema } from "@capacities/api";
import {
  agentWritableBlockSchema,
  agentWritableTokenSchema,
} from "../src/lib/content-schema";
import { agentPropertyValueSchema } from "../src/lib/schemas";
import { sourceUrlSchema } from "../src/lib/url";

const paragraph = {
  type: "TextBlock" as const,
  tokens: [
    {
      type: "TextToken" as const,
      text: "Hello",
      style: { bold: true },
    },
  ],
  hierarchy: { key: "Base" as const, val: 0 as const },
};

describe("strict documented block schema", () => {
  test("accepts canonical nested blocks and remains SDK-compatible", () => {
    const input = {
      type: "GridBlock",
      gridLayout: "columns",
      dividers: [0.5],
      columns: [
        [paragraph],
        [
          {
            type: "GroupBlock",
            blocks: [
              {
                type: "TextBlock",
                tokens: [
                  {
                    type: "LinkToken",
                    text: "Capacities",
                    url: "https://capacities.io",
                  },
                ],
                hierarchy: { key: "H2", val: 2 },
              },
            ],
          },
        ],
      ],
    };

    const parsed = agentWritableBlockSchema.parse(input);
    expect(writableApiBlockSchema.safeParse(parsed).success).toBe(true);
  });

  test("rejects invented hierarchy values and mismatched key/value pairs", () => {
    expect(
      agentWritableBlockSchema.safeParse({
        ...paragraph,
        hierarchy: { key: "heading", val: 1 },
      }).success,
    ).toBe(false);
    expect(
      agentWritableBlockSchema.safeParse({
        ...paragraph,
        hierarchy: { key: "H1", val: 2 },
      }).success,
    ).toBe(false);
  });

  test("rejects undocumented or unreliable block fields", () => {
    expect(
      agentWritableBlockSchema.safeParse({
        ...paragraph,
        textAlignment: "center",
      }).success,
    ).toBe(false);
    expect(
      agentWritableBlockSchema.safeParse({
        type: "EntityBlock",
        entityId: null,
      }).success,
    ).toBe(false);
  });

  test("requires at least two grid columns when columns are supplied", () => {
    expect(
      agentWritableBlockSchema.safeParse({
        type: "GridBlock",
        dividers: [],
        columns: [[paragraph]],
      }).success,
    ).toBe(false);
  });
});

describe("strict documented token schema", () => {
  test("accepts exactly one documented link target", () => {
    expect(
      agentWritableTokenSchema.safeParse({
        type: "LinkToken",
        text: "External",
        url: "https://example.com",
      }).success,
    ).toBe(true);
    expect(
      agentWritableTokenSchema.safeParse({
        type: "LinkToken",
        text: "Object",
        entityId: "22222222-2222-4222-8222-222222222222",
      }).success,
    ).toBe(true);
  });

  test("rejects ambiguous, missing, and undocumented date link targets", () => {
    expect(
      agentWritableTokenSchema.safeParse({
        type: "LinkToken",
        text: "Ambiguous",
        url: "https://example.com",
        entityId: "22222222-2222-4222-8222-222222222222",
      }).success,
    ).toBe(false);
    expect(
      agentWritableTokenSchema.safeParse({
        type: "LinkToken",
        text: "Missing",
      }).success,
    ).toBe(false);
    expect(
      agentWritableTokenSchema.safeParse({
        type: "LinkToken",
        text: "Date",
        date: { start: "2026-07-29" },
      }).success,
    ).toBe(false);
    expect(
      agentWritableTokenSchema.safeParse({
        type: "LinkToken",
        text: "Local file",
        url: "file:///tmp/private",
      }).success,
    ).toBe(false);
  });
});

describe("agent property input schema", () => {
  test("accepts rich-text token arrays", () => {
    expect(
      agentPropertyValueSchema.safeParse([
        { type: "TextToken", text: "Rich", style: { italic: true } },
        { type: "CodeToken", text: "create_object" },
      ]).success,
    ).toBe(true);
  });

  test("rejects non-ISO date objects at the MCP boundary", () => {
    expect(
      agentPropertyValueSchema.safeParse({ start: "tomorrow" }).success,
    ).toBe(false);
  });
});

describe("weblink source schema", () => {
  test("accepts only HTTP and HTTPS import URLs", () => {
    expect(sourceUrlSchema.safeParse("https://example.com").success).toBe(true);
    expect(sourceUrlSchema.safeParse("http://example.com").success).toBe(true);
    expect(sourceUrlSchema.safeParse("file:///tmp/private").success).toBe(
      false,
    );
  });
});
