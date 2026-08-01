import {
  type ApiBlock,
  CapacitiesApiError,
  type CapacitiesClient,
  type GetObjectResponse,
  type WritableApiBlock,
  type WritableApiToken,
} from "@capacities/api";
import { apiCall, McpToolError, normalizeError } from "./client";
import {
  type MarkdownEntityLinkReport,
  type PreparedMarkdown,
  type PreparedMarkdownEntity,
  prepareMarkdownEntities,
} from "./markdown";

type LocatedMarker = {
  block: Extract<ApiBlock, { type: "TextBlock" }>;
  blockId: string;
  propertyId: string;
  tokenIndex: number;
  markerIndex: number;
};

function children(block: ApiBlock): ApiBlock[] {
  if (block.type === "TextBlock" || block.type === "GroupBlock") {
    return block.blocks;
  }
  if (block.type === "GridBlock") {
    return block.columns.flat();
  }
  return [];
}

function locateMarker(
  object: GetObjectResponse,
  marker: string,
): LocatedMarker | undefined {
  const found: LocatedMarker[] = [];
  const visit = (blocks: ApiBlock[], propertyId: string) => {
    for (const block of blocks) {
      if (block.type === "TextBlock") {
        block.tokens.forEach((token, tokenIndex) => {
          if (token.type !== "TextToken") {
            return;
          }
          const markerIndex = token.text.indexOf(marker);
          if (markerIndex !== -1) {
            found.push({
              block,
              blockId: block.id,
              propertyId,
              tokenIndex,
              markerIndex,
            });
          }
        });
      }
      visit(children(block), propertyId);
    }
  };

  for (const [propertyId, blocks] of Object.entries(object.blocks ?? {})) {
    visit(blocks, propertyId);
  }
  return found.length === 1 ? found[0] : undefined;
}

function replaceMarkerToken(
  located: LocatedMarker,
  marker: string,
  replacement: WritableApiToken,
): WritableApiBlock {
  const token = located.block.tokens[located.tokenIndex];
  if (token?.type !== "TextToken") {
    throw new Error("The Markdown entity marker was not stored as text.");
  }
  const before = token.text.slice(0, located.markerIndex);
  const after = token.text.slice(located.markerIndex + marker.length);
  const replacementTokens: WritableApiToken[] = [
    ...(before
      ? [{ type: "TextToken" as const, text: before, style: token.style }]
      : []),
    replacement,
    ...(after
      ? [{ type: "TextToken" as const, text: after, style: token.style }]
      : []),
  ];
  return {
    type: "TextBlock" as const,
    tokens: [
      ...(located.block.tokens.slice(
        0,
        located.tokenIndex,
      ) as unknown as WritableApiToken[]),
      ...replacementTokens,
      ...(located.block.tokens.slice(
        located.tokenIndex + 1,
      ) as unknown as WritableApiToken[]),
    ],
  };
}

function updateReport(
  reports: MarkdownEntityLinkReport[],
  entity: PreparedMarkdownEntity,
  patch: Partial<MarkdownEntityLinkReport>,
) {
  const report = reports.find(
    (item) =>
      item.source === entity.source && item.entityId === entity.entityId,
  );
  if (report) {
    Object.assign(report, patch);
  }
}

export async function convertMarkdownEntityMarkers(options: {
  client: CapacitiesClient;
  objectId: string;
  object: GetObjectResponse;
  entities: PreparedMarkdownEntity[];
  entityLinks: MarkdownEntityLinkReport[];
  signal?: AbortSignal;
}): Promise<GetObjectResponse> {
  let current = options.object;

  for (const entity of options.entities) {
    const located = locateMarker(current, entity.marker);
    if (!located) {
      updateReport(options.entityLinks, entity, {
        outcome: "literalized",
        reason: "conversion_failed",
      });
      continue;
    }

    try {
      current = await apiCall(
        () =>
          options.client.blocks.block.update({
            id: options.objectId,
            blockId: located.blockId,
            propertyId: located.propertyId,
            block: replaceMarkerToken(located, entity.marker, {
              type: "LinkToken",
              text: entity.label,
              entityId: entity.entityId,
            }),
          }),
        { signal: options.signal, stage: "mutation" },
      );
      updateReport(options.entityLinks, entity, { blockId: located.blockId });
    } catch (error) {
      try {
        current = await apiCall(
          () =>
            options.client.blocks.block.update({
              id: options.objectId,
              blockId: located.blockId,
              propertyId: located.propertyId,
              block: replaceMarkerToken(located, entity.marker, {
                type: "TextToken",
                text: entity.label,
                style: tokenStyle(located),
              }),
            }),
          { signal: options.signal, stage: "mutation" },
        );
        updateReport(options.entityLinks, entity, {
          outcome: "literalized",
          reason: "conversion_failed",
          blockId: located.blockId,
        });
      } catch (fallbackError) {
        throw new McpToolError(
          "mcp_partial_failure",
          "Markdown was written, but a safe entity conversion and its text fallback both failed.",
          {
            stage: "markdown_entity_conversion",
            recoverableObjectId: options.objectId,
            entityId: entity.entityId,
            cause: normalizeError(error),
            fallbackCause: normalizeError(fallbackError),
            recovery:
              "Inspect the object with get_object and replace the marker block manually using structural update_block.",
          },
        );
      }
    }
  }

  return current;
}

function tokenStyle(located: LocatedMarker) {
  const token = located.block.tokens[located.tokenIndex];
  return token?.type === "TextToken" ? token.style : {};
}

export async function prepareMarkdownForTool(
  client: CapacitiesClient,
  markdown: string,
  signal?: AbortSignal,
  options: { convertEntities?: boolean } = {},
): Promise<PreparedMarkdown> {
  const space = await apiCall(() => client.space.get(), {
    signal,
    stage: "discovery",
  });
  return prepareMarkdownEntities(markdown, {
    spaceId: space.id,
    convertEntities: options.convertEntities,
    objectExists: async (id) => {
      try {
        await apiCall(() => client.object.get({ id }), {
          signal,
          stage: "discovery",
        });
        return true;
      } catch (error) {
        if (
          error instanceof CapacitiesApiError &&
          error.code === "cap_not_found"
        ) {
          return false;
        }
        throw error;
      }
    },
  });
}
