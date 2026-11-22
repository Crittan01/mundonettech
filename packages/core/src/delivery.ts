export interface DeliveryPoint {
  readonly latitudeE6: number;
  readonly longitudeE6: number;
}

export class DeliveryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeliveryValidationError";
  }
}

function coordinate(value: number, field: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new DeliveryValidationError(
      `${field} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
  return value;
}

export function assertDeliveryPoint(point: DeliveryPoint): DeliveryPoint {
  return {
    latitudeE6: coordinate(point.latitudeE6, "latitudeE6", -90_000_000, 90_000_000),
    longitudeE6: coordinate(point.longitudeE6, "longitudeE6", -180_000_000, 180_000_000),
  };
}

function cross(a: DeliveryPoint, b: DeliveryPoint, c: DeliveryPoint): bigint {
  return (
    (BigInt(b.longitudeE6) - BigInt(a.longitudeE6)) *
      (BigInt(c.latitudeE6) - BigInt(a.latitudeE6)) -
    (BigInt(b.latitudeE6) - BigInt(a.latitudeE6)) * (BigInt(c.longitudeE6) - BigInt(a.longitudeE6))
  );
}

function onSegment(a: DeliveryPoint, b: DeliveryPoint, point: DeliveryPoint): boolean {
  return (
    cross(a, b, point) === 0n &&
    point.longitudeE6 >= Math.min(a.longitudeE6, b.longitudeE6) &&
    point.longitudeE6 <= Math.max(a.longitudeE6, b.longitudeE6) &&
    point.latitudeE6 >= Math.min(a.latitudeE6, b.latitudeE6) &&
    point.latitudeE6 <= Math.max(a.latitudeE6, b.latitudeE6)
  );
}

function segmentsIntersect(
  a: DeliveryPoint,
  b: DeliveryPoint,
  c: DeliveryPoint,
  d: DeliveryPoint,
): boolean {
  const first = cross(a, b, c);
  const second = cross(a, b, d);
  const third = cross(c, d, a);
  const fourth = cross(c, d, b);
  if (first > 0n !== second > 0n && third > 0n !== fourth > 0n) return true;
  return (
    (first === 0n && onSegment(a, b, c)) ||
    (second === 0n && onSegment(a, b, d)) ||
    (third === 0n && onSegment(c, d, a)) ||
    (fourth === 0n && onSegment(c, d, b))
  );
}

export function assertDeliveryPolygon(points: readonly DeliveryPoint[]): readonly DeliveryPoint[] {
  if (!Array.isArray(points) || points.length < 3 || points.length > 500) {
    throw new DeliveryValidationError(
      "A delivery polygon must contain between 3 and 500 vertices.",
    );
  }
  const normalized = points.map(assertDeliveryPoint);
  const area = normalized.reduce((sum, point, index) => {
    const next = normalized[(index + 1) % normalized.length]!;
    return (
      sum +
      BigInt(point.longitudeE6) * BigInt(next.latitudeE6) -
      BigInt(next.longitudeE6) * BigInt(point.latitudeE6)
    );
  }, 0n);
  if (area === 0n)
    throw new DeliveryValidationError("A delivery polygon must have a non-zero area.");
  for (let first = 0; first < normalized.length; first += 1) {
    const firstNext = (first + 1) % normalized.length;
    const a = normalized[first]!;
    const b = normalized[firstNext]!;
    if (a.latitudeE6 === b.latitudeE6 && a.longitudeE6 === b.longitudeE6) {
      throw new DeliveryValidationError("Consecutive polygon vertices must be distinct.");
    }
    for (let second = first + 1; second < normalized.length; second += 1) {
      const secondNext = (second + 1) % normalized.length;
      if (first === second || firstNext === second || secondNext === first) continue;
      if (segmentsIntersect(a, b, normalized[second]!, normalized[secondNext]!)) {
        throw new DeliveryValidationError("A delivery polygon cannot intersect itself.");
      }
    }
  }
  return normalized;
}

export function pointInDeliveryPolygon(
  pointInput: DeliveryPoint,
  polygon: readonly DeliveryPoint[],
): boolean {
  const point = assertDeliveryPoint(pointInput);
  const vertices = assertDeliveryPolygon(polygon);
  let inside = false;
  for (let index = 0; index < vertices.length; index += 1) {
    const a = vertices[index]!;
    const b = vertices[(index + 1) % vertices.length]!;
    if (onSegment(a, b, point)) return true;
    if (a.latitudeE6 > point.latitudeE6 === b.latitudeE6 > point.latitudeE6) continue;
    const denominator = BigInt(b.latitudeE6) - BigInt(a.latitudeE6);
    const left = (BigInt(point.longitudeE6) - BigInt(a.longitudeE6)) * denominator;
    const right =
      (BigInt(point.latitudeE6) - BigInt(a.latitudeE6)) *
      (BigInt(b.longitudeE6) - BigInt(a.longitudeE6));
    if (denominator > 0n ? left < right : left > right) inside = !inside;
  }
  return inside;
}

export function localDeliveryPromise(options: {
  readonly now: Date;
  readonly cutoffMinutes: number;
  readonly deliveryPromiseMinutes: number;
  readonly timeZone: string;
}): Date {
  if (!(options.now instanceof Date) || Number.isNaN(options.now.getTime())) {
    throw new DeliveryValidationError("now must be a valid Date.");
  }
  if (
    !Number.isInteger(options.cutoffMinutes) ||
    options.cutoffMinutes < 0 ||
    options.cutoffMinutes > 1439
  ) {
    throw new DeliveryValidationError("cutoffMinutes must be between 0 and 1439.");
  }
  if (
    !Number.isInteger(options.deliveryPromiseMinutes) ||
    options.deliveryPromiseMinutes < 5 ||
    options.deliveryPromiseMinutes > 10080
  ) {
    throw new DeliveryValidationError("deliveryPromiseMinutes must be between 5 and 10080.");
  }
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: options.timeZone,
      hourCycle: "h23",
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(options.now);
  } catch {
    throw new DeliveryValidationError("timeZone must be a valid IANA time zone.");
  }
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) {
    throw new DeliveryValidationError("Unable to resolve the local delivery cutoff.");
  }
  const afterCutoff = hour * 60 + minute >= options.cutoffMinutes;
  return new Date(
    options.now.getTime() +
      (afterCutoff ? 86_400_000 : 0) +
      options.deliveryPromiseMinutes * 60_000,
  );
}
