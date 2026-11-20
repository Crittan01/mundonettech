const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseMaterializedSegments(path: string, label: string): string[] {
  const segments = path.split("/").filter(Boolean);
  if (
    !path.startsWith("/") ||
    !path.endsWith("/") ||
    segments.length === 0 ||
    path !== `/${segments.join("/")}/` ||
    !segments.every((id) => uuidPattern.test(id))
  ) {
    throw new TypeError(`Invalid ${label}.`);
  }
  return segments;
}

export function buildCategoryPath(categoryId: string, parentPath?: string): string {
  if (!uuidPattern.test(categoryId)) throw new TypeError("categoryId must be a UUID.");
  const normalizedId = categoryId.toLowerCase();
  if (parentPath === undefined) return `/${normalizedId}/`;
  const parentSegments = parseMaterializedSegments(parentPath, "parent materialized path");
  if (parentSegments.some((segment) => segment.toLowerCase() === normalizedId)) {
    throw new Error("Category materialized path cannot contain duplicate ancestor IDs.");
  }
  return `/${parentSegments.map((segment) => segment.toLowerCase()).join("/")}/${normalizedId}/`;
}

export function categoryDepth(materializedPath: string): number {
  const segments = parseMaterializedSegments(materializedPath, "category path");
  return segments.length - 1;
}

export function assertCategoryMove(options: {
  categoryId: string;
  parentId: string | null;
  currentPath: string;
  parentPath?: string;
  hasChildren: boolean;
}): void {
  if (!uuidPattern.test(options.categoryId)) throw new TypeError("categoryId must be a UUID.");
  const currentId = options.categoryId.toLowerCase();
  const currentSegments = parseMaterializedSegments(options.currentPath, "currentPath");
  if (currentSegments.at(-1)?.toLowerCase() !== currentId) {
    throw new TypeError("currentPath must end with categoryId.");
  }

  if (options.parentId === null) {
    if (options.hasChildren) throw new Error("Move children before moving a subtree to root.");
    return;
  }

  if (!uuidPattern.test(options.parentId)) throw new TypeError("parentId must be a UUID.");
  const targetParentId = options.parentId.toLowerCase();
  if (targetParentId === currentId) {
    throw new Error("A category cannot be its own parent.");
  }
  if (!options.parentPath) throw new Error("The new parent must have a materialized path.");
  const parentSegments = parseMaterializedSegments(options.parentPath, "parentPath");
  if (parentSegments.at(-1)?.toLowerCase() !== targetParentId) {
    throw new TypeError("parentPath must end with parentId.");
  }
  const normalizedCurrent = `/${currentSegments.map((segment) => segment.toLowerCase()).join("/")}/`;
  const normalizedParent = `/${parentSegments.map((segment) => segment.toLowerCase()).join("/")}/`;
  if (normalizedParent.startsWith(normalizedCurrent)) {
    throw new Error("A category cannot move below its descendant.");
  }
  if (options.hasChildren) {
    throw new Error("Move is allowed only for leaf categories; move descendants first.");
  }
}
