import {
  CapacitiesApiError,
  CapacitiesClient,
  type SpaceStructure,
} from "@capacities/api";

const STRUCTURE_CACHE_TTL_MS = 5 * 60 * 1000;

type ClientSession = {
  token: string;
  client: CapacitiesClient;
  structures?: SpaceStructure[];
  structuresFetchedAt?: number;
};

let session: ClientSession | undefined;

function resolveToken(apiToken?: string): string {
  const token = apiToken?.trim() || process.env.CAPACITIES_API_TOKEN?.trim();

  if (!token) {
    throw new Error(
      "Capacities authentication is missing. Set CAPACITIES_API_TOKEN or pass apiToken to the tool.",
    );
  }

  return token;
}

export function getClient(apiToken?: string): CapacitiesClient {
  const token = resolveToken(apiToken);

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

  const { structures } = await client.space.structures();

  if (session?.client === client) {
    session.structures = structures;
    session.structuresFetchedAt = now;
  }

  return structures;
}

export function formatError(error: unknown): string {
  if (error instanceof CapacitiesApiError) {
    if (error.code === "cap_rate_limit_exceeded") {
      return `Capacities API ${error.code} (HTTP ${error.status}): Endpoint rate limit exceeded. Wait for its RateLimit reset window before retrying.`;
    }

    const scopeHint = error.scopeDetails?.missingScopes.length
      ? ` Missing scopes: ${error.scopeDetails.missingScopes.join(", ")}.`
      : "";
    const message = /<!doctype|<html[\s>]/i.test(error.message)
      ? "The API returned a non-JSON error response."
      : error.message;

    return `Capacities API ${error.code} (HTTP ${error.status}): ${message}${scopeHint}`;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return "Unexpected Capacities MCP error.";
}

export async function runTool<T extends Record<string, unknown>>(
  operation: () => Promise<T>,
) {
  try {
    return toolResult(await operation());
  } catch (error) {
    throw new Error(formatError(error));
  }
}

export function toolResult<T extends Record<string, unknown>>(data: T) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(data, null, 2),
      },
    ],
    structuredContent: data,
  };
}
