import { afterEach, describe, expect, test } from "bun:test";
import { CapacitiesApiError } from "@capacities/api";
import {
  apiCall,
  errorResult,
  formatError,
  getMaxRateLimitRetries,
  getMaxRateLimitWaitMs,
  getReadbackMode,
  McpToolError,
  normalizeError,
  parseRateLimitHeader,
  toolResult,
  withObjectMutationLock,
  withObjectReadLock,
} from "../src/lib/client";

const retryEnv = "CAPACITIES_MCP_MAX_RATE_LIMIT_RETRIES";
const originalRetryValue = process.env[retryEnv];
const waitEnv = "CAPACITIES_MCP_MAX_RATE_LIMIT_WAIT_MS";
const originalWaitValue = process.env[waitEnv];
const readbackEnv = "CAPACITIES_MCP_READBACK";
const originalReadbackValue = process.env[readbackEnv];

afterEach(() => {
  if (originalRetryValue === undefined) {
    delete process.env[retryEnv];
  } else {
    process.env[retryEnv] = originalRetryValue;
  }
  if (originalWaitValue === undefined) {
    delete process.env[waitEnv];
  } else {
    process.env[waitEnv] = originalWaitValue;
  }
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

describe("RateLimit metadata and retry configuration", () => {
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

  test("accepts default, zero, and positive retry counts", () => {
    expect(getMaxRateLimitRetries(undefined)).toBe(1);
    expect(getMaxRateLimitRetries("0")).toBe(0);
    expect(getMaxRateLimitRetries("3")).toBe(3);
  });

  test("accepts and validates the maximum automatic wait", () => {
    expect(getMaxRateLimitWaitMs(undefined)).toBe(30_000);
    expect(getMaxRateLimitWaitMs("0")).toBe(0);
    expect(getMaxRateLimitWaitMs("1250")).toBe(1250);
    for (const value of ["-1", "1.5", "no"]) {
      expect(() => getMaxRateLimitWaitMs(value)).toThrow(
        "must be a non-negative integer in milliseconds",
      );
    }
  });

  test("accepts on/off readback configuration and rejects other values", () => {
    expect(getReadbackMode(undefined)).toBe("on");
    expect(getReadbackMode("on")).toBe("on");
    expect(getReadbackMode("OFF")).toBe("off");
    expect(() => getReadbackMode("false")).toThrow(
      'must be either "on" or "off"',
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

  test("rejects negative, decimal, and non-numeric values", () => {
    for (const value of ["-1", "1.5", "no"]) {
      expect(() => getMaxRateLimitRetries(value)).toThrow(
        "must be a non-negative integer",
      );
    }
  });

  test("rejects invalid retry configuration before making an API call", async () => {
    process.env[retryEnv] = "1.5";
    let attempts = 0;

    try {
      await apiCall(async () => {
        attempts += 1;
        return "unexpected";
      });
    } catch (error) {
      expect(error).toBeInstanceOf(McpToolError);
      expect((error as McpToolError).code).toBe("mcp_configuration_error");
    }

    expect(attempts).toBe(0);
  });

  test("retries only the individual operation that returned 429", async () => {
    process.env[retryEnv] = "1";
    let attempts = 0;
    const delays: number[] = [];

    const result = await apiCall(
      async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new CapacitiesApiError(
            429,
            "cap_rate_limit_exceeded",
            "Wait.",
            { retryAfter: 2, resetAt: "2026-07-31T00:00:02.000Z" },
          );
        }
        return "created-once";
      },
      {
        random: () => 0,
        sleep: async (milliseconds) => {
          delays.push(milliseconds);
        },
        stage: "mutation",
      },
    );

    expect(result).toBe("created-once");
    expect(attempts).toBe(2);
    expect(delays).toEqual([2_000]);
  });

  test("suppresses a retry when the computed wait exceeds the cap", async () => {
    process.env[retryEnv] = "1";
    process.env[waitEnv] = "100";
    let attempts = 0;
    let sleeps = 0;

    try {
      await apiCall(
        async () => {
          attempts += 1;
          throw new CapacitiesApiError(
            429,
            "cap_rate_limit_exceeded",
            "Wait.",
            { retryAfter: 1 },
          );
        },
        {
          random: () => 0,
          sleep: async () => {
            sleeps += 1;
          },
          stage: "readback",
        },
      );
      throw new Error("apiCall should have failed");
    } catch (error) {
      expect(error).toBeInstanceOf(CapacitiesApiError);
      expect((error as CapacitiesApiError).details).toMatchObject({
        stage: "readback",
        maxWaitMs: 100,
        retrySuppressed: true,
        suppressionReason: "wait_cap_exceeded",
        retryHistory: [
          {
            attempt: 1,
            requestedWaitMs: 1000,
            retried: false,
            reason: "wait_cap_exceeded",
          },
        ],
      });
    }

    expect(attempts).toBe(1);
    expect(sleeps).toBe(0);
  });

  test("does not repeat a completed create stage when a later patch retries", async () => {
    process.env[retryEnv] = "1";
    let createCalls = 0;
    let patchCalls = 0;

    const created = await apiCall(async () => {
      createCalls += 1;
      return { id: "11111111-1111-4111-8111-111111111111" };
    });
    await apiCall(
      async () => {
        patchCalls += 1;
        if (patchCalls === 1) {
          throw new CapacitiesApiError(
            429,
            "cap_rate_limit_exceeded",
            "Wait.",
            { retryAfter: 0 },
          );
        }
        return { id: created.id, patched: true };
      },
      {
        random: () => 0,
        sleep: async () => undefined,
      },
    );

    expect(createCalls).toBe(1);
    expect(patchCalls).toBe(2);
  });

  test("zero completely disables automatic waiting and retrying", async () => {
    process.env[retryEnv] = "0";
    let attempts = 0;
    let sleeps = 0;

    try {
      await apiCall(
        async () => {
          attempts += 1;
          throw new CapacitiesApiError(
            429,
            "cap_rate_limit_exceeded",
            "Wait.",
            { retryAfter: 10 },
          );
        },
        {
          sleep: async () => {
            sleeps += 1;
          },
        },
      );
      throw new Error("apiCall should have failed");
    } catch (error) {
      expect(error).toBeInstanceOf(CapacitiesApiError);
      expect((error as CapacitiesApiError).details).toMatchObject({
        retryAfter: 10,
        attempts: 1,
        maxRetries: 0,
      });
    }

    expect(attempts).toBe(1);
    expect(sleeps).toBe(0);
  });

  test("zero wait cap disables retry even when retry count is positive", async () => {
    process.env[retryEnv] = "3";
    process.env[waitEnv] = "0";
    let attempts = 0;

    await expect(
      apiCall(
        async () => {
          attempts += 1;
          throw new CapacitiesApiError(
            429,
            "cap_rate_limit_exceeded",
            "Wait.",
            { retryAfter: 0 },
          );
        },
        { stage: "mutation" },
      ),
    ).rejects.toBeInstanceOf(CapacitiesApiError);
    expect(attempts).toBe(1);
  });

  test("does not retry server, network, or non-429 API errors", async () => {
    process.env[retryEnv] = "4";
    const errors = [
      new CapacitiesApiError(503, "cap_unavailable", "Unavailable."),
      new CapacitiesApiError(429, "cap_other_error", "Not a rate-limit error."),
      new CapacitiesApiError(
        500,
        "cap_rate_limit_exceeded",
        "Wrong status for a rate-limit code.",
      ),
      new TypeError("network failed"),
    ];

    for (const expectedError of errors) {
      let attempts = 0;
      try {
        await apiCall(async () => {
          attempts += 1;
          throw expectedError;
        });
      } catch (error) {
        expect(error).toBe(expectedError);
      }
      expect(attempts).toBe(1);
    }
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
