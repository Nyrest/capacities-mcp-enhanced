# Markdown, Loss Reporting, and Entity Links

Markdown is the best interface for agent-generated prose, but it is not a lossless serialization of Capacities blocks. Use it deliberately and inspect the returned loss report.

## Contents

- [When Markdown is appropriate](#when-markdown-is-appropriate)
- [Input rules](#input-rules)
- [Known lossy constructs](#known-lossy-constructs)
- [Loss report](#loss-report)
- [Capacities entity links](#capacities-entity-links)
- [Daily Note behavior](#daily-note-behavior)
- [Safe mixed-mode workflow](#safe-mixed-mode-workflow)

## When Markdown is appropriate

Use Markdown for:

- drafting or appending ordinary prose;
- headings, paragraphs, lists, quotes, code fences, and other conventional textual content;
- compact object reads for summarization or semantic analysis;
- large text generation where structural JSON would be unnecessarily verbose.

Use structured blocks instead for:

- exact block updates or deletion by ID;
- Grid layout and column proportions;
- toggle state;
- underline or exact token-level styling;
- text/background colors;
- precise nested block trees;
- EntityBlock embeds;
- exact round-trip preservation.

Typed properties and collections are always separate from body Markdown. Set them with `fields` and `collections`.

## Input rules

- Send real newline characters. Do not send the two literal characters `\` and `n` as line separators.
- Keep Markdown under the tool's 200000-character limit.
- Do not duplicate the object title as an extra heading during Markdown creation unless the user explicitly wants that heading in the body.
- Use fenced code blocks or inline backticks for code. Entity conversion does not inspect code regions.
- Do not assume raw HTML will become a native Capacities component.
- Treat Markdown output from `get_object` as normalized reading context, not as source text for a byte-for-byte patch.

## Known lossy constructs

The MCP performs syntax heuristics before writing and, for synchronous operations, also analyzes readback. These constructs require attention:

| Source construct | What it means in Markdown | Likely persistence | Better choice for exact intent |
|---|---|---|---|
| `__text__` | CommonMark strong emphasis | Bold, not underline | Structured TextToken with `style.underline: true` |
| `<details>` / `<summary>` | Raw HTML | Ordinary text or flattened HTML, not native toggle | Structured TextBlock/GroupBlock with `toggle` |
| Markdown or HTML table | Tabular text | Non-Grid content or unsupported block | Structured GridBlock |
| HTML/CSS background color | Presentation hint | Unstyled or approximate content | Structured `colorTheme: "bg-*"` |
| Unsupported converted block | Converter-dependent | `unsupported/<blockType>` | Replace with documented structural blocks |

This list describes fidelity limits, not server defects. The Capacities API defines Markdown as a compressed representation and recommends blocks for exact structural work.

## Loss report

Markdown mutation results include `lossReport`:

```json
{
  "analysisLevel": "preflight_and_readback",
  "analysisMethod": "syntax_heuristic",
  "detectedLosses": [
    {
      "code": "markdown_table_not_grid",
      "feature": "grid_layout",
      "severity": "warning",
      "source": "preflight",
      "persistedAs": "non-grid Markdown content"
    }
  ],
  "entityLinks": []
}
```

Interpretation:

- `preflight_and_readback`: synchronous operation received both source analysis and persisted-object inspection.
- `preflight_only`: no synchronous object readback was possible, notably Daily Note append.
- `detectedLosses`: likely or observed approximations. A warning does not necessarily mean the write failed.
- `entityLinks`: per-link conversion outcome and reason.
- The analysis is heuristic, not a proof that every Markdown feature round-tripped perfectly.

If a detected loss contradicts user intent, do not silently accept it. Use structural blocks or explain the approximation.

## Capacities entity links

### Preferred structural forms

For exact inline references, use an entity LinkToken:

```json
{
  "type": "LinkToken",
  "text": "Project Atlas",
  "entityId": "4adf46c0-8c53-4c62-b780-36d9b54c84a2"
}
```

For an embedded object, use EntityBlock. Structural `entityId` is authoritative.

### Markdown conversion form

Markdown conversion accepts only an exact standalone line:

```markdown
[Project Atlas](https://app.capacities.io/SPACE_UUID/OBJECT_UUID)
```

All conditions must hold:

- The link is the only meaningful content on its line.
- Visible label is nonempty.
- URL uses `https://app.capacities.io/`.
- Space UUID matches the current space.
- Object UUID is valid and exists.

The MCP first creates a marker and then converts the resulting block to an entity LinkToken. Inspect `entityLinks` for `outcome: "converted"` and the resulting block ID.

These forms remain literal text and produce a warning:

- bare hashtags such as `#ProjectAtlas`;
- an entity URL embedded inside a sentence;
- an empty visible label;
- a link to another space;
- an invalid or missing target object;
- a conversion that could not be completed.

Possible `reason` values include:

- `bare_hashtag_not_supported`
- `non_standalone_link`
- `empty_visible_text`
- `wrong_space`
- `target_not_found`
- `conversion_failed`
- `async_not_supported`

When conversion is essential, search and get the target first. Prefer structural tokens when the reference appears inline with other prose.

## Daily Note behavior

Daily Note append is asynchronous:

- `append_daily_note_markdown` returns `analysisLevel: "preflight_only"`.
- Entity-link conversion is disabled because no synchronous object snapshot is available.
- Entity URLs and hashtags are literalized and reported with `async_not_supported` or another applicable reason.
- A queued response confirms acceptance, not a readback-verified final block tree.

Use structured Daily Note blocks for exact entity tokens or styles only if the Daily Note endpoint supports the intended block form; still report that the append is asynchronous.

## Safe mixed-mode workflow

For a document containing both long prose and exact components:

1. Create or append the ordinary prose with Markdown.
2. Inspect `lossReport` and mutation verification.
3. Call `get_object(format: "structured")` to obtain current block IDs.
4. Add or update exact Grid, toggle, colored, underlined, nested, or entity content with structural tools.
5. Re-read and verify the final structure.

Do not predict block IDs created by Markdown. Always re-read before the structural stage.

Official concept: [Markdown](https://developers.capacities.io/api/concepts/markdown).
