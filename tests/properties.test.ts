import { describe, expect, test } from "bun:test";
import type { SpaceStructure } from "@capacities/api";
import {
  assertStandardObjectCreateSupported,
  canonicalDailyDate,
  createAgentWriteGuide,
  normalizePropertyFields,
  resolveStructure,
  structureCreateTool,
} from "../src/lib/properties";

const structure: SpaceStructure = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "Book",
  pluralName: "Books",
  labelColor: "blue",
  collections: [],
  propertyDefinitions: [
    {
      id: "title",
      name: "Title",
      type: "title",
      writable: true,
    },
    {
      id: "rating",
      name: "Rating",
      type: "number",
      writable: true,
    },
    {
      id: "status",
      name: "Status",
      type: "label",
      writable: true,
      multiple: false,
      labelSet: [
        { id: "reading", name: "Reading", color: "blue" },
        { id: "done", name: "Done", color: "green" },
      ],
    },
    {
      id: "related",
      name: "Related",
      type: "entity",
      writable: true,
      allowedStructures: ["RootPage"],
    },
    {
      id: "published",
      name: "Published",
      type: "date",
      writable: true,
    },
    {
      id: "notes",
      name: "Notes",
      type: "richText",
      writable: true,
    },
    {
      id: "updated",
      name: "Updated",
      type: "lastUpdatedAt",
      writable: false,
    },
  ],
};

describe("structure resolution", () => {
  test("accepts IDs, singular names, and plural names case-insensitively", () => {
    expect(resolveStructure([structure], structure.id)).toBe(structure);
    expect(resolveStructure([structure], "book")).toBe(structure);
    expect(resolveStructure([structure], "BOOKS")).toBe(structure);
  });

  test("rejects unknown structures with a discovery hint", () => {
    expect(() => resolveStructure([structure], "Movie")).toThrow(
      "Call inspect_space",
    );
  });
});

describe("agent create routing", () => {
  test("routes standard, URL, and unsupported built-in structures explicitly", () => {
    const page = { ...structure, id: "RootPage", title: "Page" };
    const weblink = {
      ...structure,
      id: "MediaWebResource",
      title: "Weblink",
    };
    const image = { ...structure, id: "MediaImage", title: "Image" };

    expect(structureCreateTool(page)).toBe("create_object");
    expect(structureCreateTool(weblink)).toBe("create_object_from_url");
    expect(structureCreateTool(image)).toBeNull();
    expect(createAgentWriteGuide(weblink).createTool).toBe(
      "create_object_from_url",
    );
    expect(() => assertStandardObjectCreateSupported(weblink)).toThrow(
      "create_object_from_url",
    );
  });
});

describe("agent property normalization", () => {
  test("resolves UI property and label names into API payloads", () => {
    expect(
      normalizePropertyFields(structure, {
        Title: "The Dispossessed",
        Rating: 5,
        Status: "done",
        Related: [
          "22222222-2222-4222-8222-222222222222",
          "33333333-3333-4333-8333-333333333333",
        ],
        Published: "1974-05-01",
        Notes: "Utopian ambiguity",
      }),
    ).toEqual({
      title: { type: "title", title: { value: "The Dispossessed" } },
      rating: { type: "number", number: { value: 5 } },
      status: {
        type: "label",
        label: [{ id: "done", name: "Done", color: "green" }],
      },
      related: {
        type: "entity",
        entity: [
          { id: "22222222-2222-4222-8222-222222222222" },
          { id: "33333333-3333-4333-8333-333333333333" },
        ],
      },
      published: {
        type: "date",
        date: {
          dateResolution: "day",
          start: "1974-05-01T00:00:00.000Z",
        },
      },
      notes: {
        type: "richText",
        richText: {
          value: [
            {
              type: "TextToken",
              text: "Utopian ambiguity",
              style: {},
            },
          ],
        },
      },
    });
  });

  test("uses empty arrays to clear collection-like properties", () => {
    expect(
      normalizePropertyFields(structure, {
        Status: null,
        Related: null,
        Notes: null,
      }),
    ).toEqual({
      status: { type: "label", label: [] },
      related: { type: "entity", entity: [] },
      notes: { type: "richText", richText: { value: [] } },
    });
  });

  test("preserves documented rich-text tokens", () => {
    expect(
      normalizePropertyFields(structure, {
        Notes: [
          { type: "TextToken", text: "Read ", style: {} },
          {
            type: "LinkToken",
            text: "the docs",
            url: "https://developers.capacities.io/api/concepts/properties",
          },
          { type: "CodeToken", text: "PATCH /object" },
        ],
      }),
    ).toEqual({
      notes: {
        type: "richText",
        richText: {
          value: [
            { type: "TextToken", text: "Read ", style: {} },
            {
              type: "LinkToken",
              text: "the docs",
              url: "https://developers.capacities.io/api/concepts/properties",
            },
            { type: "CodeToken", text: "PATCH /object" },
          ],
        },
      },
    });
  });

  test("rejects invalid labels, duplicate field aliases, and read-only fields", () => {
    expect(() =>
      normalizePropertyFields(structure, { Status: "Blocked" }),
    ).toThrow("Available labels");
    expect(() =>
      normalizePropertyFields(structure, { title: "A", Title: "B" }),
    ).toThrow("supplied more than once");
    expect(() =>
      normalizePropertyFields(structure, { Updated: "2026-07-25" }),
    ).toThrow("read-only");
  });

  test("treats lastUpdatedAt as read-only even if the upstream catalog says writable", () => {
    const inconsistent = {
      ...structure,
      propertyDefinitions: structure.propertyDefinitions.map((definition) =>
        definition.type === "lastUpdatedAt"
          ? { ...definition, writable: true }
          : definition,
      ),
    };
    const guideField = createAgentWriteGuide(inconsistent).fields.find(
      ({ type }) => type === "lastUpdatedAt",
    );

    expect(guideField?.writable).toBe(false);
    expect(() =>
      normalizePropertyFields(inconsistent, { Updated: "2026-07-25" }),
    ).toThrow("read-only");
  });
});

describe("daily-note dates", () => {
  test("canonicalizes real dates to UTC midnight", () => {
    expect(canonicalDailyDate("2026-07-25")).toBe("2026-07-25T00:00:00.000Z");
  });

  test("rejects impossible dates", () => {
    expect(() => canonicalDailyDate("2026-02-30")).toThrow(
      "real calendar date",
    );
  });
});
