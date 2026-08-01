import { afterEach, describe, expect, test } from "bun:test";
import { CapacitiesApiError } from "@capacities/api";
import {
  apiCall,
  errorResult,
  formatError,
  getClient,
  getReadbackMode,
  McpToolError,
  normalizeError,
  parseRateLimitHeader,
  resolveApiTokens,
  toolResult,
  withObjectMutationLock,
  withObjectReadLock,
  withPooledApiToken,
} from "../src/lib/client";

const readbackEnv = "CAPACITIES_MCP_READBACK";
const originalReadbackValue = process.env[readbackEnv];

afterEach(() => {
  if (originalReadbackValue === undefined) {
    delete process.env[readbackEnv];
  } else {
    process.env[readbackEnv] = originalReadbackValue;
  }
});

describe("unified tool response envelope", () => {
  test("uses the same success envelope in content and structuredContent", () => {
    const result = toolResult({ status: "ok", value: 42 });
    const parsedContent = JSON.parse(result.content[0].text);

    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({
      isError: false,
      data: { status: "ok", value: 42 },
    });
    expect(parsedContent).toEqual(result.structuredContent);
  });

  test("uses the same error envelope and preserves stable local codes", () => {
    const result = errorResult(
      new McpToolError("mcp_partial_failure", "Patch failed.", {
        stage: "property_patch",
      }),
    );
    const parsedContent = JSON.parse(result.content[0].text);

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      isError: true,
      error: {
        code: "mcp_partial_failure",
        message: "Patch failed.",
        details: { stage: "property_patch" },
      },
    });
    expect(parsedContent).toEqual(result.structuredContent);
  });

  test("preserves Capacities codes while sanitizing HTML responses", () => {
    const error = new CapacitiesApiError(
      429,
      "cap_rate_limit_exceeded",
      "<!doctype html><html>large proxy response</html>",
      { retryAfter: 2 },
    );
    const normalized = normalizeError(error);

    expect(normalized).toEqual({
      code: "cap_rate_limit_exceeded",
      message: "The API returned a non-JSON error response.",
      details: { status: 429, retryAfter: 2 },
    });
    expect(formatError(error)).toContain("cap_rate_limit_exceeded");
  });

  test("maps ordinary local validation failures to mcp_invalid_request", () => {
    expect(normalizeError(new Error("Invalid block hierarchy."))).toEqual({
      code: "mcp_invalid_request",
      message: "Invalid block hierarchy.",
    });
  });
});

describe("RateLimit metadata and API key pool configuration", () => {
  test("parses reset into retryAfter and an absolute resetAt", () => {
    expect(
      parseRateLimitHeader(
        "limit=120, remaining=0, reset=2.1",
        Date.parse("2026-07-31T00:00:00.000Z"),
      ),
    ).toEqual({
      limit: 120,
      remaining: 0,
      retryAfter: 3,
      resetAt: "2026-07-31T00:00:03.000Z",
      rateLimitMetadataAvailable: true,
      rateLimitSource: "ratelimit",
    });
  });

  test("captures RateLimit headers before the SDK discards them", async () => {
    const before = Date.now();
    const error = await CapacitiesApiError.fromResponse(
      new Response(JSON.stringify({ message: "Wait for reset." }), {
        status: 429,
        headers: { RateLimit: "limit=5, remaining=0, reset=2" },
      }),
    );
    const after = Date.now();
    const details = error.details as {
      retryAfter: number;
      resetAt: string;
      limit: number;
      remaining: number;
    };

    expect(error.code).toBe("cap_rate_limit_exceeded");
    expect(details).toMatchObject({
      retryAfter: 2,
      limit: 5,
      remaining: 0,
    });
    expect(Date.parse(details.resetAt)).toBeGreaterThanOrEqual(before + 2_000);
    expect(Date.parse(details.resetAt)).toBeLessThanOrEqual(after + 2_000);
  });

  test("parses comma and semicolon separated API keys", () => {
    expect(resolveApiTokens(" key-a,key-b; key-a ")).toEqual([
      "key-a",
      "key-b",
    ]);
  });

  test("rejects an empty API key pool", () => {
    expect(() => resolveApiTokens(" ; , ")).toThrow(
      "at least one non-empty API key",
    );
  });

  test("accepts true/false readback configuration and rejects other values", () => {
    expect(getReadbackMode(undefined)).toBe(true);
    expect(getReadbackMode("true")).toBe(true);
    expect(getReadbackMode("FALSE")).toBe(false);
    expect(() => getReadbackMode("on")).toThrow(
      'must be either "true" or "false"',
    );
  });

  test("reports absent rate-limit metadata without inventing a reset", async () => {
    const error = await CapacitiesApiError.fromResponse(
      new Response(JSON.stringify({ message: "Wait." }), { status: 429 }),
    );
    const details = error.details as Record<string, unknown>;
    expect(details).toMatchObject({
      retryAfter: null,
      resetAt: null,
      rateLimitMetadataAvailable: false,
      rateLimitSource: "none",
    });
  });

  test("returns a rate-limit error without invoking the operation again", async () => {
    let attempts = 0;
    const error = new CapacitiesApiError(
      429,
      "cap_rate_limit_exceeded",
      "Wait.",
      { retryAfter: 10 },
    );

    await expect(
      apiCall(
        async () => {
          attempts += 1;
          throw error;
        },
        { stage: "mutation" },
      ),
    ).rejects.toMatchObject({ status: 429, code: "cap_rate_limit_exceeded" });
    expect(attempts).toBe(1);
  });

  test("fails over within the same request and isolates endpoints", async () => {
    const keys = "pool-key-a,pool-key-b";
    const rateLimit = new CapacitiesApiError(
      429,
      "cap_rate_limit_exceeded",
      "Wait.",
      { retryAfter: 60 },
    );
    const attempted: string[] = [];
    const result = await withPooledApiToken(
      "pool-key-a,pool-key-b",
      "GET /objects/search",
      async (token) => {
        attempted.push(token);
        if (token === "pool-key-a") {
          throw rateLimit;
        }
        return token;
      },
    );
    expect(result).toBe("pool-key-b");
    expect(attempted).toEqual(["pool-key-a", "pool-key-b"]);

    const isolatedToken = await withPooledApiToken(
      keys,
      "POST /objects/search",
      async (token) => token,
    );
    expect(isolatedToken).toBe("pool-key-a");
  });

  test("returns 429 after every key is rate-limited", async () => {
    const rateLimit = new CapacitiesApiError(
      429,
      "cap_rate_limit_exceeded",
      "Wait.",
      { retryAfter: 60 },
    );
    const attempted: string[] = [];

    await expect(
      withPooledApiToken("all-key-a,all-key-b", "GET /space", async (token) => {
        attempted.push(token);
        throw rateLimit;
      }),
    ).rejects.toBe(rateLimit);
    expect(attempted).toEqual(["all-key-a", "all-key-b"]);
  });

  test("uses pooled credentials for SDK requests", async () => {
    const originalFetch = globalThis.fetch;
    const authorizationHeaders: string[] = [];
    globalThis.fetch = (async (_input, init) => {
      authorizationHeaders.push(
        new Headers(init?.headers).get("Authorization") ?? "",
      );
      return new Response(JSON.stringify({ id: "space-1", title: "Test" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    try {
      const client = getClient("sdk-key-a;sdk-key-b");
      await client.space.get();
      await client.space.get();
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(authorizationHeaders).toEqual([
      "Bearer sdk-key-a",
      "Bearer sdk-key-b",
    ]);
  });
});

describe("in-process object read/write locking", () => {
  test("serializes same-object writes and releases the lock after failure", async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });

    const first = withObjectMutationLock("object-1", async () => {
      order.push("first:start");
      firstStarted();
      await firstGate;
      order.push("first:end");
      throw new Error("first failed");
    });
    const second = withObjectMutationLock("object-1", async () => {
      order.push("second:start");
      return "second completed";
    });

    await started;
    expect(order).toEqual(["first:start"]);
    releaseFirst();
    await expect(first).rejects.toThrow("first failed");
    await expect(second).resolves.toBe("second completed");
    expect(order).toEqual(["first:start", "first:end", "second:start"]);

    await expect(
      withObjectMutationLock("object-1", async () => "reused"),
    ).resolves.toBe("reused");
  });

  test("allows same-object reads concurrently but excludes a mutation", async () => {
    const order: string[] = [];
    let releaseRead!: () => void;
    let firstReadStarted!: () => void;
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const readStarted = new Promise<void>((resolve) => {
      firstReadStarted = resolve;
    });

    const firstRead = withObjectReadLock("object-1", async () => {
      order.push("object-1:read-1");
      firstReadStarted();
      await readGate;
    });
    const secondRead = withObjectReadLock("object-1", async () => {
      order.push("object-1:read-2");
    });
    const write = withObjectMutationLock("object-1", async () => {
      order.push("object-1:write");
    });

    await readStarted;
    await Promise.resolve();
    expect(order).toEqual(["object-1:read-1", "object-1:read-2"]);
    releaseRead();
    await Promise.all([firstRead, secondRead, write]);
    expect(order).toEqual([
      "object-1:read-1",
      "object-1:read-2",
      "object-1:write",
    ]);
  });

  test("allows different-object reads and writes to proceed independently", async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });

    const firstWrite = withObjectMutationLock("object-1", async () => {
      order.push("object-1:write");
      firstStarted();
      await firstGate;
    });
    const differentObjectRead = withObjectReadLock("object-2", async () => {
      order.push("object-2:read");
    });

    await started;
    await Promise.resolve();
    expect(order).toEqual(["object-1:write", "object-2:read"]);
    releaseFirst();
    await Promise.all([firstWrite, differentObjectRead]);
  });
});
