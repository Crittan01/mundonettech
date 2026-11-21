import type { DateLike } from "./types.js";

export const colombiaTimeZone = "America/Bogota";
export const retractBusinessDays = 5;
export const retractRefundCalendarDays = 15;
export const defaultDeliveryCalendarDays = 30;

const millisecondsPerDay = 86_400_000;
const datePattern = /^(\d{4})-(\d{2})-(\d{2})$/;
const bogotaFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: colombiaTimeZone,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export interface ColombianHoliday {
  readonly date: string;
  readonly name: string;
}

export interface RetractWindow {
  readonly deliveryDate: string;
  readonly dueDate: string;
  readonly businessDays: 5;
}

function assertYear(year: number): void {
  if (!Number.isInteger(year) || year < 1900 || year > 9999) {
    throw new RangeError("Colombian calendar supports integer years between 1900 and 9999.");
  }
}

function utcDate(year: number, month: number, day: number): Date {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new TypeError("Invalid calendar date.");
  }
  return date;
}

export function formatDateOnly(date: Date): string {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new TypeError("A valid Date is required.");
  }
  const year = date.getUTCFullYear();
  if (year < 0 || year > 9999) throw new RangeError("Date is outside the supported calendar.");
  return `${String(year).padStart(4, "0")}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

export function parseDateOnly(value: string): Date {
  const match = datePattern.exec(value);
  if (!match) throw new TypeError("Date-only values must use YYYY-MM-DD.");
  return utcDate(Number(match[1]), Number(match[2]), Number(match[3]));
}

export function addCalendarDays(value: string, days: number): string {
  if (!Number.isInteger(days) || Math.abs(days) > 36_500) {
    throw new RangeError("Calendar-day offset must be an integer within 36500 days.");
  }
  const date = parseDateOnly(value);
  return formatDateOnly(new Date(date.getTime() + days * millisecondsPerDay));
}

function mondayOnOrAfter(year: number, month: number, day: number): string {
  const date = utcDate(year, month, day);
  const offset = (8 - date.getUTCDay()) % 7;
  return formatDateOnly(new Date(date.getTime() + offset * millisecondsPerDay));
}

export function easterSunday(year: number): string {
  assertYear(year);
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return formatDateOnly(utcDate(year, month, day));
}

export function colombianHolidays(year: number): readonly ColombianHoliday[] {
  assertYear(year);
  const easter = easterSunday(year);
  const fixed = [
    ["01-01", "Año Nuevo"],
    ["05-01", "Día del Trabajo"],
    ["07-20", "Independencia de Colombia"],
    ["08-07", "Batalla de Boyacá"],
    ["12-08", "Inmaculada Concepción"],
    ["12-25", "Navidad"],
  ] as const;
  const emiliani = [
    [1, 6, "Reyes Magos"],
    [3, 19, "San José"],
    [6, 29, "San Pedro y San Pablo"],
    [8, 15, "Asunción de la Virgen"],
    [10, 12, "Día de la Raza"],
    [11, 1, "Todos los Santos"],
    [11, 11, "Independencia de Cartagena"],
  ] as const;
  const holidays: ColombianHoliday[] = [
    ...fixed.map(([monthDay, name]) => ({ date: `${year}-${monthDay}`, name })),
    ...emiliani.map(([month, day, name]) => ({
      date: mondayOnOrAfter(year, month, day),
      name,
    })),
    { date: addCalendarDays(easter, -3), name: "Jueves Santo" },
    { date: addCalendarDays(easter, -2), name: "Viernes Santo" },
    { date: addCalendarDays(easter, 43), name: "Ascensión del Señor" },
    { date: addCalendarDays(easter, 64), name: "Corpus Christi" },
    { date: addCalendarDays(easter, 71), name: "Sagrado Corazón" },
  ];
  if (holidays.length !== 18) {
    throw new Error("Colombian holiday calendar invariant failed.");
  }
  return holidays.sort((left, right) => left.date.localeCompare(right.date));
}

export function isColombianBusinessDay(value: string): boolean {
  const date = parseDateOnly(value);
  const weekday = date.getUTCDay();
  if (weekday === 0 || weekday === 6) return false;
  const year = date.getUTCFullYear();
  return !colombianHolidays(year).some((holiday) => holiday.date === value);
}

export function addColombianBusinessDays(value: string, days: number): string {
  parseDateOnly(value);
  if (!Number.isInteger(days) || days < 0 || days > 3650) {
    throw new RangeError("Business-day count must be an integer between 0 and 3650.");
  }
  let current = value;
  let remaining = days;
  let guard = 0;
  while (remaining > 0) {
    current = addCalendarDays(current, 1);
    if (isColombianBusinessDay(current)) remaining -= 1;
    guard += 1;
    if (guard > 7500) throw new Error("Business-day calendar bound exceeded.");
  }
  return current;
}

function assertDate(value: DateLike, field: string): Date {
  if (
    typeof value === "string" &&
    !datePattern.test(value) &&
    !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)
  ) {
    throw new TypeError(`${field} must include an explicit timezone offset.`);
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError(`${field} must be a valid date.`);
  return date;
}

export function bogotaDateOnly(value: DateLike): string {
  if (typeof value === "string" && datePattern.test(value)) {
    return formatDateOnly(parseDateOnly(value));
  }
  const date = assertDate(value, "value");
  const parts = bogotaFormatter.formatToParts(date);
  const get = (type: "year" | "month" | "day") => {
    const part = parts.find((item) => item.type === type);
    if (!part) throw new Error("Unable to resolve Bogotá calendar date.");
    return part.value;
  };
  return parseDateOnly(`${get("year")}-${get("month")}-${get("day")}`)
    .toISOString()
    .slice(0, 10);
}

export function calculateRetractWindow(deliveredAt: DateLike): RetractWindow {
  const deliveryDate = bogotaDateOnly(deliveredAt);
  return {
    deliveryDate,
    dueDate: addColombianBusinessDays(deliveryDate, retractBusinessDays),
    businessDays: retractBusinessDays,
  };
}

export function evaluateRetractWindow(deliveredAt: DateLike, requestedAt: DateLike) {
  const delivered = assertDate(deliveredAt, "deliveredAt");
  const requested = assertDate(requestedAt, "requestedAt");
  const window = calculateRetractWindow(delivered);
  if (requested.getTime() < delivered.getTime()) {
    return { ...window, status: "BEFORE_DELIVERY" as const, isOpen: false };
  }
  const requestedDate = bogotaDateOnly(requested);
  const isOpen = requestedDate <= window.dueDate;
  return {
    ...window,
    requestedDate,
    status: isOpen ? ("OPEN" as const) : ("CLOSED" as const),
    isOpen,
  };
}

export function calculateRetractRefundDeadline(exercisedAt: DateLike): Date {
  const exercised = assertDate(exercisedAt, "exercisedAt");
  return new Date(exercised.getTime() + retractRefundCalendarDays * millisecondsPerDay);
}
