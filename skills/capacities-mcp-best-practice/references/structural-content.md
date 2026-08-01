# Structural Blocks and Text Tokens

Use structural tools when exact block type, hierarchy, nesting, layout, style, color, or object linkage matters. The MCP accepts a strict documented subset; extra keys are rejected.

## Contents

- [Construction rules](#construction-rules)
- [Token schemas](#token-schemas)
- [Block schemas](#block-schemas)
- [Exact option catalogs](#exact-option-catalogs)
- [Append, update, and delete semantics](#append-update-and-delete-semantics)
- [Validated patterns](#validated-patterns)
- [Structural preflight](#structural-preflight)

## Construction rules

- New blocks and replacement payloads must not contain block IDs. Capacities assigns IDs.
- Use only the seven writable block types listed below.
- Rich text is an ordered `tokens` array. Preserve token order.
- Objects use strict schemas: omit unsupported or unknown keys instead of guessing.
- `LinkToken` must have exactly one target: `url` or `entityId`.
- A nested block tree is recursive. Deleting a parent deletes its whole subtree.
- Use structured `get_object` before an exact edit. Copy only fields the writable schema accepts.

## Token schemas

### Text token

```json
{
  "type": "TextToken",
  "text": "Important text",
  "style": {
    "bold": true,
    "italic": false,
    "strikethrough": false,
    "underline": true
  },
  "color": "text-blue"
}
```

Required: `type`, `text`, and `style`. The style object may be empty:

```json
{ "type": "TextToken", "text": "Plain text", "style": {} }
```

Allowed style keys are exactly `bold`, `italic`, `strikethrough`, and `underline`, each boolean. `color` is optional and must be one of the exact color values below.

### External URL link token

```json
{
  "type": "LinkToken",
  "text": "Capacities documentation",
  "url": "https://developers.capacities.io/"
}
```

The URL must be absolute HTTP or HTTPS. Do not add `entityId`.

### Entity link token

```json
{
  "type": "LinkToken",
  "text": "Project Atlas",
  "entityId": "4adf46c0-8c53-4c62-b780-36d9b54c84a2"
}
```

Resolve and verify the object UUID first. Use meaningful nonempty visible text. Do not add `url`.

### Inline math token

```json
{ "type": "MathToken", "text": "E = mc^2" }
```

### Inline code token

```json
{ "type": "CodeToken", "text": "bun test" }
```

The MCP does not expose date-backed link tokens. Use property dates or plain text instead.

## Block schemas

### TextBlock

```json
{
  "type": "TextBlock",
  "tokens": [
    { "type": "TextToken", "text": "A paragraph", "style": {} }
  ],
  "blocks": [],
  "hierarchy": { "key": "Base", "val": 0 },
  "list": null,
  "todo": { "isDone": false },
  "toggle": { "isOpen": true },
  "quote": { "layout": "normal" },
  "colorTheme": "bg-yellow"
}
```

Only `type` is universally required. Include optional features only when intended:

- `tokens`: inline rich text.
- `blocks`: nested child blocks.
- `hierarchy`: paragraph or heading level.
- `list`: list marker or `null`.
- `todo`: checkbox state.
- `toggle`: toggle state or `null`.
- `quote`: quote layout.
- `colorTheme`: text or background color.

Do not add unsupported text-alignment or highlight fields.

### GroupBlock

```json
{
  "type": "GroupBlock",
  "blocks": [
    {
      "type": "TextBlock",
      "tokens": [
        { "type": "TextToken", "text": "Grouped content", "style": {} }
      ]
    }
  ],
  "toggle": { "isOpen": false },
  "colorTheme": "bg-gray"
}
```

Allowed optional keys: `blocks`, `list`, `todo`, `toggle`, and `colorTheme`. GroupBlock has no `tokens`, `hierarchy`, or `quote`.

### GridBlock

```json
{
  "type": "GridBlock",
  "columns": [
    [
      {
        "type": "TextBlock",
        "tokens": [
          { "type": "TextToken", "text": "Left", "style": {} }
        ]
      }
    ],
    [
      {
        "type": "TextBlock",
        "tokens": [
          { "type": "TextToken", "text": "Right", "style": {} }
        ]
      }
    ]
  ],
  "dividers": [0.5],
  "gridLayout": "columns"
}
```

`dividers` is required. `columns`, when supplied, must contain at least two arrays of blocks. `gridLayout` is `"columns"` or `"grid"`. For an existing GridBlock, preserve its divider values unless the user explicitly asks to change proportions. For a new two-column equal layout, `[0.5]` is the validated pattern.

### CodeBlock

```json
{
  "type": "CodeBlock",
  "lang": "typescript",
  "text": "const answer = 42;"
}
```

Both `lang` and `text` are required. Use a language identifier accepted by Capacities; use an empty language string only if the user does not need syntax highlighting and the tool schema permits it.

### MathBlock

```json
{
  "type": "MathBlock",
  "text": "\\int_0^1 x^2 dx = \\frac{1}{3}",
  "colorTheme": "text-purple"
}
```

`text` is required. `colorTheme` is optional.

### EntityBlock

```json
{
  "type": "EntityBlock",
  "entityId": "4adf46c0-8c53-4c62-b780-36d9b54c84a2"
}
```

`entityId` must be a non-null UUID for an existing object. An EntityBlock embeds an object; it is different from an inline entity LinkToken.

### HorizontalLineBlock

```json
{ "type": "HorizontalLineBlock" }
```

No other keys are accepted.

## Exact option catalogs

### Hierarchy pairs

The key and value must match exactly:

| Meaning | Value |
|---|---|
| Paragraph/base | `{ "key": "Base", "val": 0 }` |
| Heading 1 | `{ "key": "H1", "val": 1 }` |
| Heading 2 | `{ "key": "H2", "val": 2 }` |
| Heading 3 | `{ "key": "H3", "val": 3 }` |

Do not use `heading`, `paragraph`, H4+, or a mismatched key/value pair.

### List

```json
{ "type": "bullet" }
```

Allowed values: `bullet`, `alphabetical`, `numerical`, `roman`. Use `null` to remove list formatting when updating a block.

### Todo, toggle, and quote

```json
{ "todo": { "isDone": false } }
```

```json
{ "toggle": { "isOpen": true } }
```

```json
{ "quote": { "layout": "standout" } }
```

Quote layouts: `normal`, `standout`. A toggle can be `null` when removing toggle behavior.

### Colors

Allowed text colors:

`text-gray`, `text-rose`, `text-pink`, `text-fuchsia`, `text-purple`, `text-violet`, `text-indigo`, `text-blue`, `text-sky`, `text-cyan`, `text-teal`, `text-emerald`, `text-green`, `text-lime`, `text-yellow`, `text-amber`, `text-orange`, `text-red`

Allowed background colors:

`bg-gray`, `bg-rose`, `bg-pink`, `bg-fuchsia`, `bg-purple`, `bg-violet`, `bg-indigo`, `bg-blue`, `bg-sky`, `bg-cyan`, `bg-teal`, `bg-emerald`, `bg-green`, `bg-lime`, `bg-yellow`, `bg-amber`, `bg-orange`, `bg-red`

Use these exact lowercase strings. Do not send bare color names, hex values, or arbitrary CSS colors.

## Append, update, and delete semantics

### Append placement

- `position: "end"`: append to the selected body/property or the specified parent.
- `position: "start"`: prepend to the selected body/property or the specified parent.
- `position: "after_block"`: insert after `afterBlockId`; do not also send `parentBlockId`.
- `parentBlockId`: valid only for `start` or `end`; the parent must be a TextBlock or GroupBlock.
- `propertyId`: omit for the main body; provide it for another rich-text property.

### Update behavior

- The replacement type must match the existing block type.
- Omit `blocks` on TextBlock or GroupBlock to preserve existing descendants.
- Omit `columns` on GridBlock to preserve existing columns.
- Supplying `blocks` or `columns` replaces the complete child collection; new descendants receive new IDs.
- Do not copy read-only IDs from `get_object` into the replacement `block` payload.

### Delete behavior

`delete_block` removes the selected block and all descendants. Read the structured tree first and confirm the subtree matches user intent.

## Validated patterns

### Heading followed by paragraph

```json
[
  {
    "type": "TextBlock",
    "tokens": [
      { "type": "TextToken", "text": "Summary", "style": { "bold": true } }
    ],
    "hierarchy": { "key": "H2", "val": 2 }
  },
  {
    "type": "TextBlock",
    "tokens": [
      { "type": "TextToken", "text": "The concise summary.", "style": {} }
    ],
    "hierarchy": { "key": "Base", "val": 0 }
  }
]
```

### Mixed rich text with an entity relation

```json
{
  "type": "TextBlock",
  "tokens": [
    { "type": "TextToken", "text": "See ", "style": {} },
    {
      "type": "LinkToken",
      "text": "Project Atlas",
      "entityId": "4adf46c0-8c53-4c62-b780-36d9b54c84a2"
    },
    { "type": "TextToken", "text": " for details.", "style": {} }
  ]
}
```

## Structural preflight

- [ ] Every block uses one documented `type` and no extra keys.
- [ ] New/replacement blocks contain no IDs.
- [ ] Every TextToken has a `style` object.
- [ ] Every LinkToken has exactly one target.
- [ ] Entity UUIDs were discovered and verified.
- [ ] Hierarchy key/value pairs are canonical.
- [ ] Color values come from the exact catalog.
- [ ] Grid has required `dividers` and at least two columns when columns are supplied.
- [ ] Update type matches the existing block.
- [ ] Child arrays are omitted when descendants should be preserved.
- [ ] Block deletion scope includes all descendants.

Official concepts: [Blocks](https://developers.capacities.io/api/concepts/blocks) and [Text Tokens](https://developers.capacities.io/api/concepts/text-tokens).
