export interface RedirectEdge {
  id?: string;
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
    value.includes("//") ||
    /%[0-9a-f]{0,1}(?![0-9a-f])/i.test(value)
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
    /%2f|%2e/i.test(value) ||
    /[\u0000-\u001f\u007f]/.test(decoded) ||
    value.split("/").some((part) => part === "." || part === "..") ||
    decoded.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new TypeError("Encoded slashes, controls, and traversal segments are forbidden.");
  }
  return value.length > 1 ? value.replace(/\/+$/, "") : value;
}

export function redirectChain(fromPath: string, edges: readonly RedirectEdge[]): string[] {
  const normalizedStart = normalizeRedirectPath(fromPath);
  const active = new Map(
    edges
      .filter((edge) => edge.active !== false && !edge.deletedAt)
      .map((edge) => [normalizeRedirectPath(edge.fromPath), normalizeRedirectPath(edge.toPath)]),
  );
  const chain = [normalizedStart];
  const visited = new Set(chain);
  let current = normalizedStart;
  while (active.has(current)) {
    current = active.get(current)!;
    if (visited.has(current)) throw new Error("Redirect cycle detected.");
    if (chain.length > 100) throw new Error("Redirect chain exceeds 100 hops.");
    visited.add(current);
    chain.push(current);
  }
  if (chain.length - 1 > 100) throw new Error("Redirect chain exceeds 100 hops.");
  return chain;
}

export function assertRedirectAllowed(
  fromPath: string,
  toPath: string,
  edges: readonly RedirectEdge[],
  options?: { excludeId?: string },
): void {
  const from = normalizeRedirectPath(fromPath);
  const to = normalizeRedirectPath(toPath);
  if (from === to) throw new Error("A redirect cannot target itself.");

  const filtered = edges.filter(
    (edge) =>
      edge.active !== false &&
      !edge.deletedAt &&
      (options?.excludeId === undefined || edge.id !== options.excludeId) &&
      normalizeRedirectPath(edge.fromPath) !== from,
  );
  const candidateGraph: RedirectEdge[] = [
    ...filtered,
    { fromPath: from, toPath: to, active: true },
  ];

  // Validate starting from the new source and from every active source that reaches it.
  redirectChain(from, candidateGraph);
  for (const edge of candidateGraph) {
    redirectChain(edge.fromPath, candidateGraph);
  }
}

export const reservedRedirectSourcePrefixes = [
  "/api",
  "/_next",
  "/admin",
  "/email",
  "/mi-cuenta",
  "/ingresar",
  "/registro",
  "/recuperar",
  "/verificar-correo",
  "/legal",
  "/ayuda",
  "/robots.txt",
  "/sitemap.xml",
  "/sitemaps",
  "/carrito",
  "/checkout",
  "/recibo",
  "/pagar",
  "/pedido",
  "/referido",
  "/propuesta",
  "/empresas",
] as const;

export const reservedRedirectTargetPrefixes = ["/api", "/_next", "/admin", "/email"] as const;

function hasRedirectPathPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

export function isReservedRedirectSource(normalizedPath: string): boolean {
  return (
    normalizedPath === "/" ||
    reservedRedirectSourcePrefixes.some((prefix) => hasRedirectPathPrefix(normalizedPath, prefix))
  );
}

export function isReservedRedirectTarget(normalizedPath: string): boolean {
  return reservedRedirectTargetPrefixes.some((prefix) =>
    hasRedirectPathPrefix(normalizedPath, prefix),
  );
}

export function isRedirectStatus(value: number): boolean {
  return [301, 302, 307, 308].includes(value);
}
