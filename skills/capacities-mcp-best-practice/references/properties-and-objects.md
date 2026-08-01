# Structures, Objects, Properties, and Collections

Use the live `inspect_space` result as the final authority. This reference explains how to interpret it and how to construct values that tool schemas cannot fully constrain.

## Contents

- [Discover before writing](#discover-before-writing)
- [Object and collection semantics](#object-and-collection-semantics)
- [Field map rules](#field-map-rules)
- [Property value schemas](#property-value-schemas)
- [Dates and time](#dates-and-time)
- [Labels, entities, aliases, and icons](#labels-entities-aliases-and-icons)
- [Preflight checklist](#preflight-checklist)

## Discover before writing

A Capacities structure is an object type. Page, Tag, and Task are structures; users can define custom structures. Every structure has a unique `structureId` and property definitions.

Before writing:

1. Call `inspect_space` without `structure` to list the available structures.
2. Select by ID when names are duplicated or translated.
3. Call `inspect_space` with the selected structure to get its current property definitions and write guide.
4. Read each property's `id`, `name`, `type`, `writable`, `multiple`, allowed structures, and `labelOptions` where present.
5. Resolve related objects and collection IDs before constructing the mutation.

Do not rely on a structure catalog from an earlier session if the user may have changed their schema. Use `refresh: true` only when a refresh is actually needed.

## Object and collection semantics

An object read may contain:

- `id`: stable object UUID.
- `structureId`: the object's type.
- `properties`: typed values, including built-in metadata.
- `collections`: collection UUIDs.
- `blocks`: main body block tree.
- `files` or `mediaContent`: structure-dependent media data.

Collection behavior:

- Omit `collections` to leave collection handling unchanged or use the API default during creation.
- Supplying `collections` replaces the complete collection membership.
- Supplying `[]` selects the structure's default collection behavior; it does not mean “preserve current memberships.”
- Use only collection UUIDs obtained from live Capacities data.

The `title` parameter is object metadata and is separate from body text. Do not try to set the title by adding a heading block.

## Field map rules

`fields` is an object whose keys identify writable properties:

```json
{
  "fields": {
    "property-uuid-or-id": "value",
    "Exact Unique Property Name": "value"
  }
}
```

Use property IDs whenever possible. Exact property names are acceptable only when the live definition resolves them unambiguously.

Mutation semantics:

- A supplied property replaces that property's complete current value.
- An omitted property remains unchanged.
- Use `null` or an empty list only where the property type documents it as a clear operation.
- Do not send the same property once by ID and once by name.
- Do not send read-only properties, even if they appear in `get_object`.
- `lastUpdatedAt` is read-only.
- `createdAt` is writable only if the live write guide explicitly marks it writable.

## Property value schemas

### Title and text

```json
"A text value"
```

Use a string to set and `null` to clear where the live definition permits clearing. Keep object titles one line.

### Number

```json
42.5
```

Use a JSON number, not a numeric string. Use `null` to clear.

### Boolean

```json
true
```

Use a JSON boolean, not `"true"` or `1`. Use `null` to clear if allowed.

### URL

```json
"https://example.com/path"
```

Use an absolute HTTP or HTTPS URL. Use `null` to clear.

### Date

Accepted compact form:

```json
"2026-08-01"
```

Accepted interval form:

```json
{
  "start": "2026-08-01",
  "end": "2026-08-03",
  "dateResolution": "day"
}
```

Time-resolution example:

```json
{
  "start": "2026-08-01T09:30:00+08:00",
  "end": "2026-08-01T10:30:00+08:00",
  "dateResolution": "time"
}
```

Use `null` to clear. See [Dates and time](#dates-and-time) for resolution rules.

### Label

Single-valued label:

```json
"Existing option name or option ID"
```

Multiple label:

```json
["Existing option ID 1", "Existing option ID 2"]
```

Use only values in the live `labelOptions` catalog. Use `null` for a single-valued clear and `[]` for a multiple-valued clear.

### Entity relation

Single-valued entity:

```json
"4adf46c0-8c53-4c62-b780-36d9b54c84a2"
```

Multiple entity relation:

```json
[
  "4adf46c0-8c53-4c62-b780-36d9b54c84a2",
  "41d747e0-cb80-45e0-b718-5651f26c82cb"
]
```

Targets must exist in the same space and match the property's allowed structures. Use `null` or `[]` to clear according to multiplicity.

### Aliases

```json
["Short name", "Previous title"]
```

The MCP accepts one string or an array, with at most eight aliases. Use `null` to clear. Avoid duplicating the current title.

### Icon

Emoji:

```json
{
  "type": "emoji",
  "value": "🧭"
}
```

Iconify/Phosphor:

```json
{
  "type": "iconify",
  "value": "ph-compass"
}
```

For `iconify`, use only a regular Phosphor identifier beginning with `ph-`. Do not use style suffixes such as `-duotone`, `-fill`, `-bold`, `-light`, or `-thin`. Use `null` to clear the icon.

### Rich text

A writable rich-text property can accept plain text or a strict token array, depending on the live guide:

```json
"Plain rich text"
```

or:

```json
[
  {
    "type": "TextToken",
    "text": "Styled text",
    "style": { "bold": true }
  }
]
```

Use the token schemas in [structural-content.md](structural-content.md). Use `null` to clear when allowed.

## Dates and time

Capacities distinguishes day-resolution dates from time-resolution timestamps.

- Prefer `YYYY-MM-DD` for a calendar day.
- A day-resolution date is represented by the API at UTC midnight. Do not shift it based on local timezone after the user selected the calendar day.
- Use an ISO 8601 timestamp with an explicit offset for time-resolution values.
- If `end` is present, it must use the same effective resolution as `start`.
- Do not send an impossible date such as `2026-02-30`.
- Daily Note `date` is always a `YYYY-MM-DD` calendar date and is not a property date object.

When a user says “today,” resolve the calendar date in the user's timezone, then send the resulting date string.

## Labels, entities, aliases, and icons

These values are frequent sources of invalid payloads because their valid choices are not globally enumerable in a static schema.

### Labels

- Never invent a label option merely because its text seems plausible.
- Match live options by ID first, then exact name.
- If the requested label does not exist, explain that the MCP cannot create a new option through this field write. Ask whether to use an existing option or leave it unchanged.

### Entity properties

- Search by title, restrict by allowed structure when possible, and read the candidate.
- Use the target UUID, not its title or Capacities URL.
- Multiple values replace the entire relation list; include existing targets that should remain.

### Aliases

- Aliases aid discovery; they are not relations.
- Keep them concise and semantically equivalent to the object.
- Respect the maximum of eight.

### Icons

- Emoji values must be nonempty.
- Iconify support is intentionally narrower than arbitrary Iconify collections: use regular `ph-*` IDs only.
- If unsure whether an icon ID exists, prefer an emoji or omit the icon instead of inventing an identifier.

## Preflight checklist

Before `create_object`, `create_object_markdown`, or `update_object`, verify:

- [ ] Structure resolved from live `inspect_space` output.
- [ ] Every field key resolves to one writable property exactly once.
- [ ] Value type and single/multiple cardinality match the property.
- [ ] Label options come from the live catalog.
- [ ] Entity UUIDs exist in the same space and use allowed structures.
- [ ] Dates use the intended day/time resolution.
- [ ] Collection UUIDs are live and the replacement semantics are intended.
- [ ] Icon is emoji or a regular `ph-*` identifier.
- [ ] Read-only timestamps are omitted.

Official concepts: [Structures](https://developers.capacities.io/api/concepts/structures), [Properties](https://developers.capacities.io/api/concepts/properties), and [Objects](https://developers.capacities.io/api/concepts/objects).
