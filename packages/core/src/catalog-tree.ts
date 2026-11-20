const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function buildCategoryPath(categoryId: string, parentPath?: string): string {
  if (!uuidPattern.test(categoryId)) throw new TypeError("categoryId must be a UUID.");
  if (parentPath === undefined) return `/${categoryId.toLowerCase()}/`;
  const segments = parentPath.split("/").filter(Boolean);
  if (
    !parentPath.startsWith("/") ||
    !parentPath.endsWith("/") ||
    !segments.every((id) => uuidPattern.test(id))
  ) {
    throw new TypeError("Invalid parent materialized path.");
  }
  return `${parentPath}${categoryId.toLowerCase()}/`;
}

export function categoryDepth(materializedPath: string): number {
  const segments = materializedPath.split("/").filter(Boolean);
  if (segments.length === 0 || !segments.every((id) => uuidPattern.test(id)))
    throw new TypeError("Invalid category path.");
  return segments.length - 1;
}

export function assertCategoryMove(options: {
  categoryId: string;
  parentId: string | null;
  currentPath: string;
  parentPath?: string;
  hasChildren: boolean;
}): void {
  if (options.parentId === null) {
    if (options.hasChildren) throw new Error("Move children before moving a subtree to root.");
    return;
  }
  if (options.parentId === options.categoryId)
    throw new Error("A category cannot be its own parent.");
  if (!options.parentPath) throw new Error("The new parent must have a materialized path.");
  if (options.parentPath.startsWith(options.currentPath))
    throw new Error("A category cannot move below its descendant.");
  if (options.hasChildren)
    throw new Error("Move is allowed only for leaf categories; move descendants first.");
}
