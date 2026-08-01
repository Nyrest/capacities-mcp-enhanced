import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getUploadJob,
  startUploadJob,
  waitForUploadJob,
} from "../src/lib/upload-jobs";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function fakeCapacitiesFetch() {
  const uploads = new Map<string, { fileName: string; fileSize: number }>();
  const parts: Array<{ id: string; number: number; size: number }> = [];
  let sequence = 0;

  const fetcher = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    if (method === "POST" && url.pathname === "/object/media/upload") {
      const body = JSON.parse(String(init?.body));
      const id = `11111111-1111-4111-8111-${String(++sequence).padStart(12, "0")}`;
      uploads.set(id, { fileName: body.fileName, fileSize: body.fileSize });
      return Response.json({
        id,
        status: "pending",
        fileName: body.fileName,
        fileType: body.fileType ?? "text/plain",
        fileSize: body.fileSize,
        partSize: 4,
        partCount: Math.ceil(body.fileSize / 4),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
    }
    if (method === "PUT" && url.pathname === "/object/media/upload/part") {
      const id = url.searchParams.get("id") ?? "";
      const number = Number(url.searchParams.get("partNumber"));
      const body = init?.body;
      const size = body instanceof Uint8Array ? body.byteLength : 0;
      parts.push({ id, number, size });
      return Response.json({ number, size });
    }
    if (method === "POST" && url.pathname === "/object/media/upload/complete") {
      const { id } = JSON.parse(String(init?.body));
      const upload = uploads.get(id);
      if (!upload)
        return Response.json(
          { code: "cap_not_found", message: "Not found" },
          { status: 404 },
        );
      return Response.json({
        id,
        structureId: "MediaFile",
        collections: [],
        properties: {
          title: { type: "title", title: { value: upload.fileName } },
          media_fileSize: {
            type: "number",
            number: { value: upload.fileSize },
          },
        },
        files: [
          {
            url: "https://example.test/file",
            fileType: "text/plain",
            expirationDate: new Date(Date.now() + 60_000).toISOString(),
          },
        ],
      });
    }
    if (method === "POST" && url.pathname === "/object/media/upload/abort") {
      const { id } = JSON.parse(String(init?.body));
      uploads.delete(id);
      return new Response(null, { status: 204 });
    }
    if (method === "GET" && url.pathname === "/object") {
      const id = url.searchParams.get("id") ?? "";
      const upload = uploads.get(id);
      if (!upload)
        return Response.json(
          { code: "cap_not_found", message: "Not found" },
          { status: 404 },
        );
      return Response.json({
        id,
        structureId: "MediaFile",
        collections: [],
        properties: {
          title: { type: "title", title: { value: upload.fileName } },
          media_fileSize: {
            type: "number",
            number: { value: upload.fileSize },
          },
        },
        files: [
          {
            url: "https://example.test/file",
            fileType: "text/plain",
            expirationDate: new Date(Date.now() + 60_000).toISOString(),
          },
        ],
      });
    }
    throw new Error(`Unhandled fake request: ${method} ${url}`);
  };

  return { fetcher, parts };
}

describe("media upload jobs", () => {
  test("streams multipart parts and verifies the created media object", async () => {
    const root = await mkdtemp(join(tmpdir(), "capacities-upload-test-"));
    const filePath = join(root, "notes.txt");
    await writeFile(filePath, "123456789");
    const fake = fakeCapacitiesFetch();
    globalThis.fetch = fake.fetcher;

    const result = await startUploadJob({
      files: [{ path: filePath }],
      mode: "wait",
      apiToken: "test-token",
    });

    expect(result.status).toBe("completed");
    expect(result.items[0].verification?.readbackVerified).toBe(true);
    expect(fake.parts.map((part) => part.size)).toEqual([4, 4, 1]);
    await rm(root, { recursive: true, force: true });
  });

  test("supports background status and in-process wait", async () => {
    const root = await mkdtemp(join(tmpdir(), "capacities-upload-test-"));
    const filePath = join(root, "background.txt");
    await writeFile(filePath, "background");
    const fake = fakeCapacitiesFetch();
    globalThis.fetch = fake.fetcher;

    const started = await startUploadJob({
      files: [{ path: filePath }],
      mode: "background",
      apiToken: "test-token",
    });
    expect(getUploadJob(started.jobId).jobId).toBe(started.jobId);
    const result = await waitForUploadJob(started.jobId, 5_000);
    expect(result.status).toBe("completed");
    await rm(root, { recursive: true, force: true });
  });

  test("requires absolute paths before starting a remote job", async () => {
    await expect(
      startUploadJob({
        files: [{ path: "relative.txt" }],
        mode: "wait",
        apiToken: "test-token",
      }),
    ).rejects.toMatchObject({ code: "mcp_upload_invalid_path" });
  });
});
