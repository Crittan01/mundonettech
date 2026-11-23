import { createServer } from "node:http";

function xml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export async function createR2RecoveryFixture(bucketNames) {
  const objects = new Map();
  const uploads = new Map();
  const requests = [];
  const buckets = new Set(bucketNames);
  let nextUploadId = 1;
  const state = {
    failBucket: null,
    failObjectGetBucket: null,
    omitBucketFromDiscovery: null,
    tamperNextDownload: false,
    failPartNumber: null,
    chunkByteLimit: null,
  };
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const [bucket, ...keySegments] = segments;
    const key = keySegments.join("/");
    requests.push({
      method: request.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: request.headers,
      byteSize: body.length,
    });
    const objectKey = bucket && key ? `${bucket}/${key}` : null;
    const sendXml = (status, value) => {
      response.writeHead(status, { "Content-Type": "application/xml" }).end(value);
    };
    if (request.method === "GET" && segments.length === 0) {
      const names = [...buckets]
        .filter((name) => name !== state.omitBucketFromDiscovery)
        .sort()
        .map((name) => `<Bucket><Name>${xml(name)}</Name></Bucket>`)
        .join("");
      sendXml(200, `<ListAllMyBucketsResult><Buckets>${names}</Buckets></ListAllMyBucketsResult>`);
      return;
    }
    if (!bucket || !buckets.has(bucket)) {
      sendXml(404, "<Error><Code>NoSuchBucket</Code></Error>");
      return;
    }
    if (state.failBucket === bucket && (request.method === "HEAD" || segments.length === 1)) {
      sendXml(500, "<Error><Code>IntentionalFailure</Code></Error>");
      return;
    }
    if (request.method === "HEAD" && !key) {
      response.writeHead(200).end();
      return;
    }
    if (request.method === "GET" && !key && url.searchParams.get("list-type") === "2") {
      const contents = [...objects.entries()]
        .filter(([name]) => name.startsWith(`${bucket}/`))
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, value]) => {
          const objectName = name.slice(bucket.length + 1);
          return `<Contents><Key>${xml(objectName)}</Key><Size>${value.bytes.length}</Size></Contents>`;
        })
        .join("");
      sendXml(
        200,
        `<ListBucketResult><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`,
      );
      return;
    }
    if (request.method === "POST" && key && url.searchParams.has("uploads")) {
      const uploadId = `upload-${nextUploadId++}`;
      uploads.set(uploadId, { bucket, key, parts: new Map() });
      sendXml(
        200,
        `<InitiateMultipartUploadResult><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`,
      );
      return;
    }
    if (request.method === "PUT" && key && url.searchParams.has("uploadId")) {
      const upload = uploads.get(url.searchParams.get("uploadId"));
      if (!upload) {
        sendXml(404, "<Error><Code>NoSuchUpload</Code></Error>");
        return;
      }
      if (Number(url.searchParams.get("partNumber")) === state.failPartNumber) {
        sendXml(500, "<Error><Code>IntentionalPartFailure</Code></Error>");
        return;
      }
      upload.parts.set(Number(url.searchParams.get("partNumber")), body);
      response.writeHead(200, { ETag: `"part-${upload.parts.size}"` }).end();
      return;
    }
    if (request.method === "POST" && key && url.searchParams.has("uploadId")) {
      const uploadId = url.searchParams.get("uploadId");
      const upload = uploads.get(uploadId);
      if (!upload) {
        sendXml(404, "<Error><Code>NoSuchUpload</Code></Error>");
        return;
      }
      const bytes = Buffer.concat(
        [...upload.parts.entries()].sort(([left], [right]) => left - right).map(([, part]) => part),
      );
      objects.set(objectKey, { bytes, lastModified: new Date() });
      uploads.delete(uploadId);
      sendXml(
        200,
        '<CompleteMultipartUploadResult><ETag>"complete-etag"</ETag></CompleteMultipartUploadResult>',
      );
      return;
    }
    if (request.method === "PUT" && key) {
      objects.set(objectKey, { bytes: body, lastModified: new Date() });
      response.writeHead(200, { ETag: '"put-etag"' }).end();
      return;
    }
    if (request.method === "DELETE" && key && url.searchParams.has("uploadId")) {
      uploads.delete(url.searchParams.get("uploadId"));
      response.writeHead(204).end();
      return;
    }
    if (request.method === "DELETE" && key) {
      objects.delete(objectKey);
      response.writeHead(204).end();
      return;
    }
    const stored = objects.get(objectKey);
    if (!stored) {
      sendXml(404, "<Error><Code>NoSuchKey</Code></Error>");
      return;
    }
    if (request.method === "HEAD") {
      response
        .writeHead(200, {
          "Content-Length": stored.bytes.length,
          "Last-Modified": stored.lastModified.toUTCString(),
          ETag: '"stored-etag"',
        })
        .end();
      return;
    }
    if (request.method === "GET") {
      if (state.failObjectGetBucket === bucket) {
        sendXml(500, "<Error><Code>IntentionalObjectReadFailure</Code></Error>");
        return;
      }
      let bytes = stored.bytes;
      let status = 200;
      const range = request.headers.range;
      if (range) {
        const match = /^bytes=(\d+)-(\d+)$/.exec(range);
        if (match) {
          const start = Number(match[1]);
          const end = Math.min(Number(match[2]), bytes.length - 1);
          bytes = bytes.subarray(start, end + 1);
          status = 206;
        }
      }
      if (state.tamperNextDownload && key.endsWith(".dump.gpg")) {
        bytes = Buffer.from(bytes);
        bytes[Math.floor(bytes.length / 2)] ^= 0xff;
        state.tamperNextDownload = false;
      }
      response.writeHead(status, {
        "Content-Length": bytes.length,
        "Last-Modified": stored.lastModified.toUTCString(),
        ETag: '"stored-etag"',
      });
      if (state.chunkByteLimit && state.chunkByteLimit > 0) {
        for (let offset = 0; offset < bytes.length; offset += state.chunkByteLimit) {
          response.write(bytes.subarray(offset, offset + state.chunkByteLimit));
        }
        response.end();
      } else {
        response.end(bytes);
      }
      return;
    }
    sendXml(400, "<Error><Code>UnsupportedFixtureRequest</Code></Error>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    objects,
    requests,
    state,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
