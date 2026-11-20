import { deflateSync, crc32 } from "node:zlib";

function pngChunk(type, data) {
  const name = Buffer.from(type, "ascii");
  const output = Buffer.alloc(12 + data.length);
  output.writeUInt32BE(data.length, 0);
  name.copy(output, 4);
  data.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length);
  return output;
}

export function createPng(width = 640, height = 480, includeExif = false) {
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
  const exif = includeExif
    ? [pngChunk("eXIf", Buffer.from("Exif\0\0GPS-test-metadata", "utf8"))]
    : [];
  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    ...exif,
    pngChunk("IDAT", deflateSync(scanlines, { level: 1 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function bmffBox(type, payload) {
  const box = Buffer.alloc(8 + payload.length);
  box.writeUInt32BE(box.length, 0);
  box.write(type, 4, "ascii");
  payload.copy(box, 8);
  return box;
}

export function createBmff(width = 320, height = 200, brand = "heic", includeDimensions = true) {
  const ftyp = bmffBox(
    "ftyp",
    Buffer.concat([Buffer.from(brand, "ascii"), Buffer.alloc(4), Buffer.from(brand, "ascii")]),
  );
  if (!includeDimensions) return ftyp;
  const ispePayload = Buffer.alloc(12);
  ispePayload.writeUInt32BE(width, 4);
  ispePayload.writeUInt32BE(height, 8);
  const ispe = bmffBox("ispe", ispePayload);
  const ipco = bmffBox("ipco", ispe);
  const iprp = bmffBox("iprp", Buffer.concat([Buffer.alloc(4), ipco]));
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
  const document = {
    asset: { version: "2.0" },
    buffers: [
      {
        byteLength: options.bufferLength ?? 4,
        ...(options.externalUri ? { uri: options.externalUri } : {}),
      },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: options.byteOffset ?? 0, byteLength: options.viewLength ?? 4 },
    ],
    images: options.imageUri ? [{ uri: options.imageUri }] : [],
  };
  let json = Buffer.from(JSON.stringify(document), "utf8");
  json = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
  const binary = Buffer.alloc(options.binaryLength ?? 4, 7);
  const chunks = Buffer.concat([glbChunk(0x4e4f534a, json), glbChunk(0x004e4942, binary)]);
  const header = Buffer.alloc(12);
  header.write("glTF", 0, "ascii");
  header.writeUInt32LE(options.version ?? 2, 4);
  header.writeUInt32LE(options.declaredLength ?? chunks.length + 12, 8);
  return Buffer.concat([header, chunks]);
}

function zipEntry(name, data, method = 0, sizeOverride) {
  const filename = Buffer.from(name, "utf8");
  const compressed = method === 8 ? deflateSync(data) : data;
  const actualSize = sizeOverride ?? data.length;
  const checksum = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(actualSize, 22);
  local.writeUInt16LE(filename.length, 26);
  const localBytes = Buffer.concat([local, filename, compressed]);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(actualSize, 24);
  central.writeUInt16LE(filename.length, 28);
  central.writeUInt32LE(localBytes.length - compressed.length - filename.length - 30, 42);
  return { local: localBytes, central: Buffer.concat([central, filename]) };
}

export function createUsdz(entries) {
  const encoded = entries.map((entry) =>
    zipEntry(entry.name, Buffer.from(entry.data), entry.method ?? 0, entry.uncompressedSize),
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
