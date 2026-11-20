export interface RedirectEdge {
  fromPath: string;
  toPath: string;
  active?: boolean;
  deletedAt?: Date | null;
}

export function normalizeRedirectPath(value: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 2048 ||
    value.trim() !== value
  ) {
    throw new TypeError("Redirect paths must be trimmed and contain at most 2048 characters.");
  }
  if (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    /[?#\\]/.test(value) ||
    value.includes("//")
  ) {
    throw new TypeError(
      "Only unambiguous local paths without query, fragment, or repeated slashes are allowed.",
    );
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new TypeError("Invalid URL encoding in redirect path.");
  }
  if (
    /%2f/i.test(value) ||
    /[\u0000-\u001f\u007f]/.test(decoded) ||
    decoded.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new TypeError("Encoded slashes, controls, and traversal segments are forbidden.");
  }
  return value.length > 1 ? value.replace(/\/+$/, "") : value;
}

export function redirectChain(fromPath: string, edges: readonly RedirectEdge[]): string[] {
  const active = new Map(
    edges
      .filter((edge) => edge.active !== false && !edge.deletedAt)
      .map((edge) => [edge.fromPath, edge.toPath]),
  );
  const chain = [fromPath];
  const visited = new Set(chain);
  let current = fromPath;
  while (active.has(current)) {
    current = active.get(current)!;
    if (visited.has(current)) throw new Error("Redirect cycle detected.");
    if (chain.length >= 100) throw new Error("Redirect chain exceeds 100 hops.");
    visited.add(current);
    chain.push(current);
  }
  return chain;
}

export function assertRedirectAllowed(
  fromPath: string,
  toPath: string,
  edges: readonly RedirectEdge[],
): void {
  const from = normalizeRedirectPath(fromPath);
  const to = normalizeRedirectPath(toPath);
  if (from === to) throw new Error("A redirect cannot target itself.");
  redirectChain(from, [...edges, { fromPath: from, toPath: to, active: true }]);
}

export function isRedirectStatus(value: number): boolean {
  return [301, 302, 307, 308].includes(value);
}
