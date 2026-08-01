import type { ApiBlock, GetObjectResponse } from "@capacities/api";

export type MarkdownLossIssue = {
  code: string;
  feature:
    | "underline_style"
    | "html_details_toggle"
    | "grid_layout"
    | "html_background_color"
    | "entity_link_visible_text"
    | "unsupported_block";
  severity: "warning";
  source: "preflight" | "readback";
  persistedAs: string;
  blockId?: string;
  entityId?: string;
  inferredVisibleText?: string;
};

export type MarkdownLossReport = {
  analysisLevel: "preflight_and_readback" | "preflight_only";
  analysisMethod: "syntax_heuristic";
  detectedLosses: MarkdownLossIssue[];
  entityLinks: MarkdownEntityLinkReport[];
};

export type MarkdownEntityLinkReport = {
  source: string;
  label: string;
  outcome: "converted" | "literalized";
  reason?:
    | "bare_hashtag_not_supported"
    | "non_standalone_link"
    | "empty_visible_text"
    | "wrong_space"
    | "target_not_found"
    | "conversion_failed"
    | "async_not_supported";
  entityId?: string;
  blockId?: string;
};

export type PreparedMarkdownEntity = {
  marker: string;
  label: string;
  entityId: string;
  source: string;
};

export type PreparedMarkdown = {
  markdown: string;
  entities: PreparedMarkdownEntity[];
  entityLinks: MarkdownEntityLinkReport[];
};

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STANDALONE_ENTITY_LINK =
  /^(\s*)\[([^\]\r\n]*)\]\(https:\/\/app\.capacities\.io\/([^/\s]+)\/([^/\s)]+)\/?\)(\s*)$/i;
const ANY_ENTITY_LINK =
  /\[([^\]\r\n]*)\]\(https:\/\/app\.capacities\.io\/([^/\s]+)\/([^/\s)]+)\/?\)/gi;

function literalizeSegment(segment: string): string {
  return segment
    .replace(ANY_ENTITY_LINK, (_match, label: string) => label)
    .replace(/(^|[\s(])#([^\s#]+)/g, "$1\\#$2");
}

export async function prepareMarkdownEntities(
  markdown: string,
  options: {
    spaceId: string;
    objectExists: (id: string) => Promise<boolean>;
    convertEntities?: boolean;
  },
): Promise<PreparedMarkdown> {
  const entities: PreparedMarkdownEntity[] = [];
  const entityLinks: MarkdownEntityLinkReport[] = [];
  const existence = new Map<string, boolean>();
  let entityIndex = 0;

  const segments = markdown.split(/(```[\s\S]*?```|`[^`\r\n]*`)/g);
  const output: string[] = [];
  for (const segment of segments) {
    if (/^```[\s\S]*```$/.test(segment) || /^`[^`\r\n]*`$/.test(segment)) {
      output.push(segment);
      continue;
    }

    const lineEnding = segment.includes("\r\n") ? "\r\n" : "\n";
    const lines = segment.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const match = line.match(STANDALONE_ENTITY_LINK);
      if (match) {
        const [, prefix, label, spaceId, entityId, suffix] = match;
        const source = line;
        const trimmedLabel = label.trim();
        let outcome: MarkdownEntityLinkReport | undefined;
        if (!trimmedLabel) {
          outcome = {
            source,
            label,
            outcome: "literalized",
            reason: "empty_visible_text",
          };
        } else if (spaceId !== options.spaceId) {
          outcome = {
            source,
            label,
            outcome: "literalized",
            reason: "wrong_space",
            entityId,
          };
        } else if (!UUID.test(entityId)) {
          outcome = {
            source,
            label,
            outcome: "literalized",
            reason: "target_not_found",
            entityId,
          };
        } else if (options.convertEntities === false) {
          outcome = {
            source,
            label,
            outcome: "literalized",
            reason: "async_not_supported",
            entityId,
          };
        } else {
          let exists = existence.get(entityId);
          if (exists === undefined) {
            exists = await options.objectExists(entityId);
            existence.set(entityId, exists);
          }
          if (!exists) {
            outcome = {
              source,
              label,
              outcome: "literalized",
              reason: "target_not_found",
              entityId,
            };
          }
        }

        if (outcome) {
          entityLinks.push(outcome);
          lines[index] = literalizeSegment(line);
        } else {
          const marker = `capacities-mcp-entity-${entityIndex}-${entityId}`;
          entityIndex += 1;
          entities.push({ marker, label: trimmedLabel, entityId, source });
          entityLinks.push({
            source,
            label: trimmedLabel,
            outcome: "converted",
            entityId,
          });
          lines[index] = `${prefix}${marker}${suffix}`;
        }
        continue;
      }

      ANY_ENTITY_LINK.lastIndex = 0;
      if (ANY_ENTITY_LINK.test(line) || /(^|[\s(])#[^\s#]+/.test(line)) {
        const source = line;
        ANY_ENTITY_LINK.lastIndex = 0;
        const links = [...line.matchAll(ANY_ENTITY_LINK)].map((item) => ({
          source: item[0],
          label: item[1],
        }));
        for (const link of links) {
          entityLinks.push({
            source: link.source,
            label: link.label,
            outcome: "literalized",
            reason: "non_standalone_link",
          });
        }
        const hashtags = [...line.matchAll(/(^|[\s(])#([^\s#]+)/g)];
        for (const hashtag of hashtags) {
          entityLinks.push({
            source: hashtag[0].trim(),
            label: hashtag[2],
            outcome: "literalized",
            reason: "bare_hashtag_not_supported",
          });
        }
        lines[index] = literalizeSegment(line);
        if (
          source === lines[index] &&
          links.length === 0 &&
          hashtags.length === 0
        ) {
          lines[index] = line;
        }
      }
    }
    output.push(lines.join(lineEnding));
  }

  return { markdown: output.join(""), entities, entityLinks };
}

function sourceIssue(
  code: string,
  feature: MarkdownLossIssue["feature"],
  persistedAs: string,
): MarkdownLossIssue {
  return {
    code,
    feature,
    severity: "warning",
    source: "preflight",
    persistedAs,
  };
}

function maskCodeRegions(markdown: string): string {
  const tick = String.fromCharCode(96);
  const fence = tick.repeat(3);
  const fenced = new RegExp(`${fence}[\\s\\S]*?${fence}`, "g");
  const inline = new RegExp(`${tick}[^${tick}\\r\\n]*${tick}`, "g");
  return markdown
    .replace(fenced, (match) => " ".repeat(match.length))
    .replace(inline, (match) => " ".repeat(match.length));
}

function analyzeSource(markdown: string): MarkdownLossIssue[] {
  const issues: MarkdownLossIssue[] = [];
  const source = maskCodeRegions(markdown);

  if (/__[^_\r\n]+__/.test(source)) {
    issues.push(
      sourceIssue(
        "markdown_double_underscore_is_strong",
        "underline_style",
        "CommonMark strong/bold text",
      ),
    );
  }
  if (/<(?:details|summary)\b/i.test(source)) {
    issues.push(
      sourceIssue(
        "markdown_html_details_not_toggle",
        "html_details_toggle",
        "ordinary text or flattened HTML",
      ),
    );
  }
  if (
    /^\s*\|?.+\|.+\r?\n\s*\|?\s*:?-{3,}/m.test(source) ||
    /<table\b/i.test(source)
  ) {
    issues.push(
      sourceIssue(
        "markdown_table_not_grid",
        "grid_layout",
        "non-grid Markdown content",
      ),
    );
  }
  if (/background(?:-color)?\s*:|class\s*=\s*["'][^"']*\bbg-/i.test(source)) {
    issues.push(
      sourceIssue(
        "markdown_background_color_not_preserved",
        "html_background_color",
        "unstyled or approximately styled content",
      ),
    );
  }
  return issues;
}

function visitBlocks(
  blocks: ApiBlock[],
  visitor: (block: ApiBlock) => void,
): void {
  for (const block of blocks) {
    visitor(block);
    if (block.type === "TextBlock" || block.type === "GroupBlock") {
      visitBlocks(block.blocks, visitor);
    } else if (block.type === "GridBlock") {
      for (const column of block.columns) {
        visitBlocks(column, visitor);
      }
    }
  }
}

function analyzeReadback(
  markdown: string,
  object: GetObjectResponse,
  blockScope?: Set<string>,
): MarkdownLossIssue[] {
  const issues: MarkdownLossIssue[] = [];
  const labels = [...markdown.matchAll(/(?:^|\s)#([^\s#]+)/g)].map(
    (match) => match[1],
  );
  const emptyEntityRefs: Array<{ blockId: string; entityId: string }> = [];

  for (const blocks of Object.values(object.blocks ?? {})) {
    visitBlocks(blocks, (block) => {
      if (blockScope && !blockScope.has(block.id)) {
        return;
      }
      if (block.type === "unsupported") {
        issues.push({
          code: "markdown_persisted_as_unsupported_block",
          feature: "unsupported_block",
          severity: "warning",
          source: "readback",
          persistedAs: `unsupported/${block.blockType}`,
          blockId: block.id,
        });
        return;
      }
      if (block.type !== "TextBlock") {
        return;
      }
      for (const token of block.tokens) {
        if (
          token.type === "LinkToken" &&
          "entityId" in token &&
          token.entityId &&
          token.text.length === 0
        ) {
          emptyEntityRefs.push({
            blockId: block.id,
            entityId: token.entityId,
          });
        }
      }
    });
  }

  for (const ref of emptyEntityRefs) {
    issues.push({
      code: "markdown_entity_link_empty_text",
      feature: "entity_link_visible_text",
      severity: "warning",
      source: "readback",
      persistedAs: "LinkToken with entityId and empty text",
      blockId: ref.blockId,
      entityId: ref.entityId,
      ...(emptyEntityRefs.length === 1 && labels.length === 1
        ? { inferredVisibleText: labels[0] }
        : {}),
    });
  }
  return issues;
}

export function createMarkdownLossReport(
  markdown: string,
  object?: GetObjectResponse,
  blockIds?: string[],
  entityLinks: MarkdownEntityLinkReport[] = [],
): MarkdownLossReport {
  const entityLosses = entityLinks
    .filter(({ outcome }) => outcome === "literalized")
    .map((link) => ({
      code: `markdown_entity_${link.reason}`,
      feature: "entity_link_visible_text" as const,
      severity: "warning" as const,
      source: "preflight" as const,
      persistedAs: "literal Markdown text",
      entityId: link.entityId,
      inferredVisibleText: link.label || undefined,
    }));
  return {
    analysisLevel: object ? "preflight_and_readback" : "preflight_only",
    analysisMethod: "syntax_heuristic",
    detectedLosses: [
      ...analyzeSource(markdown),
      ...entityLosses,
      ...(object
        ? analyzeReadback(
            markdown,
            object,
            blockIds ? new Set(blockIds) : undefined,
          )
        : []),
    ],
    entityLinks,
  };
}
