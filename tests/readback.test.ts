import { afterEach, describe, expect, test } from "bun:test";
import {
  CapacitiesApiError,
  type CapacitiesClient,
  type GetObjectResponse,
} from "@capacities/api";
import {
  asynchronousVerification,
  checkObjectState,
  containsExpectedState,
  readbackDeletedObject,
  readbackObject,
} from "../src/lib/readback";

const objectId = "11111111-1111-4111-8111-111111111111";
const structureId = "22222222-2222-4222-8222-222222222222";
const propertyId = "33333333-3333-4333-8333-333333333333";
const collectionId = "44444444-4444-4444-8444-444444444444";
const readbackEnv = "CAPACITIES_MCP_READBACK";
const originalReadbackValue = process.env[readbackEnv];

afterEach(() => {
  if (originalReadbackValue === undefined) {
    delete process.env[readbackEnv];
  } else {
    process.env[readbackEnv] = originalReadbackValue;
  }
});

function objectFixture(title = "After"): GetObjectResponse {
  return {
    id: objectId,
    structureId,
    collections: [collectionId],
    properties: {
      [propertyId]: {
        type: "title",
        title: { value: title },
      },
    },
    blocks: {
      root: [
        {
          id: "55555555-5555-4555-8555-555555555555",
          type: "TextBlock",
          tokens: [{ type: "TextToken", text: "Body" }],
          hierarchy: { key: "Base", val: 0 },
          blocks: [],
        },
      ],
    },
  };
}

function clientWithGet(
  get: () => Promise<GetObjectResponse>,
): CapacitiesClient {
  return {
    object: { get },
  } as unknown as CapacitiesClient;
}

describe("synchronous mutation readback", () => {
  test("matches requested block content while allowing server-assigned IDs", () => {
    expect(
      containsExpectedState(
        {
          id: "55555555-5555-4555-8555-555555555555",
          type: "TextBlock",
          tokens: [{ type: "TextToken", text: "Updated", style: {} }],
          hierarchy: { key: "Base", val: 0 },
          blocks: [],
        },
        {
          type: "TextBlock",
          tokens: [{ type: "TextToken", text: "Updated" }],
          hierarchy: { key: "Base", val: 0 },
        },
      ),
    ).toBe(true);
  });

  test("returns the independent GET snapshot when requested state matches", async () => {
    const fallback = objectFixture("Mutation response");
    const server = objectFixture("After");
    const result = await readbackObject({
      client: clientWithGet(async () => server),
      id: objectId,
      fallback,
      check: checkObjectState({
        id: objectId,
        structureId,
        properties: {
          [propertyId]: {
            type: "title",
            title: { value: "After" },
          },
        },
        collections: [collectionId],
        presentBlockIds: ["55555555-5555-4555-8555-555555555555"],
      }),
    });

    expect(result.object).toBe(server);
    expect(result.verification).toMatchObject({
      readbackPerformed: true,
      readbackVerified: true,
      snapshotSource: "server_readback",
      writeState: "verified",
    });
  });

  test("reports semantic mismatches without replaying the mutation", async () => {
    let reads = 0;
    const result = await readbackObject({
      client: clientWithGet(async () => {
        reads += 1;
        return objectFixture("Old");
      }),
      id: objectId,
      fallback: objectFixture("Mutation response"),
      check: checkObjectState({
        properties: {
          [propertyId]: {
            type: "title",
            title: { value: "After" },
          },
        },
      }),
    });

    expect(reads).toBe(1);
    expect(result.object.properties[propertyId]).toMatchObject({
      title: { value: "Old" },
    });
    expect(result.verification).toMatchObject({
      readbackPerformed: true,
      readbackVerified: false,
      snapshotSource: "server_readback",
      writeState: "written_unverified",
    });
    expect(result.verification.mismatches).toHaveLength(1);
  });

  test("keeps the mutation response when GET readback fails", async () => {
    const fallback = objectFixture("Mutation response");
    const result = await readbackObject({
      client: clientWithGet(async () => {
        throw new TypeError("network failed");
      }),
      id: objectId,
      fallback,
    });

    expect(result.object).toBe(fallback);
    expect(result.verification).toMatchObject({
      readbackPerformed: true,
      readbackVerified: false,
      snapshotSource: "mutation_response",
      writeState: "written_unverified",
      readbackError: {
        code: "mcp_unexpected",
        message: "network failed",
      },
    });
  });

  test("treats cap_not_found as verified deletion", async () => {
    const verification = await readbackDeletedObject(
      clientWithGet(async () => {
        throw new CapacitiesApiError(404, "cap_not_found", "Not found.");
      }),
      objectId,
    );

    expect(verification).toMatchObject({
      readbackPerformed: true,
      readbackVerified: true,
      snapshotSource: "none",
      writeState: "verified",
    });
  });

  test("can disable ordinary readback while preserving forced rollback verification", async () => {
    process.env[readbackEnv] = "off";
    let reads = 0;
    const client = clientWithGet(async () => {
      reads += 1;
      throw new CapacitiesApiError(404, "cap_not_found", "Not found.");
    });

    const ordinary = await readbackObject({
      client,
      id: objectId,
      fallback: objectFixture("Mutation response"),
    });
    expect(ordinary.verification).toMatchObject({
      status: "disabled",
      readbackPerformed: false,
      snapshotSource: "mutation_response",
      writeState: "written_unverified",
    });
    expect(reads).toBe(0);

    const rollback = await readbackDeletedObject(
      client,
      objectId,
      undefined,
      true,
    );
    expect(rollback).toMatchObject({
      status: "verified",
      readbackPerformed: true,
      readbackVerified: true,
    });
    expect(reads).toBe(1);
  });

  test("marks daily-note writes as asynchronous and not read back", () => {
    expect(asynchronousVerification()).toMatchObject({
      readbackPerformed: false,
      readbackVerified: false,
      snapshotSource: "none",
      writeState: "not_applicable",
      reason: "Capacities processes daily-note writes asynchronously.",
    });
  });
});
