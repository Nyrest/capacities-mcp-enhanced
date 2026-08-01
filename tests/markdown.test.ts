import { describe, expect, test } from "bun:test";
import type { GetObjectResponse } from "@capacities/api";
import {
  createMarkdownLossReport,
  prepareMarkdownEntities,
} from "../src/lib/markdown";
import { convertMarkdownEntityMarkers } from "../src/lib/markdown-entities";

const entityId = "11111111-1111-4111-8111-111111111111";
const blockId = "22222222-2222-4222-8222-222222222222";

function objectWithEmptyEntityLabel(): GetObjectResponse {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    structureId: "44444444-4444-4444-8444-444444444444",
    collections: [],
    properties: {},
    blocks: {
      root: [
        {
          id: blockId,
          type: "TextBlock",
          tokens: [
            {
              type: "LinkToken",
              text: "",
              entityId,
            },
          ],
          hierarchy: { key: "Base", val: 0 },
          blocks: [],
        },
      ],
    },
  };
}

describe("Markdown conversion loss report", () => {
  test("detects all documented preflight loss classes", () => {
    const report = createMarkdownLossReport(`
__underline__

<details><summary>Toggle</summary>Body</details>

| A | B |
|---|---|
| 1 | 2 |

<span style="background-color: yellow">Marked</span>
`);

    expect(report.analysisLevel).toBe("preflight_only");
    expect(report.detectedLosses.map(({ code }) => code)).toEqual([
      "markdown_double_underscore_is_strong",
      "markdown_html_details_not_toggle",
      "markdown_table_not_grid",
      "markdown_background_color_not_preserved",
    ]);
  });

  test("reports an empty entity LinkToken and infers visible source text", () => {
    const report = createMarkdownLossReport(
      "Reference #VisibleTitle",
      objectWithEmptyEntityLabel(),
      [blockId],
    );

    expect(report.analysisLevel).toBe("preflight_and_readback");
    expect(report.detectedLosses).toContainEqual({
      code: "markdown_entity_link_empty_text",
      feature: "entity_link_visible_text",
      severity: "warning",
      source: "readback",
      persistedAs: "LinkToken with entityId and empty text",
      blockId,
      entityId,
      inferredVisibleText: "VisibleTitle",
    });
  });

  test("respects block scope for append readback", () => {
    const report = createMarkdownLossReport(
      "#VisibleTitle",
      objectWithEmptyEntityLabel(),
      ["99999999-9999-4999-8999-999999999999"],
    );

    expect(report.detectedLosses).toEqual([]);
  });

  test("only prepares a verified standalone entity link for structural conversion", async () => {
    const prepared = await prepareMarkdownEntities(
      "Before\n\n[Visible tag](https://app.capacities.io/55555555-5555-4555-8555-555555555555/11111111-1111-4111-8111-111111111111)\n\nAfter",
      {
        spaceId: "55555555-5555-4555-8555-555555555555",
        objectExists: async () => true,
      },
    );

    expect(prepared.entities).toEqual([
      {
        marker: "capacities-mcp-entity-0-11111111-1111-4111-8111-111111111111",
        label: "Visible tag",
        entityId,
        source:
          "[Visible tag](https://app.capacities.io/55555555-5555-4555-8555-555555555555/11111111-1111-4111-8111-111111111111)",
      },
    ]);
    expect(prepared.markdown).toContain(
      "capacities-mcp-entity-0-11111111-1111-4111-8111-111111111111",
    );
    expect(prepared.entityLinks[0]).toMatchObject({
      outcome: "converted",
      entityId,
    });
  });

  test("literalizes hashtags, empty labels, wrong spaces, and inline links", async () => {
    const prepared = await prepareMarkdownEntities(
      "#BareTag\n\n[](https://app.capacities.io/55555555-5555-4555-8555-555555555555/11111111-1111-4111-8111-111111111111)\n\n[Inline](https://app.capacities.io/55555555-5555-4555-8555-555555555555/11111111-1111-4111-8111-111111111111) with text\n\n[Wrong](https://app.capacities.io/66666666-6666-4666-8666-666666666666/11111111-1111-4111-8111-111111111111)",
      {
        spaceId: "55555555-5555-4555-8555-555555555555",
        objectExists: async () => true,
      },
    );

    expect(prepared.entities).toEqual([]);
    expect(prepared.markdown).toContain("\\#BareTag");
    expect(prepared.markdown).not.toContain("[Inline]");
    expect(prepared.entityLinks.map(({ reason }) => reason)).toEqual([
      "bare_hashtag_not_supported",
      "empty_visible_text",
      "non_standalone_link",
      "wrong_space",
    ]);
  });

  test("does not validate or leave markers for asynchronous daily-note writes", async () => {
    const prepared = await prepareMarkdownEntities(
      "[Visible](https://app.capacities.io/55555555-5555-4555-8555-555555555555/11111111-1111-4111-8111-111111111111)",
      {
        spaceId: "55555555-5555-4555-8555-555555555555",
        objectExists: async () => {
          throw new Error("must not be called");
        },
        convertEntities: false,
      },
    );

    expect(prepared.entities).toEqual([]);
    expect(prepared.markdown).toBe("Visible");
    expect(prepared.entityLinks[0]).toMatchObject({
      outcome: "literalized",
      reason: "async_not_supported",
    });
  });

  test("converts a prepared marker into an exact structural entity LinkToken", async () => {
    const marker =
      "capacities-mcp-entity-0-11111111-1111-4111-8111-111111111111";
    const object: GetObjectResponse = {
      id: "33333333-3333-4333-8333-333333333333",
      structureId: "RootPage",
      collections: [],
      properties: {},
      blocks: {
        root: [
          {
            id: blockId,
            type: "TextBlock",
            tokens: [{ type: "TextToken", text: marker, style: {} }],
            hierarchy: { key: "Base", val: 0 },
            blocks: [],
          },
        ],
      },
    };
    const updated = structuredClone(object);
    const update = async ({ blockId: target }: { blockId: string }) => {
      const block = updated.blocks?.root?.find((item) => item.id === target);
      if (block?.type === "TextBlock") {
        block.tokens = [{ type: "LinkToken", text: "Visible", entityId }];
      }
      return updated;
    };

    const result = await convertMarkdownEntityMarkers({
      client: {
        blocks: { block: { update } },
      } as never,
      objectId: object.id,
      object,
      entities: [{ marker, label: "Visible", entityId, source: "source" }],
      entityLinks: [
        {
          source: "source",
          label: "Visible",
          outcome: "converted",
          entityId,
        },
      ],
    });

    expect(result.blocks?.root?.[0]).toMatchObject({
      id: blockId,
      type: "TextBlock",
      tokens: [{ type: "LinkToken", text: "Visible", entityId }],
    });
  });

  test("preserves surrounding text when a parser embeds the marker in one token", async () => {
    const marker =
      "capacities-mcp-entity-0-11111111-1111-4111-8111-111111111111";
    const object: GetObjectResponse = {
      id: "33333333-3333-4333-8333-333333333333",
      structureId: "RootPage",
      collections: [],
      properties: {},
      blocks: {
        root: [
          {
            id: blockId,
            type: "TextBlock",
            tokens: [
              { type: "TextToken", text: "Before ", style: {} },
              { type: "TextToken", text: `${marker} after`, style: {} },
            ],
            hierarchy: { key: "Base", val: 0 },
            blocks: [],
          },
        ],
      },
    };
    let patched: unknown;
    const result = await convertMarkdownEntityMarkers({
      client: {
        blocks: {
          block: {
            update: async ({ block }: { block: unknown }) => {
              patched = block;
              return object;
            },
          },
        },
      } as never,
      objectId: object.id,
      object,
      entities: [{ marker, label: "Visible", entityId, source: "source" }],
      entityLinks: [
        {
          source: "source",
          label: "Visible",
          outcome: "converted",
          entityId,
        },
      ],
    });

    expect(result).toBe(object);
    expect(patched).toMatchObject({
      type: "TextBlock",
      tokens: [
        { type: "TextToken", text: "Before " },
        { type: "LinkToken", text: "Visible", entityId },
        { type: "TextToken", text: " after" },
      ],
    });
  });
});
