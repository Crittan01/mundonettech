import { crc32, deflateSync } from "node:zlib";

function pngChunk(type, data) {
  const name = Buffer.from(type, "ascii");
  const output = Buffer.alloc(12 + data.length);
  output.writeUInt32BE(data.length, 0);
  name.copy(output, 4);
  data.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length);
  return output;
}

export function createTiffExifPayload(orientation = 1, gpsNote = "GPS-test-metadata") {
  const noteBytes = Buffer.from(`${gpsNote}\0`, "ascii");
  // Big-endian TIFF header (8 bytes) + IFD0 count (2 bytes) + 2 entries (24 bytes) + nextIFD (4 bytes) = 38 bytes
  const headerAndIfd = Buffer.alloc(38);
  headerAndIfd.write("MM", 0, "ascii");
  headerAndIfd.writeUInt16BE(0x002a, 2);
  headerAndIfd.writeUInt32BE(8, 4);
  headerAndIfd.writeUInt16BE(2, 8);

  // Entry 0: Tag 0x010E (ImageDescription), Type 2 (ASCII), Count = noteBytes.length, Offset = 38
  headerAndIfd.writeUInt16BE(0x010e, 10);
  headerAndIfd.writeUInt16BE(2, 12);
  headerAndIfd.writeUInt32BE(noteBytes.length, 14);
  headerAndIfd.writeUInt32BE(38, 18);

  // Entry 1: Tag 0x0112 (Orientation), Type 3 (SHORT), Count = 1, Value left-aligned in 4 bytes
  headerAndIfd.writeUInt16BE(0x0112, 22);
  headerAndIfd.writeUInt16BE(3, 24);
  headerAndIfd.writeUInt32BE(1, 26);
  headerAndIfd.writeUInt16BE(orientation, 30);
  headerAndIfd.writeUInt32BE(0, 34);

  return Buffer.concat([headerAndIfd, noteBytes]);
}

export function createPng(width = 640, height = 480, includeExif = false, orientation = 1) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const scanlines = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1);
    scanlines[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = row + 1 + x * 4;
      scanlines[offset] = x % 256;
      scanlines[offset + 1] = y % 256;
      scanlines[offset + 2] = 120;
      scanlines[offset + 3] = 255;
    }
  }
  const exif = includeExif ? [pngChunk("eXIf", createTiffExifPayload(orientation))] : [];
  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    ...exif,
    pngChunk("IDAT", deflateSync(scanlines, { level: 1 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

export function createPngHeaderOnly(width, height) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([signature, pngChunk("IHDR", ihdr)]);
}

export function createWebpVp8xHeader(width, height) {
  const buffer = Buffer.alloc(30);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(22, 4);
  buffer.write("WEBP", 8, "ascii");
  buffer.write("VP8X", 12, "ascii");
  buffer.writeUInt32LE(10, 16);
  buffer.writeUIntLE(width - 1, 24, 3);
  buffer.writeUIntLE(height - 1, 27, 3);
  return buffer;
}

export function bmffBox(type, payload) {
  const box = Buffer.alloc(8 + payload.length);
  box.writeUInt32BE(box.length, 0);
  box.write(type, 4, "ascii");
  payload.copy(box, 8);
  return box;
}

export function createBmff(
  width = 320,
  height = 200,
  brand = "heic",
  includeDimensions = true,
  options = {},
) {
  const compatList = options.compatibleBrands ?? [brand];
  const ftyp = bmffBox(
    "ftyp",
    Buffer.concat([
      Buffer.from(brand, "ascii"),
      Buffer.alloc(4),
      ...compatList.map((item) => Buffer.from(item, "ascii")),
    ]),
  );
  if (!includeDimensions) return ftyp;
  const makeIspe = (w, h) => {
    const payload = Buffer.alloc(12);
    payload.writeUInt32BE(w, 4);
    payload.writeUInt32BE(h, 8);
    return bmffBox("ispe", payload);
  };
  const boxes = [makeIspe(width, height)];
  for (const extra of options.extraIspes ?? []) {
    boxes.push(makeIspe(extra.width, extra.height));
  }
  const ipco = bmffBox("ipco", Buffer.concat(boxes));
  // ISO/IEC 23008-12: iprp is a plain Box (no 4-byte FullBox flags); meta is a FullBox (4-byte flags).
  const iprp = bmffBox("iprp", ipco);
  const meta = bmffBox("meta", Buffer.concat([Buffer.alloc(4), iprp]));
  return Buffer.concat([ftyp, meta]);
}

function glbChunk(type, data) {
  const header = Buffer.alloc(8);
  header.writeUInt32LE(data.length, 0);
  header.writeUInt32LE(type, 4);
  return Buffer.concat([header, data]);
}

export function createGlb(options = {}) {
  const document = options.rawDocument ?? {
    asset: options.omitAsset ? undefined : { version: options.assetVersion ?? "2.0" },
    ...(options.extensionsRequired ? { extensionsRequired: options.extensionsRequired } : {}),
    ...(options.extras ? { extras: options.extras } : {}),
    buffers: [
      {
        byteLength: options.bufferLength ?? 4,
        ...(options.externalUri ? { uri: options.externalUri } : {}),
      },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: options.byteOffset ?? 0, byteLength: options.viewLength ?? 4 },
    ],
    ...(options.accessors ? { accessors: options.accessors } : {}),
    images: options.imageUri ? [{ uri: options.imageUri }] : options.images ? options.images : [],
  };
  let json = Buffer.from(JSON.stringify(document), "utf8");
  json = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
  const binary = Buffer.alloc(options.binaryLength ?? 4, 7);
  const chunks = options.omitBinChunk
    ? glbChunk(0x4e4f534a, json)
    : Buffer.concat([glbChunk(0x4e4f534a, json), glbChunk(0x004e4942, binary)]);
  const header = Buffer.alloc(12);
  header.write("glTF", 0, "ascii");
  header.writeUInt32LE(options.version ?? 2, 4);
  header.writeUInt32LE(options.declaredLength ?? chunks.length + 12, 8);
  return Buffer.concat([header, chunks]);
}

function zipEntry(name, data, options = {}) {
  const method = options.method ?? 0;
  const flags = options.flags ?? 0;
  const externalAttributes = options.externalAttributes ?? 0;
  const filename = Buffer.from(name, "utf8");
  const compressed = method === 8 ? deflateSync(data) : data;
  const compressedSize = options.compressedSize ?? compressed.length;
  const actualSize = options.uncompressedSize ?? data.length;
  const checksum = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(flags, 6);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(compressedSize, 18);
  local.writeUInt32LE(actualSize, 22);
  local.writeUInt16LE(filename.length, 26);
  const localBytes = Buffer.concat([local, filename, compressed]);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(0x0314, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(flags, 8);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(compressedSize, 20);
  central.writeUInt32LE(actualSize, 24);
  central.writeUInt16LE(filename.length, 28);
  central.writeUInt32LE(externalAttributes, 38);
  return { local: localBytes, central: Buffer.concat([central, filename]) };
}

export function createUsdz(entries) {
  const encoded = entries.map((entry) =>
    zipEntry(entry.name, Buffer.from(entry.data), {
      method: entry.method ?? 0,
      uncompressedSize: entry.uncompressedSize,
      compressedSize: entry.compressedSize,
      flags: entry.flags ?? 0,
      externalAttributes: entry.externalAttributes ?? 0,
    }),
  );
  const locals = [];
  const centrals = [];
  let localOffset = 0;
  for (const entry of encoded) {
    const central = Buffer.from(entry.central);
    central.writeUInt32LE(localOffset, 42);
    locals.push(entry.local);
    centrals.push(central);
    localOffset += entry.local.length;
  }
  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...locals, centralBytes, end]);
}
