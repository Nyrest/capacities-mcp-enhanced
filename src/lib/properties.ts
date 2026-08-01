import type {
  SpacePropertyDefinition,
  SpaceStructure,
  WritableApiToken,
  WritableObjectProperties,
  WritableObjectPropertyValue,
} from "@capacities/api";
import type { AgentPropertyValue } from "./schemas";

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function comparable(value: string): string {
  return value.trim().toLocaleLowerCase();
}

export function isAgentWritableProperty(
  definition: SpacePropertyDefinition,
): boolean {
  return definition.writable && definition.type !== "lastUpdatedAt";
}

function uniqueById<T extends { id: string }>(values: T[]): T[] {
  return [...new Map(values.map((value) => [value.id, value])).values()];
}

export function resolveStructure(
  structures: SpaceStructure[],
  identifier: string,
): SpaceStructure {
  const exactId = structures.find(({ id }) => id === identifier);
  if (exactId) {
    return exactId;
  }

  const target = comparable(identifier);
  const matches = uniqueById(
    structures.filter(
      ({ title, pluralName }) =>
        comparable(title) === target || comparable(pluralName) === target,
    ),
  );

  if (matches.length === 1) {
    return matches[0];
  }

  if (matches.length > 1) {
    throw new Error(
      `Structure "${identifier}" is ambiguous. Use one of these IDs: ${matches
        .map(({ id }) => id)
        .join(", ")}.`,
    );
  }

  throw new Error(
    `Unknown structure "${identifier}". Call inspect_space to list valid structure IDs and names.`,
  );
}

export function assertStandardObjectCreateSupported(
  structure: SpaceStructure,
): void {
  const createTool = structureCreateTool(structure);
  if (createTool !== "create_object") {
    const hint =
      createTool === "create_object_from_url"
        ? " Use create_object_from_url for weblinks."
        : " This built-in structure is read-only or requires an API endpoint not exposed by this server.";
    throw new Error(
      `Standard object creation is not supported for ${structure.title} (${structure.id}).${hint}`,
    );
  }
}

export function structureCreateTool(
  structure: Pick<SpaceStructure, "id">,
): "create_object" | "create_object_from_url" | null {
  if (
    UUID.test(structure.id) ||
    ["RootPage", "RootTag", "RootTask"].includes(structure.id)
  ) {
    return "create_object";
  }
  return structure.id === "MediaWebResource" ? "create_object_from_url" : null;
}

function resolveProperty(
  structure: SpaceStructure,
  identifier: string,
): SpacePropertyDefinition {
  const exactId = structure.propertyDefinitions.find(
    ({ id }) => id === identifier,
  );
  if (exactId) {
    return exactId;
  }

  const target = comparable(identifier);
  const matches = uniqueById(
    structure.propertyDefinitions.filter(
      ({ name }) => comparable(name) === target,
    ),
  );

  if (matches.length === 1) {
    return matches[0];
  }

  if (matches.length > 1) {
    throw new Error(
      `Property "${identifier}" is ambiguous on ${structure.title}. Use one of these IDs: ${matches
        .map(({ id }) => id)
        .join(", ")}.`,
    );
  }

  throw new Error(
    `Unknown property "${identifier}" on ${structure.title}. Call inspect_space with structure="${structure.id}" to see valid fields.`,
  );
}

function toIsoDatetime(value: string, field: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${field} must be a valid ISO date or datetime.`);
  }
  return date.toISOString();
}

function toUtcMidnight(value: string, field: string): string {
  if (DATE_ONLY.test(value)) {
    const date = new Date(`${value}T00:00:00.000Z`);
    if (
      Number.isNaN(date.getTime()) ||
      date.toISOString().slice(0, 10) !== value
    ) {
      throw new Error(`${field} must be a real calendar date.`);
    }
    return `${value}T00:00:00.000Z`;
  }

  const iso = toIsoDatetime(value, field);
  if (!iso.endsWith("T00:00:00.000Z")) {
    throw new Error(
      `${field} must be UTC midnight when resolution is "day". Prefer YYYY-MM-DD.`,
    );
  }
  return iso;
}

function normalizeDate(value: AgentPropertyValue) {
  if (value === null) {
    return { start: null };
  }

  if (typeof value === "string") {
    const isDay = DATE_ONLY.test(value);
    return {
      dateResolution: isDay ? ("day" as const) : ("time" as const),
      start: isDay
        ? toUtcMidnight(value, "date")
        : toIsoDatetime(value, "date"),
    };
  }

  if (
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("start" in value)
  ) {
    throw new Error(
      "Date properties require an ISO string, a date object, or null.",
    );
  }

  const resolution =
    value.dateResolution ?? (DATE_ONLY.test(value.start) ? "day" : "time");
  const normalize = resolution === "day" ? toUtcMidnight : toIsoDatetime;

  return {
    dateResolution: resolution,
    start: normalize(value.start, "date.start"),
    ...(value.end !== undefined
      ? {
          end: value.end === null ? null : normalize(value.end, "date.end"),
        }
      : {}),
  };
}

function strings(value: AgentPropertyValue, propertyName: string): string[] {
  if (value === null) {
    return [];
  }
  const values = Array.isArray(value) ? value : [value];
  if (!values.every((item) => typeof item === "string" && item.length > 0)) {
    throw new Error(`${propertyName} requires a string or string array.`);
  }
  return values as string[];
}

function richTextTokens(
  value: AgentPropertyValue,
  propertyName: string,
): WritableApiToken[] {
  if (!Array.isArray(value)) {
    throw new Error(
      `${propertyName} requires a string, a documented text-token array, or null.`,
    );
  }

  if (
    !value.every(
      (token) =>
        typeof token === "object" &&
        token !== null &&
        "type" in token &&
        ["TextToken", "LinkToken", "MathToken", "CodeToken"].includes(
          token.type,
        ),
    )
  ) {
    throw new Error(
      `${propertyName} requires documented TextToken, LinkToken, MathToken, or CodeToken values.`,
    );
  }

  return value as WritableApiToken[];
}

function normalizeLabel(
  definition: SpacePropertyDefinition,
  value: AgentPropertyValue,
) {
  const requested = strings(value, definition.name);
  const options = definition.labelSet ?? [];
  const selected = requested.map((identifier) => {
    const option =
      options.find(({ id }) => id === identifier) ??
      options.find(({ name }) => comparable(name) === comparable(identifier));

    if (!option) {
      const available = options.map(({ name }) => name).join(", ");
      throw new Error(
        `Unknown label "${identifier}" for ${definition.name}. Available labels: ${available || "(none)"}.`,
      );
    }

    return option;
  });

  if (definition.multiple === false && selected.length > 1) {
    throw new Error(`${definition.name} accepts only one label.`);
  }

  return selected;
}

function normalizeValue(
  definition: SpacePropertyDefinition,
  value: AgentPropertyValue,
): WritableObjectPropertyValue {
  switch (definition.type) {
    case "title":
      if (value !== null && typeof value !== "string") {
        throw new Error(`${definition.name} requires a string or null.`);
      }
      return { type: "title", title: { value } };
    case "text":
      if (value !== null && typeof value !== "string") {
        throw new Error(`${definition.name} requires a string or null.`);
      }
      return { type: "text", text: { value } };
    case "number":
      if (value !== null && typeof value !== "number") {
        throw new Error(`${definition.name} requires a number or null.`);
      }
      return { type: "number", number: { value } };
    case "boolean":
      if (value !== null && typeof value !== "boolean") {
        throw new Error(`${definition.name} requires a boolean or null.`);
      }
      return { type: "boolean", boolean: { value } };
    case "url":
      if (value !== null && typeof value !== "string") {
        throw new Error(`${definition.name} requires a URL string or null.`);
      }
      if (typeof value === "string") {
        try {
          new URL(value);
        } catch {
          throw new Error(
            `${definition.name} requires a valid absolute URL or null.`,
          );
        }
      }
      return { type: "url", url: { value } };
    case "date":
      return { type: "date", date: normalizeDate(value) };
    case "label":
      return { type: "label", label: normalizeLabel(definition, value) };
    case "entity": {
      const ids = strings(value, definition.name);
      const invalidId = ids.find((id) => !UUID.test(id));
      if (invalidId) {
        throw new Error(
          `${definition.name} requires Capacities object UUIDs; "${invalidId}" is invalid. Search for the object first.`,
        );
      }
      return {
        type: "entity",
        entity: ids.map((id) => ({ id })),
      };
    }
    case "aliases": {
      const aliases = strings(value, definition.name);
      if (aliases.length > 8) {
        throw new Error(`${definition.name} accepts at most 8 aliases.`);
      }
      return {
        type: "aliases",
        aliases: { value: aliases },
      };
    }
    case "icon":
      if (value === null) {
        return { type: "icon", icon: { value: null } };
      }
      if (
        typeof value !== "object" ||
        Array.isArray(value) ||
        !("type" in value) ||
        !("value" in value)
      ) {
        throw new Error(
          `${definition.name} requires { type: "emoji" | "iconify", value: string } or null.`,
        );
      }
      return {
        type: "icon",
        icon: { value: { type: value.type, val: value.value } },
      };
    case "createdAt":
      if (typeof value !== "string") {
        throw new Error(`${definition.name} requires an ISO datetime string.`);
      }
      return {
        type: "createdAt",
        createdAt: { value: toIsoDatetime(value, definition.name) },
      };
    case "richText":
      if (value === null) {
        return { type: "richText", richText: { value: [] } };
      }
      if (typeof value !== "string") {
        return {
          type: "richText",
          richText: { value: richTextTokens(value, definition.name) },
        };
      }
      return {
        type: "richText",
        richText: {
          value: [{ type: "TextToken", text: value, style: {} }],
        },
      };
    case "lastUpdatedAt":
      throw new Error(`${definition.name} is read-only.`);
  }
}

export function normalizePropertyFields(
  structure: SpaceStructure,
  fields: Record<string, AgentPropertyValue>,
): WritableObjectProperties {
  const output: WritableObjectProperties = {};
  const seen = new Set<string>();

  for (const [identifier, value] of Object.entries(fields)) {
    const definition = resolveProperty(structure, identifier);

    if (!isAgentWritableProperty(definition)) {
      throw new Error(
        `Property "${definition.name}" (${definition.id}) is read-only.`,
      );
    }
    if (seen.has(definition.id)) {
      throw new Error(
        `Property "${definition.name}" was supplied more than once by name/ID.`,
      );
    }

    output[definition.id] = normalizeValue(definition, value);
    seen.add(definition.id);
  }

  return output;
}

function acceptedInput(definition: SpacePropertyDefinition): string {
  switch (definition.type) {
    case "title":
    case "text":
      return "string | null";
    case "number":
      return "number | null";
    case "boolean":
      return "boolean | null";
    case "url":
      return "absolute URL string | null";
    case "date":
      return 'YYYY-MM-DD | ISO datetime | { start, end?, dateResolution?: "day" | "time" } | null';
    case "label":
      return definition.multiple === false
        ? "one discovered label option name/ID | null"
        : "discovered label option name/ID | array | null";
    case "entity":
      return "Capacities object UUID | UUID array | null";
    case "aliases":
      return "string | string[] (maximum 8) | null";
    case "icon":
      return '{ type: "emoji", value: string } | { type: "iconify", value: regular Phosphor ph-name } | null';
    case "createdAt":
      return "ISO datetime string";
    case "richText":
      return "string | documented text-token array | null";
    case "lastUpdatedAt":
      return "read-only";
  }
}

export function createAgentWriteGuide(structure: SpaceStructure) {
  return {
    structureId: structure.id,
    createTool: structureCreateTool(structure),
    rules: [
      "Use property IDs as field keys when possible; UI names are accepted only as a convenience.",
      "Only writable fields may be sent. Supplied values replace that property; omitted fields remain unchanged.",
      "Search for related objects first and pass their UUIDs to entity fields.",
      "Use only label names or IDs listed in labelOptions.",
    ],
    fields: structure.propertyDefinitions.map((definition) => ({
      id: definition.id,
      name: definition.name,
      type: definition.type,
      writable: isAgentWritableProperty(definition),
      acceptedInput: acceptedInput(definition),
      ...(definition.multiple === undefined
        ? {}
        : { multiple: definition.multiple }),
      ...(definition.labelSet
        ? {
            labelOptions: definition.labelSet.map(({ id, name }) => ({
              id,
              name,
            })),
          }
        : {}),
      ...(definition.allowedStructures
        ? { allowedStructures: definition.allowedStructures }
        : {}),
    })),
  };
}

export function canonicalDailyDate(date: string): string {
  return toUtcMidnight(date, "date");
}
