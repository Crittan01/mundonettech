import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListBucketsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { Readable } from "node:stream";

import { RecoveryError } from "./recovery-config.mjs";

const multipartPartSize = 8 * 1024 * 1024;
const maxMultipartParts = 10_000;
const maxPartUploadAttempts = 3;

async function uploadPartWithRetry(client, input, uploadId, partNumber, chunks, chunkBytes) {
  let lastError;
  for (let attempt = 1; attempt <= maxPartUploadAttempts; attempt += 1) {
    if (input.signal?.aborted) {
      throw new Error("Multipart upload aborted.");
    }
    try {
      const result = await client.send(
        new UploadPartCommand({
          Bucket: input.bucket,
          Key: input.key,
          UploadId: uploadId,
          PartNumber: partNumber,
          Body: Readable.from(chunks),
          ContentLength: chunkBytes,
        }),
        { abortSignal: input.signal },
      );
      if (!result.ETag) throw new Error("R2 did not return a part ETag.");
      return result.ETag;
    } catch (error) {
      lastError = error;
      if (input.signal?.aborted || attempt === maxPartUploadAttempts) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 150 * attempt));
    }
  }
  throw lastError;
}

async function streamMultipart(client, input) {
  let uploadId;
  try {
    const created = await client.send(
      new CreateMultipartUploadCommand({
        Bucket: input.bucket,
        Key: input.key,
        ContentType: "application/pgp-encrypted",
        CacheControl: "private,no-store,max-age=0",
        Metadata: { environment: input.environment.toLowerCase(), format: "pgdump-custom-gpg" },
      }),
      { abortSignal: input.signal },
    );
    uploadId = created.UploadId;
    if (!uploadId) throw new Error("R2 did not return an upload identifier.");
    const parts = [];
    let chunks = [];
    let chunkBytes = 0;
    const flush = async () => {
      if (chunkBytes === 0) return;
      const partNumber = parts.length + 1;
      if (partNumber > maxMultipartParts) {
        throw new Error("Multipart upload exceeded the maximum 10,000 parts.");
      }
      const etag = await uploadPartWithRetry(
        client,
        input,
        uploadId,
        partNumber,
        chunks,
        chunkBytes,
      );
      parts.push({ ETag: etag, PartNumber: partNumber });
      chunks = [];
      chunkBytes = 0;
    };
    for await (const value of input.body) {
      let chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      while (chunk.length > 0) {
        const remaining = multipartPartSize - chunkBytes;
        const piece = chunk.subarray(0, remaining);
        chunks.push(piece);
        chunkBytes += piece.length;
        chunk = chunk.subarray(piece.length);
        if (chunkBytes === multipartPartSize) await flush();
      }
    }
    await flush();
    if (parts.length === 0) throw new Error("The encrypted stream is empty.");
    const completed = await client.send(
      new CompleteMultipartUploadCommand({
        Bucket: input.bucket,
        Key: input.key,
        UploadId: uploadId,
        MultipartUpload: { Parts: parts },
      }),
      { abortSignal: input.signal },
    );
    uploadId = undefined;
    if (!completed.ETag) throw new Error("R2 did not seal the multipart upload.");
    return { etag: completed.ETag };
  } catch (error) {
    if (uploadId) {
      await client
        .send(
          new AbortMultipartUploadCommand({
            Bucket: input.bucket,
            Key: input.key,
            UploadId: uploadId,
          }),
        )
        .catch(() => undefined);
    }
    const failure = new RecoveryError(
      "R2_MULTIPART_UPLOAD_FAILED",
      "The encrypted multipart upload failed.",
      {
        cause: error,
      },
    );
    if (input.signal?.aborted) failure.recoveryCleanup = true;
    throw failure;
  }
}

export class R2RecoveryStorage {
  constructor(config) {
    this.backupBucket = config.backupBucket;
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: "auto",
      forcePathStyle: true,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
      maxAttempts: 3,
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
      requestHandler: { requestTimeout: 120_000, connectionTimeout: 15_000 },
    });
  }

  async listBucketNames() {
    const response = await this.client.send(new ListBucketsCommand({}));
    return (response.Buckets ?? [])
      .map((bucket) => bucket.Name)
      .filter((name) => typeof name === "string")
      .sort();
  }

  async assertExactBucketCoverage(expectedNames) {
    const discovered = await this.listBucketNames().catch((error) => {
      throw new RecoveryError("R2_BUCKET_DISCOVERY_FAILED", "Unable to discover the R2 buckets.", {
        cause: error,
      });
    });
    if (JSON.stringify(discovered) !== JSON.stringify([...expectedNames].sort())) {
      throw new RecoveryError(
        "R2_BUCKET_COVERAGE_MISMATCH",
        "Configured recovery buckets do not exactly match the buckets visible to the R2 credential.",
      );
    }
  }

  async checkBucketAccess(bucketName) {
    await this.client.send(new HeadBucketCommand({ Bucket: bucketName }));
    return { bucketName, accessible: true, readVerified: false, objectCount: null };
  }

  async inspectBucket(bucketName) {
    await this.client.send(new HeadBucketCommand({ Bucket: bucketName }));
    let objectCount = 0n;
    let continuationToken;
    let firstNonEmptyKey;
    let firstAnyKey;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: bucketName,
          MaxKeys: 1000,
          ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
        }),
      );
      for (const object of page.Contents ?? []) {
        objectCount += 1n;
        if (object.Key) {
          if (!firstAnyKey) firstAnyKey = object.Key;
          if (!firstNonEmptyKey && (object.Size ?? 0) > 0) firstNonEmptyKey = object.Key;
        }
      }
      const nextToken = page.IsTruncated ? page.NextContinuationToken : undefined;
      if (page.IsTruncated && (!nextToken || nextToken === continuationToken)) {
        throw new RecoveryError(
          "R2_BUCKET_PAGINATION_INVALID",
          "R2 returned an invalid object continuation token.",
        );
      }
      continuationToken = nextToken;
    } while (continuationToken);
    let readVerified = false;
    if (objectCount > 0n) {
      const probeKey = firstNonEmptyKey ?? firstAnyKey;
      if (!probeKey)
        throw new RecoveryError("R2_BUCKET_OBJECT_INVALID", "R2 returned an object without a key.");
      try {
        const response = await this.client.send(
          new GetObjectCommand({
            Bucket: bucketName,
            Key: probeKey,
            ...(firstNonEmptyKey ? { Range: "bytes=0-0" } : {}),
          }),
        );
        if (!response.Body) {
          throw new RecoveryError("R2_BUCKET_READ_FAILED", "R2 returned an empty object response.");
        }
        let bytesRead = 0;
        for await (const chunk of response.Body) {
          bytesRead += Buffer.isBuffer(chunk) ? chunk.byteLength : Buffer.byteLength(chunk);
        }
        readVerified = firstNonEmptyKey ? bytesRead >= 1 : true;
      } catch {
        readVerified = false;
      }
    }
    return { bucketName, accessible: true, readVerified, objectCount };
  }

  uploadStream({ key, body, environment }) {
    const controller = new AbortController();
    return {
      done: streamMultipart(this.client, {
        bucket: this.backupBucket,
        key,
        body,
        environment,
        signal: controller.signal,
      }),
      abort: () => {
        controller.abort();
        body.destroy();
      },
    };
  }

  async headBackup(key) {
    return this.client.send(new HeadObjectCommand({ Bucket: this.backupBucket, Key: key }));
  }

  async deleteBackupObject(key) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.backupBucket, Key: key }));
  }

  async putManifest(key, manifest) {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.backupBucket,
        Key: key,
        Body: JSON.stringify(manifest),
        ContentType: "application/json",
        CacheControl: "private,no-store,max-age=0",
      }),
    );
  }

  async getBackupStream(key) {
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.backupBucket, Key: key }),
    );
    if (!response.Body)
      throw new RecoveryError("BACKUP_OBJECT_EMPTY", "The encrypted backup response is empty.");
    return response;
  }

  async getManifest(key) {
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.backupBucket, Key: key, Range: "bytes=0-65536" }),
    );
    if (!response.Body)
      throw new RecoveryError("BACKUP_MANIFEST_EMPTY", "The backup manifest is empty.");
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let text = "";
    let size = 0;
    for await (const chunk of response.Body) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.byteLength;
      if (size > 65_536) {
        response.Body.destroy?.();
        throw new RecoveryError("BACKUP_MANIFEST_TOO_LARGE", "The backup manifest is too large.");
      }
      try {
        text += decoder.decode(bytes, { stream: true });
      } catch (error) {
        response.Body.destroy?.();
        throw new RecoveryError(
          "BACKUP_MANIFEST_INVALID",
          "The backup manifest is not valid UTF-8.",
          { cause: error },
        );
      }
    }
    try {
      text += decoder.decode();
      return JSON.parse(text);
    } catch (error) {
      throw new RecoveryError("BACKUP_MANIFEST_INVALID", "The backup manifest is not valid JSON.", {
        cause: error,
      });
    }
  }

  destroy() {
    this.client.destroy();
  }
}
