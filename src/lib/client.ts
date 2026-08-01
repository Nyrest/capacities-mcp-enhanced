import {
  CapacitiesApiError,
  CapacitiesClient,
  type SpaceStructure,
} from "@capacities/api";

const STRUCTURE_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_RATE_LIMIT_RETRIES = 1;
const DEFAULT_MAX_RATE_LIMIT_WAIT_MS = 30_000;
const RATE_LIMIT_RETRY_ENV = "CAPACITIES_MCP_MAX_RATE_LIMIT_RETRIES";
const RATE_LIMIT_WAIT_ENV = "CAPACITIES_MCP_MAX_RATE_LIMIT_WAIT_MS";
const READBACK_ENV = "CAPACITIES_MCP_READBACK";

export type ToolError = {
  code: string;
  message: string;
  details?: unknown;
};

export type ReadbackMode = "on" | "off";

export type ApiCallStage =
  | "unknown"
  | "discovery"
  | "precondition_read"
  | "mutation"
  | "readback"
  | "rollback_delete"
  | "rollback_readback"
  | "daily_note_enqueue"
  | "upload_init"
  | "upload_part"
  | "upload_complete"
  | "upload_abort"
  | "upload_readback";

type ClientSession = {
  token: string;
  client: CapacitiesClient;
  structures?: SpaceStructure[];
  structuresFetchedAt?: number;
};

type ApiCallOptions = {
  signal?: AbortSignal;
  random?: () => number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  stage?: ApiCallStage;
};

export class McpToolError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "McpToolError";
    this.code = code;
    this.details = details;
  }
}

let session: ClientSession | undefined;
type ObjectLockState = {
  activeReaders: number;
  writerActive: boolean;
  waitingReaders: Array<() => void>;
  waitingWriters: Array<() => void>;
};

const objectLocks = new Map<string, ObjectLockState>();

function objectLockState(objectId: string): ObjectLockState {
  const existing = objectLocks.get(objectId);
  if (existing) {
    return existing;
  }

  const created: ObjectLockState = {
    activeReaders: 0,
    writerActive: false,
    waitingReaders: [],
    waitingWriters: [],
  };
  objectLocks.set(objectId, created);
  return created;
}

function drainObjectLock(objectId: string, state: ObjectLockState): void {
  if (state.writerActive || state.activeReaders > 0) {
    return;
  }

  const nextWriter = state.waitingWriters.shift();
  if (nextWriter) {
    state.writerActive = true;
    nextWriter();
    return;
  }

  while (state.waitingReaders.length > 0) {
    state.activeReaders += 1;
    state.waitingReaders.shift()?.();
  }

  if (
    state.activeReaders === 0 &&
    state.waitingReaders.length === 0 &&
    state.waitingWriters.length === 0
  ) {
    objectLocks.delete(objectId);
  }
}

async function acquireObjectRead(state: ObjectLockState): Promise<void> {
  if (state.writerActive || state.waitingWriters.length > 0) {
    await new Promise<void>((resolve) => {
      state.waitingReaders.push(resolve);
    });
    return;
  }

  state.activeReaders += 1;
}

async function acquireObjectMutation(state: ObjectLockState): Promise<void> {
  if (state.writerActive || state.activeReaders > 0) {
    await new Promise<void>((resolve) => {
      state.waitingWriters.push(resolve);
    });
    return;
  }

  state.writerActive = true;
}

/**
 * Allow concurrent reads for one object, while keeping reads and mutations
 * mutually exclusive. Different object IDs use independent lock state.
 *
 * Capacities uses last-write-wins semantics and does not expose ETags or
 * transactions. This prevents concurrent tool calls for one object from
 * observing or producing an out-of-order state while allowing different
 * objects to proceed independently.
 */
export async function withObjectReadLock<T>(
  objectId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const state = objectLockState(objectId);
  await acquireObjectRead(state);

  try {
    return await operation();
  } finally {
    state.activeReaders -= 1;
    drainObjectLock(objectId, state);
  }
}

export async function withObjectMutationLock<T>(
  objectId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const state = objectLockState(objectId);
  await acquireObjectMutation(state);

  try {
    return await operation();
  } finally {
    state.writerActive = false;
    drainObjectLock(objectId, state);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeApiMessage(message: string): string {
  return /<!doctype|<html[\s>]/i.test(message)
    ? "The API returned a non-JSON error response."
    : message;
}

function parseNonNegativeNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

export function parseRateLimitHeader(
  header: string | null,
  now = Date.now(),
): Record<string, unknown> | undefined {
  if (!header) {
    return undefined;
  }

  const fields = new Map(
    header.split(",").map((part) => {
      const [key, value] = part.trim().split("=", 2);
      return [key?.toLowerCase(), value?.replace(/^"|"$/g, "")] as const;
    }),
  );
  const limit = parseNonNegativeNumber(fields.get("limit"));
  const remaining = parseNonNegativeNumber(fields.get("remaining"));
  const reset = parseNonNegativeNumber(fields.get("reset"));

  if (limit === undefined && remaining === undefined && reset === undefined) {
    return undefined;
  }

  const retryAfter = reset === undefined ? undefined : Math.ceil(reset);
  return {
    limit: limit ?? null,
    remaining: remaining ?? null,
    retryAfter: retryAfter ?? null,
    resetAt:
      retryAfter === undefined
        ? null
        : new Date(now + retryAfter * 1000).toISOString(),
    rateLimitMetadataAvailable: true,
    rateLimitSource: "ratelimit",
  };
}

function parseRetryAfterHeader(
  header: string | null,
  now = Date.now(),
): Record<string, unknown> | undefined {
  const retryAfter = parseNonNegativeNumber(header ?? undefined);
  if (retryAfter === undefined) {
    return undefined;
  }

  const roundedRetryAfter = Math.ceil(retryAfter);
  return {
    limit: null,
    remaining: null,
    retryAfter: roundedRetryAfter,
    resetAt: new Date(now + roundedRetryAfter * 1000).toISOString(),
    rateLimitMetadataAvailable: true,
    rateLimitSource: "retry-after",
  };
}

function parseRateLimitMetadata(
  rateLimitHeader: string | null,
  retryAfterHeader: string | null,
  now = Date.now(),
): Record<string, unknown> | undefined {
  return (
    parseRateLimitHeader(rateLimitHeader, now) ??
    parseRetryAfterHeader(retryAfterHeader, now)
  );
}

const originalFromResponse =
  CapacitiesApiError.fromResponse.bind(CapacitiesApiError);

CapacitiesApiError.fromResponse = async (response: Response) => {
  const rateLimit = parseRateLimitMetadata(
    response.headers.get("RateLimit"),
    response.headers.get("Retry-After"),
    Date.now(),
  );
  const error = await originalFromResponse(response);

  if (!rateLimit && error.status !== 429) {
    return error;
  }

  const existingDetails = isRecord(error.details)
    ? error.details
    : error.details === undefined
      ? {}
      : { upstreamDetails: error.details };

  return new CapacitiesApiError(error.status, error.code, error.message, {
    ...existingDetails,
    ...(rateLimit ?? {
      retryAfter: null,
      resetAt: null,
      limit: null,
      remaining: null,
      rateLimitMetadataAvailable: false,
      rateLimitSource: "none",
    }),
  });
};

export function resolveApiToken(apiToken?: string): string {
  const token = apiToken?.trim() || process.env.CAPACITIES_API_TOKEN?.trim();

  if (!token) {
    throw new McpToolError(
      "mcp_configuration_error",
      "Capacities authentication is missing. Set CAPACITIES_API_TOKEN or pass apiToken to the tool.",
    );
  }

  return token;
}

export function getMaxRateLimitRetries(
  value = process.env[RATE_LIMIT_RETRY_ENV],
): number {
  if (value === undefined || value.trim() === "") {
    return DEFAULT_MAX_RATE_LIMIT_RETRIES;
  }
  if (!/^\d+$/.test(value.trim())) {
    throw new McpToolError(
      "mcp_configuration_error",
      `${RATE_LIMIT_RETRY_ENV} must be a non-negative integer.`,
      { environmentVariable: RATE_LIMIT_RETRY_ENV, value },
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new McpToolError(
      "mcp_configuration_error",
      `${RATE_LIMIT_RETRY_ENV} must be a non-negative safe integer.`,
      { environmentVariable: RATE_LIMIT_RETRY_ENV, value },
    );
  }
  return parsed;
}

export function getMaxRateLimitWaitMs(
  value = process.env[RATE_LIMIT_WAIT_ENV],
): number {
  if (value === undefined || value.trim() === "") {
    return DEFAULT_MAX_RATE_LIMIT_WAIT_MS;
  }
  if (!/^\d+$/.test(value.trim())) {
    throw new McpToolError(
      "mcp_configuration_error",
      `${RATE_LIMIT_WAIT_ENV} must be a non-negative integer in milliseconds.`,
      { environmentVariable: RATE_LIMIT_WAIT_ENV, value },
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new McpToolError(
      "mcp_configuration_error",
      `${RATE_LIMIT_WAIT_ENV} must be a non-negative safe integer in milliseconds.`,
      { environmentVariable: RATE_LIMIT_WAIT_ENV, value },
    );
  }
  return parsed;
}

export function getReadbackMode(
  value = process.env[READBACK_ENV],
): ReadbackMode {
  if (value === undefined || value.trim() === "") {
    return "on";
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "on") {
    return "on";
  }
  if (normalized === "off") {
    return "off";
  }

  throw new McpToolError(
    "mcp_configuration_error",
    `${READBACK_ENV} must be either "on" or "off".`,
    { environmentVariable: READBACK_ENV, value },
  );
}

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(signal.reason ?? new Error("Operation aborted."));
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(signal.reason ?? new Error("Operation aborted."));
      },
      { once: true },
    );
  });
}

function rateLimitDetails(error: CapacitiesApiError): Record<string, unknown> {
  return isRecord(error.details) ? error.details : {};
}

function withStage(
  error: CapacitiesApiError,
  stage: ApiCallStage,
): CapacitiesApiError {
  const details = rateLimitDetails(error);
  if (details.stage === stage) {
    return error;
  }
  return new CapacitiesApiError(error.status, error.code, error.message, {
    ...details,
    stage,
  });
}

function withAttemptDetails(
  error: CapacitiesApiError,
  attempts: number,
  maxRetries: number,
  totalWaitMs: number,
  maxWaitMs: number,
  stage: ApiCallStage,
  retryHistory: Array<Record<string, unknown>>,
  retrySuppressed = false,
  suppressionReason?: string,
): CapacitiesApiError {
  const details = rateLimitDetails(error);
  return new CapacitiesApiError(error.status, error.code, error.message, {
    ...details,
    attempts,
    maxRetries,
    totalWaitMs,
    maxWaitMs,
    stage,
    retryHistory,
    retrySuppressed,
    ...(suppressionReason === undefined ? {} : { suppressionReason }),
    retryAfter:
      typeof details.retryAfter === "number" ? details.retryAfter : null,
    resetAt: typeof details.resetAt === "string" ? details.resetAt : null,
    limit: typeof details.limit === "number" ? details.limit : null,
    remaining: typeof details.remaining === "number" ? details.remaining : null,
    rateLimitMetadataAvailable: details.rateLimitMetadataAvailable === true,
    rateLimitSource:
      details.rateLimitSource === "ratelimit" ||
      details.rateLimitSource === "retry-after"
        ? details.rateLimitSource
        : "none",
  });
}

export async function apiCall<T>(
  operation: () => Promise<T>,
  options: ApiCallOptions = {},
): Promise<T> {
  const maxRetries = getMaxRateLimitRetries();
  const maxWaitMs = getMaxRateLimitWaitMs();
  const sleep = options.sleep ?? wait;
  const random = options.random ?? Math.random;
  const stage = options.stage ?? "unknown";
  let attempts = 0;
  let totalWaitMs = 0;
  const retryHistory: Array<Record<string, unknown>> = [];

  while (true) {
    attempts += 1;
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof CapacitiesApiError)) {
        throw error;
      }

      if (error.status !== 429 || error.code !== "cap_rate_limit_exceeded") {
        throw stage === "unknown" ? error : withStage(error, stage);
      }

      const retriesPerformed = attempts - 1;
      if (retriesPerformed >= maxRetries) {
        throw withAttemptDetails(
          error,
          attempts,
          maxRetries,
          totalWaitMs,
          maxWaitMs,
          stage,
          [
            ...retryHistory,
            {
              attempt: attempts,
              retried: false,
              reason: "max_retries_exhausted",
            },
          ],
        );
      }

      const details = rateLimitDetails(error);
      const retryAfter =
        typeof details.retryAfter === "number"
          ? Math.max(0, details.retryAfter)
          : 0;
      const exponentialBackoff = 500 * 2 ** retriesPerformed;
      const delay =
        Math.max(retryAfter * 1000, exponentialBackoff) +
        Math.floor(random() * 251);

      const retryRecord = {
        attempt: attempts,
        retryAfter,
        resetAt: typeof details.resetAt === "string" ? details.resetAt : null,
        requestedWaitMs: delay,
      };

      if (maxWaitMs === 0 || delay > maxWaitMs) {
        throw withAttemptDetails(
          error,
          attempts,
          maxRetries,
          totalWaitMs,
          maxWaitMs,
          stage,
          [
            ...retryHistory,
            {
              ...retryRecord,
              retried: false,
              reason: maxWaitMs === 0 ? "wait_disabled" : "wait_cap_exceeded",
            },
          ],
          true,
          maxWaitMs === 0 ? "wait_disabled" : "wait_cap_exceeded",
        );
      }

      retryHistory.push({ ...retryRecord, retried: true });
      totalWaitMs += delay;
      await sleep(delay, options.signal);
    }
  }
}

export function getClient(apiToken?: string): CapacitiesClient {
  const token = resolveApiToken(apiToken);
  getMaxRateLimitRetries();
  getMaxRateLimitWaitMs();
  getReadbackMode();

  if (!session || session.token !== token) {
    session = {
      token,
      client: new CapacitiesClient({ apiToken: token }),
    };
  }

  return session.client;
}

export async function getStructures(
  client: CapacitiesClient,
  refresh = false,
  signal?: AbortSignal,
): Promise<SpaceStructure[]> {
  const now = Date.now();
  const cacheIsFresh =
    session?.client === client &&
    session.structures !== undefined &&
    session.structuresFetchedAt !== undefined &&
    now - session.structuresFetchedAt < STRUCTURE_CACHE_TTL_MS;

  if (!refresh && cacheIsFresh) {
    const cachedStructures = session?.structures;
    if (cachedStructures) {
      return cachedStructures;
    }
  }

  const { structures } = await apiCall(() => client.space.structures(), {
    signal,
    stage: "discovery",
  });

  if (session?.client === client) {
    session.structures = structures;
    session.structuresFetchedAt = now;
  }

  return structures;
}

export function normalizeError(error: unknown): ToolError {
  if (error instanceof McpToolError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    };
  }

  if (error instanceof CapacitiesApiError) {
    const details = isRecord(error.details)
      ? { status: error.status, ...error.details }
      : {
          status: error.status,
          ...(error.details === undefined
            ? {}
            : { upstreamDetails: error.details }),
        };
    return {
      code: error.code,
      message: sanitizeApiMessage(error.message),
      details,
    };
  }

  if (error instanceof TypeError) {
    return {
      code: "mcp_unexpected",
      message: error.message,
    };
  }

  if (error instanceof Error) {
    return {
      code: "mcp_invalid_request",
      message: error.message,
    };
  }

  return {
    code: "mcp_unexpected",
    message: "Unexpected Capacities MCP error.",
  };
}

export function formatError(error: unknown): string {
  const normalized = normalizeError(error);
  return `${normalized.code}: ${normalized.message}`;
}

export async function runTool<T extends Record<string, unknown>>(
  operation: () => Promise<T>,
) {
  try {
    return toolResult(await operation());
  } catch (error) {
    return errorResult(error);
  }
}

export function toolResult<T extends Record<string, unknown>>(data: T) {
  const envelope = { isError: false as const, data };
  return {
    isError: false,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(envelope, null, 2),
      },
    ],
    structuredContent: envelope,
  };
}

export function errorResult(error: unknown) {
  const envelope = { isError: true as const, error: normalizeError(error) };
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(envelope, null, 2),
      },
    ],
    structuredContent: envelope,
  };
}
