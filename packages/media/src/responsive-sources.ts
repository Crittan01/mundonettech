export interface PictureSource {
  srcSet: string;
  type?: string;
  sizes?: string;
}

export interface SpinFrame {
  src: string;
  srcSet?: string;
  sizes?: string;
  sources?: readonly PictureSource[];
  width: number;
  height: number;
}

export interface ResponsiveDerivativeDescriptor {
  format: "avif" | "webp";
  width: number;
  height: number;
  publicUrl?: string | null;
  key?: string;
}

export interface PictureSourceSet {
  src: string;
  width: number;
  height: number;
  sources: PictureSource[];
}

const loopbackHostnames = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export function isSafeMediaUrl(value: string): boolean {
  if (
    typeof value !== "string" ||
    !value ||
    value.trim() !== value ||
    /[\u0000-\u0020\u007f,\\]/.test(value)
  ) {
    return false;
  }
  if (value.startsWith("/")) {
    return !value.startsWith("//");
  }
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password) return false;
    if (parsed.protocol === "https:") return true;
    if (parsed.protocol === "http:" && loopbackHostnames.has(parsed.hostname.toLowerCase())) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export function isSafeSrcSet(srcSet: string): boolean {
  const candidates = srcSet
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (candidates.length === 0) return false;
  return candidates.every((entry) => {
    const parts = entry.split(/\s+/);
    if (parts.length < 1 || parts.length > 2) return false;
    const [url, descriptor] = parts;
    if (!url || !isSafeMediaUrl(url)) return false;
    return descriptor === undefined || /^[1-9][0-9]*(?:w|x|\.[0-9]+x)$/.test(descriptor);
  });
}

function normalizeMediaBaseUrl(baseUrl: string): string {
  if (!isSafeMediaUrl(baseUrl) || baseUrl.startsWith("/")) {
    if (baseUrl.startsWith("/") && isSafeMediaUrl(baseUrl) && !/[?#]/.test(baseUrl)) {
      return baseUrl.replace(/\/+$/, "");
    }
    throw new TypeError("Unsafe media base URL.");
  }
  const parsed = new URL(baseUrl);
  if (parsed.search || parsed.hash) {
    throw new TypeError("Media base URL cannot include query parameters or fragments.");
  }
  const pathname = parsed.pathname.replace(/\/+$/, "");
  return `${parsed.origin}${pathname}`;
}

function resolveDerivativeUrl(
  derivative: ResponsiveDerivativeDescriptor,
  baseUrl?: string,
): string {
  if (derivative.publicUrl) {
    if (!isSafeMediaUrl(derivative.publicUrl)) {
      throw new TypeError("Unsafe derivative public URL.");
    }
    return derivative.publicUrl;
  }
  if (baseUrl && derivative.key) {
    if (
      derivative.key.trim() !== derivative.key ||
      derivative.key.length > 500 ||
      derivative.key.startsWith("/") ||
      derivative.key.endsWith("/") ||
      derivative.key.includes("\\") ||
      /[\u0000-\u001f\u007f]/.test(derivative.key) ||
      derivative.key.split("/").some((part) => !part || part === "." || part === "..")
    ) {
      throw new TypeError("Unsafe derivative storage key.");
    }
    const cleanBase = normalizeMediaBaseUrl(baseUrl);
    const encodedKey = derivative.key.split("/").map(encodeURIComponent).join("/");
    const candidate = `${cleanBase}/${encodedKey}`;
    if (!isSafeMediaUrl(candidate)) {
      throw new TypeError("Unsafe resolved media URL.");
    }
    return candidate;
  }
  throw new TypeError("Each media derivative requires a publicUrl or baseUrl + key.");
}

export function buildPictureSources(
  derivatives: readonly ResponsiveDerivativeDescriptor[],
  options: { baseUrl?: string; sizes?: string } = {},
): PictureSourceSet {
  if (derivatives.length === 0) {
    throw new RangeError("At least one image derivative is required.");
  }

  const seen = new Set<string>();
  const resolved = derivatives
    .map((item) => {
      if (item.format !== "avif" && item.format !== "webp") {
        throw new TypeError("Derivative format must be avif or webp.");
      }
      if (
        !Number.isSafeInteger(item.width) ||
        !Number.isSafeInteger(item.height) ||
        item.width < 1 ||
        item.height < 1
      ) {
        throw new RangeError("Derivative dimensions must be positive integers.");
      }
      const pairKey = `${item.format}:${item.width}`;
      if (seen.has(pairKey)) {
        throw new RangeError("Duplicate derivative format and width are not allowed.");
      }
      seen.add(pairKey);
      return { ...item, url: resolveDerivativeUrl(item, options.baseUrl) };
    })
    .sort((a, b) => a.width - b.width);

  const sources: PictureSource[] = [];
  for (const [format, mimeType] of [
    ["avif", "image/avif"],
    ["webp", "image/webp"],
  ] as const) {
    const matching = resolved.filter((item) => item.format === format);
    if (matching.length > 0) {
      sources.push({
        type: mimeType,
        srcSet: matching.map((item) => `${item.url} ${item.width}w`).join(", "),
        ...(options.sizes ? { sizes: options.sizes } : {}),
      });
    }
  }

  const preferredFallback =
    resolved.filter((item) => item.format === "webp").at(-1) ?? resolved.at(-1)!;
  return {
    src: preferredFallback.url,
    width: preferredFallback.width,
    height: preferredFallback.height,
    sources,
  };
}

export function buildSpinFrames(
  frames: readonly { frame: number; derivatives: readonly ResponsiveDerivativeDescriptor[] }[],
  options: { baseUrl?: string; sizes?: string } = {},
): SpinFrame[] {
  if (frames.length < 2 || frames.length > 120) {
    throw new RangeError("SPIN_360 requires between 2 and 120 frames.");
  }
  const ordered = [...frames].sort((a, b) => a.frame - b.frame);
  if (ordered.some((entry, index) => !Number.isSafeInteger(entry.frame) || entry.frame !== index)) {
    throw new RangeError("SPIN_360 frame indices must be unique and contiguous from zero.");
  }
  return ordered.map((entry) => {
    const picture = buildPictureSources(entry.derivatives, options);
    return {
      src: picture.src,
      width: picture.width,
      height: picture.height,
      ...(options.sizes ? { sizes: options.sizes } : {}),
      sources: picture.sources,
    };
  });
}
