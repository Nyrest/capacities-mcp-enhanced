import { expect, test } from "bun:test";
import type { WritableApiBlock } from "@capacities/api";
import appendContent from "../../src/tools/append-content";
import appendContentMarkdown from "../../src/tools/append-content-markdown";
import appendDailyNote from "../../src/tools/append-daily-note";
import appendDailyNoteMarkdown from "../../src/tools/append-daily-note-markdown";
import createObject from "../../src/tools/create-object";
import createObjectFromUrl from "../../src/tools/create-object-from-url";
import createObjectFromUrlMarkdown from "../../src/tools/create-object-from-url-markdown";
import createObjectMarkdown from "../../src/tools/create-object-markdown";
import deleteBlock from "../../src/tools/delete-block";
import deleteObject from "../../src/tools/delete-object";
import getObject from "../../src/tools/get-object";
import inspectSpace from "../../src/tools/inspect-space";
import searchObjects from "../../src/tools/search-objects";
import updateBlock from "../../src/tools/update-block";
import updateObject from "../../src/tools/update-object";

const hasToken = Boolean(process.env.CAPACITIES_API_TOKEN?.trim());
const liveTest = hasToken ? test : test.skip;

type StructureCatalog = {
  space: { id: string };
  structures: unknown[];
};

type StructureSchema = {
  structure: { id: string; propertyDefinitions: unknown[] };
  writeGuide: { createTool: string | null; fields: unknown[] };
};

type CreatedObject = {
  status: string;
  object: { id: string; structureId: string };
};

type SearchResult = {
  results: Array<{ id: string }>;
};

type MarkdownObject = {
  object: { markdown: string };
};

type StructuredObject = {
  object: {
    id: string;
    structureId: string;
    blocks: Record<string, LiveBlock[]>;
  };
};

type LiveBlock = {
  id: string;
  type: string;
  blocks?: LiveBlock[];
  columns?: LiveBlock[][];
};

type StatusResult = { status: string };

const LIVE_REQUEST_PACING_MS = 2_100;

function textBlocks(text: string): WritableApiBlock[] {
  return [
    {
      type: "TextBlock",
      tokens: [{ type: "TextToken", text, style: {} }],
      hierarchy: { key: "Base", val: 0 },
    },
  ];
}

function installLiveFetchPacing(): () => void {
  const originalFetch = globalThis.fetch;
  let queue: Promise<void> = Promise.resolve();
  let lastRequestAt = 0;

  globalThis.fetch = ((input, init) => {
    const request = queue.then(async () => {
      const waitMs = LIVE_REQUEST_PACING_MS - (Date.now() - lastRequestAt);
      if (waitMs > 0) {
        await Bun.sleep(waitMs);
      }
      try {
        return await originalFetch(input, init);
      } finally {
        lastRequestAt = Date.now();
      }
    });
    queue = request.then(
      () => undefined,
      () => undefined,
    );
    return request;
  }) as typeof fetch;

  return () => {
    globalThis.fetch = originalFetch;
  };
}

function data<T>(result: unknown): T {
  const structuredContent = (result as { structuredContent?: unknown })
    .structuredContent;
  if (!structuredContent || typeof structuredContent !== "object") {
    throw new Error("MCP tool returned no structured content.");
  }
  return structuredContent as T;
}

function findLiveBlock(blocks: LiveBlock[], id: string): LiveBlock | undefined {
  for (const block of blocks) {
    if (block.id === id) {
      return block;
    }
    const nested = findLiveBlock(block.blocks ?? [], id);
    if (nested) {
      return nested;
    }
    for (const column of block.columns ?? []) {
      const inColumn = findLiveBlock(column, id);
      if (inColumn) {
        return inColumn;
      }
    }
  }
}

async function retry<T>(
  operation: () => Promise<T>,
  accepts: (value: T) => boolean,
  attempts = 5,
): Promise<T> {
  let value = await operation();
  for (let attempt = 1; attempt < attempts && !accepts(value); attempt += 1) {
    await Bun.sleep(attempt * 500);
    value = await operation();
  }
  return value;
}

liveTest(
  "all MCP tools work against Capacities API 2.0",
  async () => {
    const restoreFetch = installLiveFetchPacing();
    const marker = `${Date.now()}`;
    const originalTitle = `xmcp live test ${marker}`;
    const updatedTitle = `${originalTitle} updated`;
    let objectId: string | undefined;
    let markdownObjectId: string | undefined;
    let urlObjectId: string | undefined;
    let markdownUrlObjectId: string | undefined;

    try {
      const catalog = data<StructureCatalog>(
        await inspectSpace({ refresh: true }),
      );
      expect(catalog.space.id).toBeString();
      expect(catalog.structures.length).toBeGreaterThan(0);

      const pageSchema = data<StructureSchema>(
        await inspectSpace({ structure: "RootPage", refresh: false }),
      );
      expect(pageSchema.structure.id).toBe("RootPage");
      expect(pageSchema.structure.propertyDefinitions.length).toBeGreaterThan(
        0,
      );
      expect(pageSchema.writeGuide.createTool).toBe("create_object");
      expect(pageSchema.writeGuide.fields.length).toBeGreaterThan(0);

      const created = data<CreatedObject>(
        await createObject({
          structure: "RootPage",
          title: originalTitle,
          blocks: [
            {
              ...textBlocks(
                `Created by the Capacities MCP live test. Marker: ${marker}`,
              )[0],
              blocks: textBlocks(`Preserved child marker: ${marker}`),
            },
          ],
        }),
      );
      expect(created.status).toBe("created");
      const createdObjectId = created.object.id;
      objectId = createdObjectId;

      const search = await retry(
        async () =>
          data<SearchResult>(
            await searchObjects({
              query: originalTitle,
              structures: ["RootPage"],
              limit: 10,
            }),
          ),
        (result) =>
          result.results.some((candidate) => candidate.id === createdObjectId),
      );
      expect(
        search.results.some((candidate) => candidate.id === createdObjectId),
      ).toBe(true);

      const markdownRead = data<MarkdownObject>(
        await getObject({ id: createdObjectId, format: "markdown" }),
      );
      expect(markdownRead.object.markdown).toContain(marker);

      const structuredRead = data<StructuredObject>(
        await getObject({ id: createdObjectId, format: "structured" }),
      );
      expect(structuredRead.object.id).toBe(objectId);
      expect(structuredRead.object.structureId).toBe("RootPage");

      const firstBlock = Object.values(structuredRead.object.blocks)
        .flat()
        .at(0);
      if (!firstBlock) {
        throw new Error("Live test object did not contain a readable block.");
      }
      const childBlockId = firstBlock.blocks?.at(0)?.id;
      if (!childBlockId) {
        throw new Error("Live test object did not retain its nested child.");
      }
      const blockUpdateMarker = `block-update-${marker}`;
      const blockUpdated = data<StatusResult>(
        await updateBlock({
          id: createdObjectId,
          blockId: firstBlock.id,
          block: textBlocks(
            `Updated in place by the Capacities MCP live test: ${blockUpdateMarker}`,
          )[0],
        }),
      );
      expect(blockUpdated.status).toBe("updated");

      const blockUpdatedRead = await retry(
        async () =>
          data<StructuredObject>(
            await getObject({ id: createdObjectId, format: "structured" }),
          ),
        (result) =>
          Boolean(
            findLiveBlock(
              Object.values(result.object.blocks).flat(),
              childBlockId,
            ),
          ),
      );
      expect(
        findLiveBlock(
          Object.values(blockUpdatedRead.object.blocks).flat(),
          childBlockId,
        ),
      ).toBeDefined();

      const blockUpdatedMarkdown = data<MarkdownObject>(
        await getObject({ id: createdObjectId, format: "markdown" }),
      );
      expect(blockUpdatedMarkdown.object.markdown).toContain(blockUpdateMarker);

      const updated = data<StatusResult>(
        await updateObject({ id: createdObjectId, title: updatedTitle }),
      );
      expect(updated.status).toBe("updated");

      const appendMarker = `append-${marker}`;
      const appended = data<StatusResult>(
        await appendContent({
          id: createdObjectId,
          blocks: textBlocks(`Live append marker: ${appendMarker}`),
          position: "end",
        }),
      );
      expect(appended.status).toBe("appended");

      const appendedRead = await retry(
        async () =>
          data<MarkdownObject>(
            await getObject({ id: createdObjectId, format: "markdown" }),
          ),
        (result) => result.object.markdown.includes(appendMarker),
      );
      expect(appendedRead.object.markdown).toContain(appendMarker);

      const markdownAppendMarker = `markdown-append-${marker}`;
      const markdownAppended = data<StatusResult>(
        await appendContentMarkdown({
          id: createdObjectId,
          markdown: `Markdown append marker: ${markdownAppendMarker}`,
          position: "end",
        }),
      );
      expect(markdownAppended.status).toBe("appended");

      const markdownAppendedRead = await retry(
        async () =>
          data<MarkdownObject>(
            await getObject({ id: createdObjectId, format: "markdown" }),
          ),
        (result) => result.object.markdown.includes(markdownAppendMarker),
      );
      expect(markdownAppendedRead.object.markdown).toContain(
        markdownAppendMarker,
      );

      const markdownCreated = data<CreatedObject>(
        await createObjectMarkdown({
          structure: "RootPage",
          title: `${originalTitle} markdown-create`,
          markdown: `Markdown create marker: ${marker}`,
        }),
      );
      expect(markdownCreated.status).toBe("created");
      markdownObjectId = markdownCreated.object.id;
      const markdownCreatedRead = data<MarkdownObject>(
        await getObject({ id: markdownObjectId, format: "markdown" }),
      );
      expect(markdownCreatedRead.object.markdown).toContain(marker);

      const imported = data<CreatedObject>(
        await createObjectFromUrl({
          url: `https://example.com/?capacities_mcp_live=${marker}`,
          title: `${originalTitle} URL`,
          description: "Capacities MCP live-test URL import.",
          blocks: textBlocks(`URL block marker: ${marker}`),
        }),
      );
      urlObjectId = imported.object.id;
      expect(imported.status).toBe("created");

      const importedStructured = data<StructuredObject>(
        await getObject({ id: urlObjectId, format: "structured" }),
      );
      const importedBlock = Object.values(importedStructured.object.blocks)
        .flat()
        .at(0);
      if (!importedBlock) {
        throw new Error("URL import did not contain an appended block.");
      }
      const deletedBlock = data<StatusResult>(
        await deleteBlock({ id: urlObjectId, blockId: importedBlock.id }),
      );
      expect(deletedBlock.status).toBe("deleted");

      const afterBlockDelete = data<StructuredObject>(
        await getObject({ id: urlObjectId, format: "structured" }),
      );
      const remainingBlockIds = Object.values(afterBlockDelete.object.blocks)
        .flat()
        .map((block) => block.id);
      expect(remainingBlockIds).not.toContain(importedBlock.id);

      const markdownImported = data<CreatedObject>(
        await createObjectFromUrlMarkdown({
          url: `https://example.com/?capacities_mcp_live_markdown=${marker}`,
          title: `${originalTitle} URL Markdown`,
          markdown: `URL Markdown marker: ${marker}`,
        }),
      );
      markdownUrlObjectId = markdownImported.object.id;
      expect(markdownImported.status).toBe("created");
      const markdownImportedRead = data<MarkdownObject>(
        await getObject({ id: markdownUrlObjectId, format: "markdown" }),
      );
      expect(markdownImportedRead.object.markdown).toContain(marker);

      const trashed = data<StatusResult>(
        await deleteObject({ id: createdObjectId, permanent: false }),
      );
      expect(trashed.status).toBe("moved_to_trash");
      objectId = undefined;

      const permanentCandidate = data<CreatedObject>(
        await createObject({
          structure: "RootPage",
          title: `${originalTitle} permanent-delete`,
        }),
      );
      const permanentObjectId = permanentCandidate.object.id;
      objectId = permanentObjectId;
      const permanentlyDeleted = data<StatusResult>(
        await deleteObject({
          id: permanentObjectId,
          permanent: true,
        }),
      );
      expect(permanentlyDeleted.status).toBe("permanently_deleted");
      objectId = undefined;

      const markdownDaily = data<StatusResult>(
        await appendDailyNoteMarkdown({
          markdown: `Markdown daily-note marker: ${marker}`,
          date: new Date().toISOString().slice(0, 10),
          noTimestamp: true,
        }),
      );
      expect(markdownDaily.status).toBe("queued");

      const daily = data<StatusResult>(
        await appendDailyNote({
          blocks: textBlocks(
            `MCP live test completed successfully (${marker}).`,
          ),
          date: new Date().toISOString().slice(0, 10),
          noTimestamp: true,
        }),
      );
      expect(daily.status).toBe("queued");
    } finally {
      if (objectId) {
        try {
          await deleteObject({ id: objectId, permanent: true });
        } catch {
          // Preserve the original assertion/API error; best-effort cleanup only.
        }
      }
      if (markdownObjectId) {
        try {
          await deleteObject({
            id: markdownObjectId,
            permanent: true,
          });
        } catch {
          // Preserve the original assertion/API error; best-effort cleanup only.
        }
      }
      if (urlObjectId) {
        try {
          await deleteObject({ id: urlObjectId, permanent: true });
        } catch {
          // Preserve the original assertion/API error; best-effort cleanup only.
        }
      }
      if (markdownUrlObjectId) {
        try {
          await deleteObject({
            id: markdownUrlObjectId,
            permanent: true,
          });
        } catch {
          // Preserve the original assertion/API error; best-effort cleanup only.
        }
      }
      restoreFetch();
    }
  },
  180_000,
);
