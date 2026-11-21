import { normalizeSku } from "./gs1.js";
import {
  assertStockQuantity,
  normalizeInventoryCode,
  normalizeSerializedUnitIdentity,
  type SerializedUnitIdentity,
} from "./inventory.js";

const maxSignedBigInt = 9_223_372_036_854_775_807n;
const inventoryRequiredHeaders = [
  "locationCode",
  "sku",
  "onHand",
  "safetyStock",
  "unitCostCents",
] as const;
const inventoryHeaders = [...inventoryRequiredHeaders, "serials"] as const;

export type CsvCell = string | number | bigint | boolean | null | undefined;

export interface CsvRow {
  readonly cells: string[];
  readonly line: number;
}

export interface CsvParseOptions {
  readonly maxBytes?: number;
  readonly maxRows?: number;
  readonly maxFieldLength?: number;
}

export interface InventoryStockCsvRow {
  readonly locationCode: string;
  readonly sku: string;
  readonly onHand: number;
  readonly safetyStock: number;
  readonly unitCostCents: bigint;
  readonly serials: Array<{ serial: string; imei: string | null }>;
  readonly line: number;
}

export class CsvValidationError extends Error {
  constructor(
    message: string,
    readonly line: number,
    readonly field?: string,
  ) {
    super(`CSV line ${line}${field ? `, field ${field}` : ""}: ${message}`);
    this.name = "CsvValidationError";
  }
}

function optionInteger(value: number, field: string, maximum: number): number {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${field} must be an integer between 1 and ${maximum}.`);
  }
  return value;
}

export function parseCsv(input: string, options: CsvParseOptions = {}): CsvRow[] {
  if (typeof input !== "string") throw new TypeError("CSV input must be a string.");
  const maxBytes = optionInteger(options.maxBytes ?? 5 * 1024 * 1024, "maxBytes", 50 * 1024 * 1024);
  const maxRows = optionInteger(options.maxRows ?? 10_000, "maxRows", 100_000);
  const maxFieldLength = optionInteger(
    options.maxFieldLength ?? 1_000_000,
    "maxFieldLength",
    2_000_000,
  );
  const source = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  if (source.length > maxBytes || new TextEncoder().encode(source).byteLength > maxBytes) {
    throw new CsvValidationError(`Input exceeds ${maxBytes} bytes.`, 1);
  }
  if (source.includes("\u0000")) throw new CsvValidationError("NUL bytes are not allowed.", 1);

  const rows: CsvRow[] = [];
  let cells: string[] = [];
  let field = "";
  let line = 1;
  let rowLine = 1;
  let inQuotes = false;
  let closedQuote = false;
  let rowHasQuotedCell = false;
  let touched = false;

  function pushFieldCharacter(chunk: string): void {
    field += chunk;
    if (field.length > maxFieldLength) {
      throw new CsvValidationError(`Field exceeds ${maxFieldLength} characters.`, rowLine);
    }
  }

  function appendField(): void {
    if (field.length > maxFieldLength) {
      throw new CsvValidationError(`Field exceeds ${maxFieldLength} characters.`, rowLine);
    }
    cells.push(field);
    field = "";
    closedQuote = false;
  }

  function appendRow(): void {
    appendField();
    if (!(cells.length === 1 && cells[0] === "" && !rowHasQuotedCell)) {
      rows.push({ cells, line: rowLine });
      if (rows.length > maxRows + 1) {
        throw new CsvValidationError(`Input exceeds ${maxRows} data rows.`, rowLine);
      }
    }
    cells = [];
    rowHasQuotedCell = false;
    touched = false;
  }

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (inQuotes) {
      if (character === '"') {
        if (source[index + 1] === '"') {
          pushFieldCharacter('"');
          index += 1;
        } else {
          inQuotes = false;
          closedQuote = true;
        }
      } else {
        if (character === "\r" && source[index + 1] === "\n") {
          pushFieldCharacter("\r\n");
          index += 1;
          line += 1;
        } else {
          pushFieldCharacter(character);
          if (character === "\r" || character === "\n") line += 1;
        }
      }
      touched = true;
      continue;
    }

    if (closedQuote && character !== "," && character !== "\r" && character !== "\n") {
      throw new CsvValidationError("Unexpected character after a closing quote.", line);
    }
    if (character === '"') {
      if (field.length > 0 || closedQuote) {
        throw new CsvValidationError("A quote may only open at the start of a field.", line);
      }
      inQuotes = true;
      rowHasQuotedCell = true;
      touched = true;
    } else if (character === ",") {
      appendField();
      touched = true;
    } else if (character === "\r" || character === "\n") {
      if (character === "\r" && source[index + 1] === "\n") index += 1;
      appendRow();
      line += 1;
      rowLine = line;
    } else {
      pushFieldCharacter(character);
      touched = true;
    }
  }

  if (inQuotes) throw new CsvValidationError("Unclosed quoted field.", rowLine);
  if (touched || field.length > 0 || cells.length > 0) appendRow();
  return rows;
}

export function neutralizeCsvFormula(value: string): string {
  return /^[\s\uFEFF]*[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

export function serializeCsv(rows: readonly (readonly CsvCell[])[]): string {
  return rows
    .map((row) =>
      row
        .map((cell) => {
          if (typeof cell === "number" && !Number.isFinite(cell)) {
            throw new TypeError("CSV numeric cells must be finite.");
          }
          if (
            cell !== null &&
            cell !== undefined &&
            !["string", "number", "bigint", "boolean"].includes(typeof cell)
          ) {
            throw new TypeError("Unsupported CSV cell type.");
          }
          const value = neutralizeCsvFormula(
            cell === null || cell === undefined ? "" : String(cell),
          );
          return /[",\r\n]/.test(value) || /^\s|\s$/.test(value)
            ? `"${value.replaceAll('"', '""')}"`
            : value;
        })
        .join(","),
    )
    .join("\r\n");
}

function parseQuantity(value: string, field: string, line: number): number {
  const normalized = value.trim();
  if (!/^[0-9]+$/.test(normalized)) {
    throw new CsvValidationError("Expected a non-negative integer.", line, field);
  }
  try {
    return assertStockQuantity(Number(normalized), field);
  } catch {
    throw new CsvValidationError("Integer exceeds the 32-bit inventory bounds.", line, field);
  }
}

function parseMoney(value: string, line: number): bigint {
  const normalized = value.trim();
  if (!/^[0-9]+$/.test(normalized)) {
    throw new CsvValidationError("Expected non-negative integer COP cents.", line, "unitCostCents");
  }
  const parsed = BigInt(normalized);
  if (parsed > maxSignedBigInt) {
    throw new CsvValidationError("Monetary value exceeds BIGINT bounds.", line, "unitCostCents");
  }
  return parsed;
}

function parseSerials(value: string, line: number): Array<{ serial: string; imei: string | null }> {
  if (value.trim() === "") return [];
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    throw new CsvValidationError("serials must be a JSON array.", line, "serials");
  }
  if (!Array.isArray(decoded) || decoded.length > 100_000) {
    throw new CsvValidationError("serials must be a bounded JSON array.", line, "serials");
  }
  return decoded.map((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new CsvValidationError("Each serial entry must be an object.", line, "serials");
    }
    const record = entry as Record<string, unknown>;
    if (
      typeof record.serial !== "string" ||
      (record.imei !== undefined && typeof record.imei !== "string") ||
      Object.keys(record).some((key) => !["serial", "imei"].includes(key))
    ) {
      throw new CsvValidationError(
        "Serial entries accept only serial and optional imei.",
        line,
        "serials",
      );
    }
    try {
      const identity: SerializedUnitIdentity = {
        serial: record.serial,
        ...(record.imei === undefined ? {} : { imei: record.imei }),
      };
      return normalizeSerializedUnitIdentity(identity);
    } catch (error) {
      throw new CsvValidationError(
        error instanceof Error ? error.message : "Invalid serial identity.",
        line,
        "serials",
      );
    }
  });
}

export function parseInventoryStockCsv(
  input: string,
  options?: CsvParseOptions,
): InventoryStockCsvRow[] {
  const parsed = parseCsv(input, options);
  const header = parsed[0];
  if (!header) throw new CsvValidationError("A header row is required.", 1);
  if (new Set(header.cells).size !== header.cells.length) {
    throw new CsvValidationError("Duplicate headers are not allowed.", header.line);
  }
  for (const required of inventoryRequiredHeaders) {
    if (!header.cells.includes(required)) {
      throw new CsvValidationError(`Missing required header ${required}.`, header.line);
    }
  }
  for (const column of header.cells) {
    if (!(inventoryHeaders as readonly string[]).includes(column)) {
      throw new CsvValidationError(`Unknown column ${column}.`, header.line);
    }
  }
  const dataRows = parsed.slice(1);
  if (dataRows.length === 0)
    throw new CsvValidationError("At least one data row is required.", header.line);
  const rowKeys = new Set<string>();
  const serialKeys = new Set<string>();
  const imeiKeys = new Set<string>();

  return dataRows.map((row) => {
    if (row.cells.length !== header.cells.length) {
      throw new CsvValidationError("Row does not match the header column count.", row.line);
    }
    const record = Object.fromEntries(
      header.cells.map((key, index) => [key, row.cells[index] ?? ""]),
    );
    let locationCode: string;
    let sku: string;
    let serials: Array<{ serial: string; imei: string | null }>;
    try {
      locationCode = normalizeInventoryCode(record.locationCode ?? "", "locationCode");
      sku = normalizeSku(record.sku ?? "");
      serials = parseSerials(record.serials ?? "", row.line);
    } catch (error) {
      if (error instanceof CsvValidationError) throw error;
      throw new CsvValidationError(
        error instanceof Error ? error.message : "Invalid inventory identity.",
        row.line,
      );
    }
    const key = `${locationCode}:${sku}`;
    if (rowKeys.has(key)) {
      throw new CsvValidationError("Duplicate locationCode/sku row.", row.line);
    }
    rowKeys.add(key);
    for (const identity of serials) {
      const serialKey = `${sku}:${identity.serial}`;
      if (serialKeys.has(serialKey))
        throw new CsvValidationError("Duplicate serial.", row.line, "serials");
      serialKeys.add(serialKey);
      if (identity.imei) {
        if (imeiKeys.has(identity.imei))
          throw new CsvValidationError("Duplicate IMEI.", row.line, "serials");
        imeiKeys.add(identity.imei);
      }
    }
    return {
      locationCode,
      sku,
      onHand: parseQuantity(record.onHand ?? "", "onHand", row.line),
      safetyStock: parseQuantity(record.safetyStock ?? "", "safetyStock", row.line),
      unitCostCents: parseMoney(record.unitCostCents ?? "", row.line),
      serials,
      line: row.line,
    };
  });
}
