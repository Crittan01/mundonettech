import { DeleteObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { isIP } from "node:net";

import { normalizeStorageKey } from "./storage-keys.js";

export interface R2StorageConfig {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  publicBaseUrl?: string;
}

export interface StoreObjectInput {
  key: string;
  body: Uint8Array;
  contentType: string;
  cacheControl?: string;
}

export interface StoredObject {
  key: string;
  byteSize: number;
  contentType: string;
  cacheControl: string;
  publicUrl: string | null;
}

function endpointUrl(value: string): URL {
  const url = new URL(value);
  const local =
    ["127.0.0.1", "localhost"].includes(url.hostname) ||
    (isIP(url.hostname) === 6 && url.hostname === "::1");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local))
    throw new Error("R2 endpoint requires HTTPS outside loopback tests.");
  return url;
}

export class R2MediaStorage {
  private readonly client: S3Client;
  private readonly publicBaseUrl: string | null;

  constructor(private readonly config: R2StorageConfig) {
    endpointUrl(config.endpoint);
    if (
      !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(config.bucket) ||
      !config.accessKeyId ||
      !config.secretAccessKey
    )
      throw new Error("Invalid R2 bucket or credentials.");
    this.publicBaseUrl = config.publicBaseUrl
      ? endpointUrl(config.publicBaseUrl).toString().replace(/\/$/, "")
      : null;
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: "auto",
      forcePathStyle: true,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
      maxAttempts: 3,
    });
  }

  async put(input: StoreObjectInput): Promise<StoredObject> {
    const key = normalizeStorageKey(input.key);
    const cacheControl = input.cacheControl ?? "public,max-age=31536000,immutable";
    if (
      !/^[a-z0-9]+\/[a-z0-9.+_-]+$/i.test(input.contentType) ||
      !/^[a-zA-Z0-9 ,;=._-]+$/.test(cacheControl)
    )
      throw new TypeError("Invalid content metadata.");
    const body = Buffer.from(input.body);
    const params = {
      Bucket: this.config.bucket,
      Key: key,
      Body: body,
      ContentType: input.contentType,
      CacheControl: cacheControl,
    };
    if (body.length <= 8 * 1024 * 1024) {
      await this.client.send(new PutObjectCommand(params));
    } else {
      const upload = new Upload({
        client: this.client,
        params,
        queueSize: 2,
        partSize: 8 * 1024 * 1024,
        leavePartsOnError: false,
      });
      await upload.done();
    }
    return {
      key,
      byteSize: body.length,
      contentType: input.contentType,
      cacheControl,
      publicUrl: this.publicBaseUrl
        ? `${this.publicBaseUrl}/${key.split("/").map(encodeURIComponent).join("/")}`
        : null,
    };
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.config.bucket, Key: normalizeStorageKey(key) }),
    );
  }

  async destroy(): Promise<void> {
    this.client.destroy();
  }
}
