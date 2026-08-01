import { McpToolError, normalizeError, type ToolError } from "./client";
import type { ReadbackVerification } from "./readback";

type MarkdownCreateRollbackOptions = {
  objectId: string;
  cause: ToolError;
  deleteObject: () => Promise<unknown>;
  verifyDeleted: () => Promise<ReadbackVerification>;
};

export async function rollbackMarkdownCreate({
  objectId,
  cause,
  deleteObject,
  verifyDeleted,
}: MarkdownCreateRollbackOptions): Promise<never> {
  try {
    await deleteObject();
  } catch (rollbackError) {
    throw new McpToolError(
      "mcp_partial_failure",
      "The Markdown property patch failed and automatic rollback also failed.",
      {
        stage: "property_patch",
        recoverableObjectId: objectId,
        cause,
        rollbackError: normalizeError(rollbackError),
        recovery:
          "Read the object ID. If it exists, apply update_object or delete_object.",
      },
    );
  }

  const rollback = await verifyDeleted();
  if (!rollback.readbackVerified) {
    throw new McpToolError(
      "mcp_partial_failure",
      "The Markdown property patch failed and rollback could not be verified.",
      {
        stage: "property_patch",
        recoverableObjectId: objectId,
        cause,
        rollback,
        recovery:
          "Read the object ID. If it still exists, apply update_object or delete_object.",
      },
    );
  }

  throw new McpToolError(
    "mcp_transaction_rolled_back",
    "The Markdown property patch failed, so the newly created object was permanently deleted.",
    {
      stage: "property_patch",
      objectId,
      cause,
      rollback,
    },
  );
}
