import {
  CapacitiesApiError,
  CapacitiesClient,
  CapacitiesErrorCode,
  type SpaceStructure,
} from "@capacities/api";

const STRUCTURE_CACHE_TTL_MS = 5 * 60 * 1000;
const READBACK_ENV = "CAPACITIES_MCP_READBACK";

export type ToolError = {
  code: string;
  message: string;
  details?: unknown;
};

export type ReadbackMode = boolean;

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
  poolKey: string;
  pool: TokenPool;
  client: CapacitiesClient;
  structures?: SpaceStructure[];
  structuresFetchedAt?: number;
};

type ApiCallOptions = {
  signal?: AbortSignal;
  stage?: ApiCallStage;
};

type TokenState = {
  token: string;
  blockedUntilByEndpoint: Map<string, number>;
};

type TokenPool = {
  key: string;
  tokens: TokenState[];
  clients: Map<string, CapacitiesClient>;
  cursors: Map<string, number>;
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

const pools = new Map<string, TokenPool>();
const sessions = new Map<string, ClientSession>();
const sessionByClient = new WeakMap<CapacitiesClient, ClientSession>();
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

export function resolveApiTokens(apiToken?: string): string[] {
  const configured =
    apiToken?.trim() || process.env.CAPACITIES_API_TOKEN?.trim();

  if (!configured) {
    throw new McpToolError(
      "mcp_configuration_error",
      "Capacities authentication is missing. Set CAPACITIES_API_TOKEN or pass apiToken to the tool.",
    );
  }

  const tokens = configured
    .split(/[;,]/)
    .map((token) => token.trim())
    .filter(
      (token, index, all) => token.length > 0 && all.indexOf(token) === index,
    );

  if (tokens.length === 0) {
    throw new McpToolError(
      "mcp_configuration_error",
      "Capacities authentication must contain at least one non-empty API key.",
    );
  }

  return tokens;
}

export function resolveApiToken(apiToken?: string): string {
  return resolveApiTokens(apiToken)[0];
}

export function getReadbackMode(
  value = process.env[READBACK_ENV],
): ReadbackMode {
  if (value === undefined || value.trim() === "") {
    return true;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "true") {
    return true;
  }
  if (normalized === "false") {
    return false;
  }

  throw new McpToolError(
    "mcp_configuration_error",
    `${READBACK_ENV} must be either "true" or "false".`,
    { environmentVariable: READBACK_ENV, value },
  );
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

export async function apiCall<T>(
  operation: () => Promise<T>,
  options: ApiCallOptions = {},
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof CapacitiesApiError && options.stage !== undefined) {
      throw withStage(error, options.stage);
    }
    throw error;
  }
}

export function getClient(apiToken?: string): CapacitiesClient {
  const tokens = resolveApiTokens(apiToken);
  getReadbackMode();

  const poolKey = tokens.join("\u0000");
  let session = sessions.get(poolKey);
  if (!session) {
    const pool: TokenPool = {
      key: poolKey,
      tokens: tokens.map((token) => ({
        token,
        blockedUntilByEndpoint: new Map(),
      })),
      clients: new Map(),
      cursors: new Map(),
    };
    pools.set(poolKey, pool);
    const client = createPooledClient(pool);
    session = { poolKey, pool, client };
    sessions.set(poolKey, session);
    sessionByClient.set(client, session);
  }

  return session.client;
}

function isRateLimited(error: unknown): error is CapacitiesApiError {
  return (
    error instanceof CapacitiesApiError &&
    error.status === 429 &&
    error.code === "cap_rate_limit_exceeded"
  );
}

function chooseToken(pool: TokenPool, endpoint: string): TokenState {
  const now = Date.now();
  const start = pool.cursors.get(endpoint) ?? 0;
  for (let offset = 0; offset < pool.tokens.length; offset += 1) {
    const index = (start + offset) % pool.tokens.length;
    const token = pool.tokens[index];
    const blockedUntil = token.blockedUntilByEndpoint.get(endpoint) ?? 0;
    if (blockedUntil <= now) {
      pool.cursors.set(endpoint, (index + 1) % pool.tokens.length);
      return token;
    }
  }

  const earliest = pool.tokens.reduce((candidate, token) => {
    const candidateUntil = candidate.blockedUntilByEndpoint.get(endpoint) ?? 0;
    const tokenUntil = token.blockedUntilByEndpoint.get(endpoint) ?? 0;
    return tokenUntil < candidateUntil ? token : candidate;
  }, pool.tokens[0]);
  const retryAfter = Math.max(
    0,
    Math.ceil(
      ((earliest.blockedUntilByEndpoint.get(endpoint) ?? now) - now) / 1000,
    ),
  );
  throw new CapacitiesApiError(
    429,
    CapacitiesErrorCode.RateLimitExceeded,
    "All configured API keys are rate-limited for this endpoint.",
    {
      retryAfter,
      resetAt: new Date(now + retryAfter * 1000).toISOString(),
      rateLimitMetadataAvailable: true,
      rateLimitSource: "api-key-pool",
      endpoint,
    },
  );
}

function markRateLimited(
  token: TokenState,
  endpoint: string,
  error: CapacitiesApiError,
): void {
  const details = rateLimitDetails(error);
  const retryAfter =
    typeof details.retryAfter === "number"
      ? Math.max(0, details.retryAfter)
      : 0;
  token.blockedUntilByEndpoint.set(endpoint, Date.now() + retryAfter * 1000);
}

export async function withPooledApiToken<T>(
  apiToken: string | undefined,
  endpoint: string,
  operation: (token: string) => Promise<T>,
): Promise<T> {
  const tokens = resolveApiTokens(apiToken);
  const poolKey = tokens.join("\u0000");
  let pool = pools.get(poolKey);
  if (!pool) {
    pool = {
      key: poolKey,
      tokens: tokens.map((token) => ({
        token,
        blockedUntilByEndpoint: new Map(),
      })),
      clients: new Map(),
      cursors: new Map(),
    };
    pools.set(poolKey, pool);
  }

  let lastRateLimit: CapacitiesApiError | undefined;
  while (true) {
    let selected: TokenState;
    try {
      selected = chooseToken(pool, endpoint);
    } catch (error) {
      if (lastRateLimit !== undefined) {
        throw lastRateLimit;
      }
      throw error;
    }

    try {
      return await operation(selected.token);
    } catch (error) {
      if (!isRateLimited(error)) {
        throw error;
      }
      markRateLimited(selected, endpoint, error);
      lastRateLimit = error;
    }
  }
}

function pooledSdkCall<T>(
  pool: TokenPool,
  endpoint: string,
  operation: (client: CapacitiesClient) => Promise<T>,
): Promise<T> {
  return withPooledApiToken(
    pool.tokens.map((entry) => entry.token).join(","),
    endpoint,
    async (token) => {
      let client = pool.clients.get(token);
      if (!client) {
        client = new CapacitiesClient({ apiToken: token });
        pool.clients.set(token, client);
      }
      return operation(client);
    },
  );
}

function createPooledClient(pool: TokenPool): CapacitiesClient {
  return {
    space: {
      get: () =>
        pooledSdkCall(pool, "GET /space", (client) => client.space.get()),
      structures: () =>
        pooledSdkCall(pool, "GET /space/structures", (client) =>
          client.space.structures(),
        ),
    },
    object: {
      get: (params) =>
        pooledSdkCall(pool, "GET /object", (client) =>
          client.object.get(params),
        ),
      create: (body) =>
        pooledSdkCall(pool, "POST /object", (client) =>
          client.object.create(body),
        ),
      update: (body) =>
        pooledSdkCall(pool, "PATCH /object", (client) =>
          client.object.update(body),
        ),
      delete: (params) =>
        pooledSdkCall(pool, "DELETE /object", (client) =>
          client.object.delete(params),
        ),
      createFromUrl: (body) =>
        pooledSdkCall(pool, "POST /object/url", (client) =>
          client.object.createFromUrl(body),
        ),
      markdown: {
        get: (params) =>
          pooledSdkCall(pool, "GET /object/markdown", (client) =>
            client.object.markdown.get(params),
          ),
        create: (body) =>
          pooledSdkCall(pool, "POST /object/markdown", (client) =>
            client.object.markdown.create(body),
          ),
      },
    },
    objects: {
      search: (body) =>
        pooledSdkCall(pool, "POST /objects/search", (client) =>
          client.objects.search(body),
        ),
    },
    blocks: {
      dailyNote: {
        append: (body) =>
          pooledSdkCall(pool, "POST /blocks/daily-note/append", (client) =>
            client.blocks.dailyNote.append(body),
          ),
      },
      append: (body) =>
        pooledSdkCall(pool, "POST /blocks/append", (client) =>
          client.blocks.append(body),
        ),
      block: {
        delete: (params) =>
          pooledSdkCall(pool, "DELETE /block", (client) =>
            client.blocks.block.delete(params),
          ),
        update: (body) =>
          pooledSdkCall(pool, "PATCH /blocks/block", (client) =>
            client.blocks.block.update(body),
          ),
      },
    },
  } as CapacitiesClient;
}

export async function getStructures(
  client: CapacitiesClient,
  refresh = false,
  signal?: AbortSignal,
): Promise<SpaceStructure[]> {
  const now = Date.now();
  const session = sessionByClient.get(client);
  const cacheIsFresh =
    session !== undefined &&
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

  if (session !== undefined) {
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
