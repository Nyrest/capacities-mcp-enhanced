import { describe, expect, test } from "bun:test";
import { McpToolError, normalizeError } from "../src/lib/client";
import { rollbackMarkdownCreate } from "../src/lib/transactions";

const objectId = "11111111-1111-4111-8111-111111111111";
const cause = normalizeError(new Error("property rejected"));

describe("create_object_markdown rollback", () => {
  test("reports a verified transaction rollback", async () => {
    let deletes = 0;

    try {
      await rollbackMarkdownCreate({
        objectId,
        cause,
        deleteObject: async () => {
          deletes += 1;
        },
        verifyDeleted: async () => ({
          readbackPerformed: true,
          readbackVerified: true,
          snapshotAt: "2026-07-31T00:00:00.000Z",
          snapshotSource: "none",
        }),
      });
    } catch (error) {
      expect(error).toBeInstanceOf(McpToolError);
      expect((error as McpToolError).code).toBe("mcp_transaction_rolled_back");
      expect((error as McpToolError).details).toMatchObject({
        stage: "property_patch",
        objectId,
        cause,
      });
    }

    expect(deletes).toBe(1);
  });

  test("returns a recoverable object ID when hard deletion fails", async () => {
    expect.assertions(3);

    try {
      await rollbackMarkdownCreate({
        objectId,
        cause,
        deleteObject: async () => {
          throw new Error("delete failed");
        },
        verifyDeleted: async () => {
          throw new Error("must not run");
        },
      });
    } catch (error) {
      expect((error as McpToolError).code).toBe("mcp_partial_failure");
      expect((error as McpToolError).details).toMatchObject({
        stage: "property_patch",
        recoverableObjectId: objectId,
        cause,
      });
      expect((error as McpToolError).details).toMatchObject({
        rollbackError: { code: "mcp_invalid_request" },
      });
    }
  });

  test("returns a recoverable object ID when deletion cannot be verified", async () => {
    expect.assertions(2);

    try {
      await rollbackMarkdownCreate({
        objectId,
        cause,
        deleteObject: async () => undefined,
        verifyDeleted: async () => ({
          readbackPerformed: true,
          readbackVerified: false,
          snapshotAt: "2026-07-31T00:00:00.000Z",
          snapshotSource: "server_readback",
          mismatches: [
            {
              code: "object_present_after_delete",
              path: "/object",
              message: "Object was still readable.",
            },
          ],
        }),
      });
    } catch (error) {
      expect((error as McpToolError).code).toBe("mcp_partial_failure");
      expect((error as McpToolError).details).toMatchObject({
        stage: "property_patch",
        recoverableObjectId: objectId,
        rollback: { readbackVerified: false },
      });
    }
  });
});
