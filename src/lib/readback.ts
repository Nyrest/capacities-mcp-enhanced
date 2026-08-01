import {
  CapacitiesApiError,
  type CapacitiesClient,
  type GetObjectResponse,
  type WritableObjectProperties,
} from "@capacities/api";
import {
  type ApiCallStage,
  apiCall,
  getReadbackMode,
  normalizeError,
  type ToolError,
} from "./client";

export type VerificationStatus =
  | "verified"
  | "mismatch"
  | "readback_failed"
  | "disabled"
  | "not_applicable";

export type WriteState =
  | "verified"
  | "written_unverified"
  | "not_written"
  | "unknown"
  | "not_applicable";

export type ReadbackMismatch = {
  code:
    | "object_id_mismatch"
    | "structure_id_mismatch"
    | "property_mismatch"
    | "collections_mismatch"
    | "block_missing"
    | "block_present_after_delete"
    | "object_present_after_delete"
    | "append_no_new_block"
    | "block_type_mismatch"
    | "block_content_mismatch"
    | "child_ids_mismatch"
    | "generic_mismatch";
  path: string;
  message: string;
};

export type ReadbackVerification = {
  status: VerificationStatus;
  readbackPerformed: boolean;
  readbackVerified: boolean;
  snapshotAt: string;
  snapshotSource: "server_readback" | "mutation_response" | "none";
  writeState: WriteState;
  mismatches?: ReadbackMismatch[];
  readbackError?: ToolError;
  reason?: string;
};

type ReadbackOptions = {
  client: CapacitiesClient;
  id: string;
  fallback: GetObjectResponse;
  check?: (object: GetObjectResponse) => ReadbackMismatch[];
  signal?: AbortSignal;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withReadbackStage(error: unknown, stage: ApiCallStage): ToolError {
  const normalized = normalizeError(error);
  return {
    ...normalized,
    details: {
      ...(isRecord(normalized.details) ? normalized.details : {}),
      stage,
    },
  };
}

export function containsExpectedState(
  actual: unknown,
  expected: unknown,
): boolean {
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((value, index) =>
        containsExpectedState(actual[index], value),
      )
    );
  }
  if (isRecord(expected)) {
    return (
      isRecord(actual) &&
      Object.entries(expected).every(([key, value]) =>
        containsExpectedState(actual[key], value),
      )
    );
  }
  return Object.is(actual, expected);
}

export function checkObjectState(options: {
  id?: string;
  structureId?: string;
  properties?: WritableObjectProperties;
  collections?: string[];
  presentBlockIds?: string[];
  absentBlockIds?: string[];
}) {
  return (object: GetObjectResponse): ReadbackMismatch[] => {
    const mismatches: ReadbackMismatch[] = [];
    if (options.id !== undefined && object.id !== options.id) {
      mismatches.push({
        code: "object_id_mismatch",
        path: "/id",
        message: `Expected ${options.id}, received ${object.id}.`,
      });
    }
    if (
      options.structureId !== undefined &&
      object.structureId !== options.structureId
    ) {
      mismatches.push({
        code: "structure_id_mismatch",
        path: "/structureId",
        message:
          "Expected " +
          options.structureId +
          ", received " +
          object.structureId +
          ".",
      });
    }
    for (const [propertyId, expected] of Object.entries(
      options.properties ?? {},
    )) {
      if (!containsExpectedState(object.properties[propertyId], expected)) {
        mismatches.push({
          code: "property_mismatch",
          path: `/properties/${propertyId}`,
          message: `Property ${propertyId} did not match the requested write.`,
        });
      }
    }
    if (
      options.collections !== undefined &&
      !containsExpectedState(object.collections, options.collections)
    ) {
      mismatches.push({
        code: "collections_mismatch",
        path: "/collections",
        message: "Collections did not match the requested write.",
      });
    }

    const blockIds = new Set(allBlockIds(object));
    for (const blockId of options.presentBlockIds ?? []) {
      if (!blockIds.has(blockId)) {
        mismatches.push({
          code: "block_missing",
          path: `/blocks/${blockId}`,
          message: `Block ${blockId} was not present.`,
        });
      }
    }
    for (const blockId of options.absentBlockIds ?? []) {
      if (blockIds.has(blockId)) {
        mismatches.push({
          code: "block_present_after_delete",
          path: `/blocks/${blockId}`,
          message: `Block ${blockId} was still present.`,
        });
      }
    }
    return mismatches;
  };
}

export function allBlockIds(object: GetObjectResponse): string[] {
  const ids: string[] = [];
  const visit = (blocks: NonNullable<GetObjectResponse["blocks"]>[string]) => {
    for (const block of blocks) {
      ids.push(block.id);
      if (block.type === "TextBlock" || block.type === "GroupBlock") {
        visit(block.blocks);
      } else if (block.type === "GridBlock") {
        for (const column of block.columns) {
          visit(column);
        }
      }
    }
  };

  for (const blocks of Object.values(object.blocks ?? {})) {
    visit(blocks);
  }
  return ids;
}

export async function readbackObject({
  client,
  id,
  fallback,
  check,
  signal,
}: ReadbackOptions): Promise<{
  object: GetObjectResponse;
  verification: ReadbackVerification;
}> {
  if (getReadbackMode() === "off") {
    return {
      object: fallback,
      verification: {
        status: "disabled",
        readbackPerformed: false,
        readbackVerified: false,
        snapshotAt: new Date().toISOString(),
        snapshotSource: "mutation_response",
        writeState: "written_unverified",
        reason: "disabled_by_configuration",
      },
    };
  }

  try {
    const object = await apiCall(() => client.object.get({ id }), {
      signal,
      stage: "readback",
    });
    const mismatches = check?.(object) ?? [];
    return {
      object,
      verification: {
        status: mismatches.length === 0 ? "verified" : "mismatch",
        readbackPerformed: true,
        readbackVerified: mismatches.length === 0,
        snapshotAt: new Date().toISOString(),
        snapshotSource: "server_readback",
        writeState: mismatches.length === 0 ? "verified" : "written_unverified",
        ...(mismatches.length === 0 ? {} : { mismatches }),
      },
    };
  } catch (error) {
    return {
      object: fallback,
      verification: {
        status: "readback_failed",
        readbackPerformed: true,
        readbackVerified: false,
        snapshotAt: new Date().toISOString(),
        snapshotSource: "mutation_response",
        writeState: "written_unverified",
        readbackError: withReadbackStage(error, "readback"),
      },
    };
  }
}

export async function readbackDeletedObject(
  client: CapacitiesClient,
  id: string,
  signal?: AbortSignal,
  force = false,
  stage: ApiCallStage = "readback",
): Promise<ReadbackVerification> {
  if (!force && getReadbackMode() === "off") {
    return {
      status: "disabled",
      readbackPerformed: false,
      readbackVerified: false,
      snapshotAt: new Date().toISOString(),
      snapshotSource: "none",
      writeState: "not_applicable",
      reason: "disabled_by_configuration",
    };
  }

  try {
    await apiCall(() => client.object.get({ id }), {
      signal,
      stage,
    });
    return {
      status: "mismatch",
      readbackPerformed: true,
      readbackVerified: false,
      snapshotAt: new Date().toISOString(),
      snapshotSource: "server_readback",
      writeState: "written_unverified",
      mismatches: [
        {
          code: "object_present_after_delete",
          path: "/object",
          message: `Object ${id} was still readable after deletion.`,
        },
      ],
    };
  } catch (error) {
    if (error instanceof CapacitiesApiError && error.code === "cap_not_found") {
      return {
        status: "verified",
        readbackPerformed: true,
        readbackVerified: true,
        snapshotAt: new Date().toISOString(),
        snapshotSource: "none",
        writeState: "verified",
      };
    }
    return {
      status: "readback_failed",
      readbackPerformed: true,
      readbackVerified: false,
      snapshotAt: new Date().toISOString(),
      snapshotSource: "none",
      writeState: "unknown",
      readbackError: withReadbackStage(error, stage),
    };
  }
}

export function asynchronousVerification(): ReadbackVerification {
  return {
    status: "not_applicable",
    readbackPerformed: false,
    readbackVerified: false,
    snapshotAt: new Date().toISOString(),
    snapshotSource: "none",
    writeState: "not_applicable",
    reason: "Capacities processes daily-note writes asynchronously.",
  };
}
