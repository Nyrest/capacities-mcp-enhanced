import type { ApiBlock, GetObjectResponse } from "@capacities/api";

export type LocatedBlock = {
  block: ApiBlock;
  propertyId: string;
  parentBlockId?: string;
};

export function childBlocks(block: ApiBlock): ApiBlock[] {
  switch (block.type) {
    case "TextBlock":
    case "GroupBlock":
      return block.blocks;
    case "GridBlock":
      return block.columns.flat();
    default:
      return [];
  }
}

function findInTree(
  blocks: ApiBlock[],
  blockId: string,
  propertyId: string,
  parentBlockId?: string,
): LocatedBlock | undefined {
  for (const block of blocks) {
    if (block.id === blockId) {
      return { block, propertyId, parentBlockId };
    }

    const nested = findInTree(
      childBlocks(block),
      blockId,
      propertyId,
      block.id,
    );
    if (nested) {
      return nested;
    }
  }

  return undefined;
}

export function findBlock(
  object: GetObjectResponse,
  blockId: string,
  propertyId?: string,
): LocatedBlock | undefined {
  if (!object.blocks) {
    return undefined;
  }

  if (propertyId !== undefined) {
    return findInTree(object.blocks[propertyId] ?? [], blockId, propertyId);
  }

  for (const [candidatePropertyId, blocks] of Object.entries(object.blocks)) {
    const found = findInTree(blocks, blockId, candidatePropertyId);
    if (found) {
      return found;
    }
  }

  return undefined;
}

export function requireBlock(
  object: GetObjectResponse,
  blockId: string,
  propertyId?: string,
): LocatedBlock {
  const found = findBlock(object, blockId, propertyId);
  if (!found) {
    const scope = propertyId ? ` in block property "${propertyId}"` : "";
    throw new Error(
      `Block "${blockId}" was not found${scope}. Read the object in structured mode and use a current block ID.`,
    );
  }
  return found;
}

export function resolveAppendPropertyId(
  object: GetObjectResponse,
  options: {
    propertyId?: string;
    parentBlockId?: string;
    afterBlockId?: string;
  },
): string | undefined {
  const { propertyId, parentBlockId, afterBlockId } = options;

  if (parentBlockId) {
    const parent = requireBlock(object, parentBlockId, propertyId);
    if (
      parent.block.type !== "TextBlock" &&
      parent.block.type !== "GroupBlock"
    ) {
      throw new Error(
        `Block "${parentBlockId}" is ${parent.block.type}; only TextBlock and GroupBlock may contain appended children.`,
      );
    }
    return parent.propertyId;
  }

  if (afterBlockId) {
    return requireBlock(object, afterBlockId, propertyId).propertyId;
  }

  return propertyId;
}
