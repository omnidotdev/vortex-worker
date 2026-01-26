/**
 * Built-in File Plugin
 *
 * File operations for local and cloud storage (S3, GCS, Azure).
 */

import type { PluginCallResult, PluginContext } from "../types";
import type { BuiltinPlugin } from "./types";

type FileProvider = "local" | "s3" | "gcs" | "azure";

/** Base file input with provider support */
interface FileInput {
  /** File path or key */
  path: string;
  /** Storage provider */
  provider?: FileProvider;
  /** Provider-specific configuration */
  providerConfig?: Record<string, unknown>;
}

/** File write input */
interface FileWriteInput extends FileInput {
  /** Content to write */
  content: unknown;
  /** Content type (for cloud providers) */
  contentType?: string;
}

/** File list input */
interface FileListInput extends FileInput {
  /** Regex pattern to filter files (local) or prefix (cloud) */
  pattern?: string;
  /** Max results (cloud) */
  maxResults?: number;
}

/** Presigned URL input */
interface PresignedUrlInput extends FileInput {
  /** URL expiration in seconds */
  expiresIn?: number;
  /** Operation type */
  operation?: "get" | "put";
}

// Provider implementations

interface FileProviderImpl {
  read(input: FileInput): Promise<PluginCallResult>;
  write(input: FileWriteInput): Promise<PluginCallResult>;
  delete(input: FileInput): Promise<PluginCallResult>;
  list(input: FileListInput): Promise<PluginCallResult>;
  exists(input: FileInput): Promise<PluginCallResult>;
  presignedUrl?(input: PresignedUrlInput): Promise<PluginCallResult>;
}

// Local provider

const localProvider: FileProviderImpl = {
  async read(input) {
    const startTime = performance.now();
    try {
      const file = Bun.file(input.path);
      const exists = await file.exists();

      if (!exists) {
        return {
          success: false,
          error: `File not found: ${input.path}`,
          durationMs: performance.now() - startTime,
        };
      }

      const content = await file.text();

      return {
        success: true,
        output: { content, path: input.path, size: file.size },
        durationMs: performance.now() - startTime,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        durationMs: performance.now() - startTime,
      };
    }
  },

  async write(input) {
    const startTime = performance.now();
    try {
      const data =
        typeof input.content === "string"
          ? input.content
          : JSON.stringify(input.content, null, 2);
      await Bun.write(input.path, data);

      return {
        success: true,
        output: { path: input.path, bytesWritten: data.length },
        durationMs: performance.now() - startTime,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        durationMs: performance.now() - startTime,
      };
    }
  },

  async delete(input) {
    const startTime = performance.now();
    try {
      const { unlink } = await import("node:fs/promises");
      await unlink(input.path);

      return {
        success: true,
        output: { path: input.path, deleted: true },
        durationMs: performance.now() - startTime,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        durationMs: performance.now() - startTime,
      };
    }
  },

  async list(input) {
    const startTime = performance.now();
    try {
      const { readdir } = await import("node:fs/promises");
      let files = await readdir(input.path);

      if (input.pattern) {
        const regex = new RegExp(input.pattern);
        files = files.filter((f) => regex.test(f));
      }

      return {
        success: true,
        output: { files, count: files.length },
        durationMs: performance.now() - startTime,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        durationMs: performance.now() - startTime,
      };
    }
  },

  async exists(input) {
    const startTime = performance.now();
    try {
      const file = Bun.file(input.path);
      const exists = await file.exists();

      return {
        success: true,
        output: { path: input.path, exists },
        durationMs: performance.now() - startTime,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        durationMs: performance.now() - startTime,
      };
    }
  },
};

// S3 provider

interface S3Config {
  bucket: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  endpoint?: string;
}

const s3Provider: FileProviderImpl = {
  async read(input) {
    const startTime = performance.now();
    try {
      const config = input.providerConfig as S3Config | undefined;
      if (!config?.bucket) {
        return {
          success: false,
          error: "S3 bucket is required in providerConfig",
          durationMs: performance.now() - startTime,
        };
      }

      const { S3Client, GetObjectCommand } = await import(
        "@aws-sdk/client-s3"
      );
      const client = new S3Client({
        region: config.region ?? "us-east-1",
        ...(config.endpoint && { endpoint: config.endpoint }),
        ...(config.accessKeyId &&
          config.secretAccessKey && {
            credentials: {
              accessKeyId: config.accessKeyId,
              secretAccessKey: config.secretAccessKey,
            },
          }),
      });

      const response = await client.send(
        new GetObjectCommand({
          Bucket: config.bucket,
          Key: input.path,
        }),
      );

      const content = await response.Body?.transformToString();

      return {
        success: true,
        output: {
          content,
          path: input.path,
          bucket: config.bucket,
          contentType: response.ContentType,
          size: response.ContentLength,
          lastModified: response.LastModified?.toISOString(),
        },
        durationMs: performance.now() - startTime,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        durationMs: performance.now() - startTime,
      };
    }
  },

  async write(input) {
    const startTime = performance.now();
    try {
      const config = input.providerConfig as S3Config | undefined;
      if (!config?.bucket) {
        return {
          success: false,
          error: "S3 bucket is required in providerConfig",
          durationMs: performance.now() - startTime,
        };
      }

      const { S3Client, PutObjectCommand } = await import(
        "@aws-sdk/client-s3"
      );
      const client = new S3Client({
        region: config.region ?? "us-east-1",
        ...(config.endpoint && { endpoint: config.endpoint }),
        ...(config.accessKeyId &&
          config.secretAccessKey && {
            credentials: {
              accessKeyId: config.accessKeyId,
              secretAccessKey: config.secretAccessKey,
            },
          }),
      });

      const body =
        typeof input.content === "string"
          ? input.content
          : JSON.stringify(input.content);

      await client.send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: input.path,
          Body: body,
          ContentType: input.contentType ?? "application/octet-stream",
        }),
      );

      return {
        success: true,
        output: {
          path: input.path,
          bucket: config.bucket,
          bytesWritten: body.length,
        },
        durationMs: performance.now() - startTime,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        durationMs: performance.now() - startTime,
      };
    }
  },

  async delete(input) {
    const startTime = performance.now();
    try {
      const config = input.providerConfig as S3Config | undefined;
      if (!config?.bucket) {
        return {
          success: false,
          error: "S3 bucket is required in providerConfig",
          durationMs: performance.now() - startTime,
        };
      }

      const { S3Client, DeleteObjectCommand } = await import(
        "@aws-sdk/client-s3"
      );
      const client = new S3Client({
        region: config.region ?? "us-east-1",
        ...(config.endpoint && { endpoint: config.endpoint }),
        ...(config.accessKeyId &&
          config.secretAccessKey && {
            credentials: {
              accessKeyId: config.accessKeyId,
              secretAccessKey: config.secretAccessKey,
            },
          }),
      });

      await client.send(
        new DeleteObjectCommand({
          Bucket: config.bucket,
          Key: input.path,
        }),
      );

      return {
        success: true,
        output: { path: input.path, bucket: config.bucket, deleted: true },
        durationMs: performance.now() - startTime,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        durationMs: performance.now() - startTime,
      };
    }
  },

  async list(input) {
    const startTime = performance.now();
    try {
      const config = input.providerConfig as S3Config | undefined;
      if (!config?.bucket) {
        return {
          success: false,
          error: "S3 bucket is required in providerConfig",
          durationMs: performance.now() - startTime,
        };
      }

      const { S3Client, ListObjectsV2Command } = await import(
        "@aws-sdk/client-s3"
      );
      const client = new S3Client({
        region: config.region ?? "us-east-1",
        ...(config.endpoint && { endpoint: config.endpoint }),
        ...(config.accessKeyId &&
          config.secretAccessKey && {
            credentials: {
              accessKeyId: config.accessKeyId,
              secretAccessKey: config.secretAccessKey,
            },
          }),
      });

      const response = await client.send(
        new ListObjectsV2Command({
          Bucket: config.bucket,
          Prefix: input.path || input.pattern,
          MaxKeys: input.maxResults ?? 1000,
        }),
      );

      const files =
        response.Contents?.map((obj) => ({
          key: obj.Key,
          size: obj.Size,
          lastModified: obj.LastModified?.toISOString(),
        })) ?? [];

      return {
        success: true,
        output: {
          files,
          count: files.length,
          bucket: config.bucket,
          truncated: response.IsTruncated,
        },
        durationMs: performance.now() - startTime,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        durationMs: performance.now() - startTime,
      };
    }
  },

  async exists(input) {
    const startTime = performance.now();
    try {
      const config = input.providerConfig as S3Config | undefined;
      if (!config?.bucket) {
        return {
          success: false,
          error: "S3 bucket is required in providerConfig",
          durationMs: performance.now() - startTime,
        };
      }

      const { S3Client, HeadObjectCommand } = await import(
        "@aws-sdk/client-s3"
      );
      const client = new S3Client({
        region: config.region ?? "us-east-1",
        ...(config.endpoint && { endpoint: config.endpoint }),
        ...(config.accessKeyId &&
          config.secretAccessKey && {
            credentials: {
              accessKeyId: config.accessKeyId,
              secretAccessKey: config.secretAccessKey,
            },
          }),
      });

      try {
        await client.send(
          new HeadObjectCommand({
            Bucket: config.bucket,
            Key: input.path,
          }),
        );
        return {
          success: true,
          output: { path: input.path, bucket: config.bucket, exists: true },
          durationMs: performance.now() - startTime,
        };
      } catch (err) {
        if ((err as { name?: string }).name === "NotFound") {
          return {
            success: true,
            output: { path: input.path, bucket: config.bucket, exists: false },
            durationMs: performance.now() - startTime,
          };
        }
        throw err;
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        durationMs: performance.now() - startTime,
      };
    }
  },

  async presignedUrl(input) {
    const startTime = performance.now();
    try {
      const config = input.providerConfig as S3Config | undefined;
      if (!config?.bucket) {
        return {
          success: false,
          error: "S3 bucket is required in providerConfig",
          durationMs: performance.now() - startTime,
        };
      }

      const { S3Client, GetObjectCommand, PutObjectCommand } = await import(
        "@aws-sdk/client-s3"
      );
      const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");

      const client = new S3Client({
        region: config.region ?? "us-east-1",
        ...(config.endpoint && { endpoint: config.endpoint }),
        ...(config.accessKeyId &&
          config.secretAccessKey && {
            credentials: {
              accessKeyId: config.accessKeyId,
              secretAccessKey: config.secretAccessKey,
            },
          }),
      });

      const command =
        input.operation === "put"
          ? new PutObjectCommand({ Bucket: config.bucket, Key: input.path })
          : new GetObjectCommand({ Bucket: config.bucket, Key: input.path });

      const url = await getSignedUrl(client, command, {
        expiresIn: input.expiresIn ?? 3600,
      });

      return {
        success: true,
        output: {
          url,
          path: input.path,
          bucket: config.bucket,
          expiresIn: input.expiresIn ?? 3600,
          operation: input.operation ?? "get",
        },
        durationMs: performance.now() - startTime,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        durationMs: performance.now() - startTime,
      };
    }
  },
};

// GCS provider

interface GCSConfig {
  bucket: string;
  projectId?: string;
  keyFilename?: string;
  credentials?: Record<string, unknown>;
}

const gcsProvider: FileProviderImpl = {
  async read(input) {
    const startTime = performance.now();
    try {
      const config = input.providerConfig as GCSConfig | undefined;
      if (!config?.bucket) {
        return {
          success: false,
          error: "GCS bucket is required in providerConfig",
          durationMs: performance.now() - startTime,
        };
      }

      const { Storage } = await import("@google-cloud/storage");
      const storage = new Storage({
        projectId: config.projectId,
        keyFilename: config.keyFilename,
        credentials: config.credentials,
      });

      const [content] = await storage
        .bucket(config.bucket)
        .file(input.path)
        .download();

      const [metadata] = await storage
        .bucket(config.bucket)
        .file(input.path)
        .getMetadata();

      return {
        success: true,
        output: {
          content: content.toString(),
          path: input.path,
          bucket: config.bucket,
          contentType: metadata.contentType,
          size: Number(metadata.size),
        },
        durationMs: performance.now() - startTime,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        durationMs: performance.now() - startTime,
      };
    }
  },

  async write(input) {
    const startTime = performance.now();
    try {
      const config = input.providerConfig as GCSConfig | undefined;
      if (!config?.bucket) {
        return {
          success: false,
          error: "GCS bucket is required in providerConfig",
          durationMs: performance.now() - startTime,
        };
      }

      const { Storage } = await import("@google-cloud/storage");
      const storage = new Storage({
        projectId: config.projectId,
        keyFilename: config.keyFilename,
        credentials: config.credentials,
      });

      const body =
        typeof input.content === "string"
          ? input.content
          : JSON.stringify(input.content);

      await storage.bucket(config.bucket).file(input.path).save(body, {
        contentType: input.contentType,
      });

      return {
        success: true,
        output: {
          path: input.path,
          bucket: config.bucket,
          bytesWritten: body.length,
        },
        durationMs: performance.now() - startTime,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        durationMs: performance.now() - startTime,
      };
    }
  },

  async delete(input) {
    const startTime = performance.now();
    try {
      const config = input.providerConfig as GCSConfig | undefined;
      if (!config?.bucket) {
        return {
          success: false,
          error: "GCS bucket is required in providerConfig",
          durationMs: performance.now() - startTime,
        };
      }

      const { Storage } = await import("@google-cloud/storage");
      const storage = new Storage({
        projectId: config.projectId,
        keyFilename: config.keyFilename,
        credentials: config.credentials,
      });

      await storage.bucket(config.bucket).file(input.path).delete();

      return {
        success: true,
        output: { path: input.path, bucket: config.bucket, deleted: true },
        durationMs: performance.now() - startTime,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        durationMs: performance.now() - startTime,
      };
    }
  },

  async list(input) {
    const startTime = performance.now();
    try {
      const config = input.providerConfig as GCSConfig | undefined;
      if (!config?.bucket) {
        return {
          success: false,
          error: "GCS bucket is required in providerConfig",
          durationMs: performance.now() - startTime,
        };
      }

      const { Storage } = await import("@google-cloud/storage");
      const storage = new Storage({
        projectId: config.projectId,
        keyFilename: config.keyFilename,
        credentials: config.credentials,
      });

      const [objects] = await storage.bucket(config.bucket).getFiles({
        prefix: input.path || input.pattern,
        maxResults: input.maxResults ?? 1000,
      });

      const files = objects.map((obj) => ({
        key: obj.name,
        size: Number(obj.metadata.size),
        lastModified: obj.metadata.updated,
      }));

      return {
        success: true,
        output: { files, count: files.length, bucket: config.bucket },
        durationMs: performance.now() - startTime,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        durationMs: performance.now() - startTime,
      };
    }
  },

  async exists(input) {
    const startTime = performance.now();
    try {
      const config = input.providerConfig as GCSConfig | undefined;
      if (!config?.bucket) {
        return {
          success: false,
          error: "GCS bucket is required in providerConfig",
          durationMs: performance.now() - startTime,
        };
      }

      const { Storage } = await import("@google-cloud/storage");
      const storage = new Storage({
        projectId: config.projectId,
        keyFilename: config.keyFilename,
        credentials: config.credentials,
      });

      const [exists] = await storage
        .bucket(config.bucket)
        .file(input.path)
        .exists();

      return {
        success: true,
        output: { path: input.path, bucket: config.bucket, exists },
        durationMs: performance.now() - startTime,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        durationMs: performance.now() - startTime,
      };
    }
  },

  async presignedUrl(input) {
    const startTime = performance.now();
    try {
      const config = input.providerConfig as GCSConfig | undefined;
      if (!config?.bucket) {
        return {
          success: false,
          error: "GCS bucket is required in providerConfig",
          durationMs: performance.now() - startTime,
        };
      }

      const { Storage } = await import("@google-cloud/storage");
      const storage = new Storage({
        projectId: config.projectId,
        keyFilename: config.keyFilename,
        credentials: config.credentials,
      });

      const expiresIn = input.expiresIn ?? 3600;
      const [url] = await storage
        .bucket(config.bucket)
        .file(input.path)
        .getSignedUrl({
          action: input.operation === "put" ? "write" : "read",
          expires: Date.now() + expiresIn * 1000,
        });

      return {
        success: true,
        output: {
          url,
          path: input.path,
          bucket: config.bucket,
          expiresIn,
          operation: input.operation ?? "get",
        },
        durationMs: performance.now() - startTime,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        durationMs: performance.now() - startTime,
      };
    }
  },
};

// Azure Blob provider

interface AzureConfig {
  container: string;
  connectionString?: string;
  accountName?: string;
  accountKey?: string;
}

const azureProvider: FileProviderImpl = {
  async read(input) {
    const startTime = performance.now();
    try {
      const config = input.providerConfig as AzureConfig | undefined;
      if (!config?.container) {
        return {
          success: false,
          error: "Azure container is required in providerConfig",
          durationMs: performance.now() - startTime,
        };
      }

      const { BlobServiceClient } = await import("@azure/storage-blob");
      let blobService: InstanceType<typeof BlobServiceClient>;

      if (config.connectionString) {
        blobService = BlobServiceClient.fromConnectionString(
          config.connectionString,
        );
      } else if (config.accountName && config.accountKey) {
        const { StorageSharedKeyCredential } = await import(
          "@azure/storage-blob"
        );
        const credential = new StorageSharedKeyCredential(
          config.accountName,
          config.accountKey,
        );
        blobService = new BlobServiceClient(
          `https://${config.accountName}.blob.core.windows.net`,
          credential,
        );
      } else {
        return {
          success: false,
          error:
            "Azure connectionString or accountName/accountKey required in providerConfig",
          durationMs: performance.now() - startTime,
        };
      }

      const containerClient = blobService.getContainerClient(config.container);
      const blobClient = containerClient.getBlobClient(input.path);
      const downloadResponse = await blobClient.download();

      const chunks: Buffer[] = [];
      for await (const chunk of downloadResponse.readableStreamBody as AsyncIterable<Buffer>) {
        chunks.push(chunk);
      }
      const content = Buffer.concat(chunks).toString();

      return {
        success: true,
        output: {
          content,
          path: input.path,
          container: config.container,
          contentType: downloadResponse.contentType,
          size: downloadResponse.contentLength,
        },
        durationMs: performance.now() - startTime,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        durationMs: performance.now() - startTime,
      };
    }
  },

  async write(input) {
    const startTime = performance.now();
    try {
      const config = input.providerConfig as AzureConfig | undefined;
      if (!config?.container) {
        return {
          success: false,
          error: "Azure container is required in providerConfig",
          durationMs: performance.now() - startTime,
        };
      }

      const { BlobServiceClient } = await import("@azure/storage-blob");
      let blobService: InstanceType<typeof BlobServiceClient>;

      if (config.connectionString) {
        blobService = BlobServiceClient.fromConnectionString(
          config.connectionString,
        );
      } else if (config.accountName && config.accountKey) {
        const { StorageSharedKeyCredential } = await import(
          "@azure/storage-blob"
        );
        const credential = new StorageSharedKeyCredential(
          config.accountName,
          config.accountKey,
        );
        blobService = new BlobServiceClient(
          `https://${config.accountName}.blob.core.windows.net`,
          credential,
        );
      } else {
        return {
          success: false,
          error:
            "Azure connectionString or accountName/accountKey required in providerConfig",
          durationMs: performance.now() - startTime,
        };
      }

      const containerClient = blobService.getContainerClient(config.container);
      const blockBlobClient = containerClient.getBlockBlobClient(input.path);

      const body =
        typeof input.content === "string"
          ? input.content
          : JSON.stringify(input.content);

      await blockBlobClient.upload(body, body.length, {
        blobHTTPHeaders: { blobContentType: input.contentType },
      });

      return {
        success: true,
        output: {
          path: input.path,
          container: config.container,
          bytesWritten: body.length,
        },
        durationMs: performance.now() - startTime,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        durationMs: performance.now() - startTime,
      };
    }
  },

  async delete(input) {
    const startTime = performance.now();
    try {
      const config = input.providerConfig as AzureConfig | undefined;
      if (!config?.container) {
        return {
          success: false,
          error: "Azure container is required in providerConfig",
          durationMs: performance.now() - startTime,
        };
      }

      const { BlobServiceClient } = await import("@azure/storage-blob");
      let blobService: InstanceType<typeof BlobServiceClient>;

      if (config.connectionString) {
        blobService = BlobServiceClient.fromConnectionString(
          config.connectionString,
        );
      } else if (config.accountName && config.accountKey) {
        const { StorageSharedKeyCredential } = await import(
          "@azure/storage-blob"
        );
        const credential = new StorageSharedKeyCredential(
          config.accountName,
          config.accountKey,
        );
        blobService = new BlobServiceClient(
          `https://${config.accountName}.blob.core.windows.net`,
          credential,
        );
      } else {
        return {
          success: false,
          error:
            "Azure connectionString or accountName/accountKey required in providerConfig",
          durationMs: performance.now() - startTime,
        };
      }

      const containerClient = blobService.getContainerClient(config.container);
      const blobClient = containerClient.getBlobClient(input.path);
      await blobClient.delete();

      return {
        success: true,
        output: { path: input.path, container: config.container, deleted: true },
        durationMs: performance.now() - startTime,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        durationMs: performance.now() - startTime,
      };
    }
  },

  async list(input) {
    const startTime = performance.now();
    try {
      const config = input.providerConfig as AzureConfig | undefined;
      if (!config?.container) {
        return {
          success: false,
          error: "Azure container is required in providerConfig",
          durationMs: performance.now() - startTime,
        };
      }

      const { BlobServiceClient } = await import("@azure/storage-blob");
      let blobService: InstanceType<typeof BlobServiceClient>;

      if (config.connectionString) {
        blobService = BlobServiceClient.fromConnectionString(
          config.connectionString,
        );
      } else if (config.accountName && config.accountKey) {
        const { StorageSharedKeyCredential } = await import(
          "@azure/storage-blob"
        );
        const credential = new StorageSharedKeyCredential(
          config.accountName,
          config.accountKey,
        );
        blobService = new BlobServiceClient(
          `https://${config.accountName}.blob.core.windows.net`,
          credential,
        );
      } else {
        return {
          success: false,
          error:
            "Azure connectionString or accountName/accountKey required in providerConfig",
          durationMs: performance.now() - startTime,
        };
      }

      const containerClient = blobService.getContainerClient(config.container);
      const files: Array<{
        key: string;
        size: number | undefined;
        lastModified: string | undefined;
      }> = [];
      const maxResults = input.maxResults ?? 1000;

      for await (const blob of containerClient.listBlobsFlat({
        prefix: input.path || input.pattern,
      })) {
        if (files.length >= maxResults) break;
        files.push({
          key: blob.name,
          size: blob.properties.contentLength,
          lastModified: blob.properties.lastModified?.toISOString(),
        });
      }

      return {
        success: true,
        output: { files, count: files.length, container: config.container },
        durationMs: performance.now() - startTime,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        durationMs: performance.now() - startTime,
      };
    }
  },

  async exists(input) {
    const startTime = performance.now();
    try {
      const config = input.providerConfig as AzureConfig | undefined;
      if (!config?.container) {
        return {
          success: false,
          error: "Azure container is required in providerConfig",
          durationMs: performance.now() - startTime,
        };
      }

      const { BlobServiceClient } = await import("@azure/storage-blob");
      let blobService: InstanceType<typeof BlobServiceClient>;

      if (config.connectionString) {
        blobService = BlobServiceClient.fromConnectionString(
          config.connectionString,
        );
      } else if (config.accountName && config.accountKey) {
        const { StorageSharedKeyCredential } = await import(
          "@azure/storage-blob"
        );
        const credential = new StorageSharedKeyCredential(
          config.accountName,
          config.accountKey,
        );
        blobService = new BlobServiceClient(
          `https://${config.accountName}.blob.core.windows.net`,
          credential,
        );
      } else {
        return {
          success: false,
          error:
            "Azure connectionString or accountName/accountKey required in providerConfig",
          durationMs: performance.now() - startTime,
        };
      }

      const containerClient = blobService.getContainerClient(config.container);
      const blobClient = containerClient.getBlobClient(input.path);
      const exists = await blobClient.exists();

      return {
        success: true,
        output: { path: input.path, container: config.container, exists },
        durationMs: performance.now() - startTime,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        durationMs: performance.now() - startTime,
      };
    }
  },

  async presignedUrl(input) {
    const startTime = performance.now();
    try {
      const config = input.providerConfig as AzureConfig | undefined;
      if (!config?.container) {
        return {
          success: false,
          error: "Azure container is required in providerConfig",
          durationMs: performance.now() - startTime,
        };
      }

      if (!config.accountName || !config.accountKey) {
        return {
          success: false,
          error:
            "Azure accountName and accountKey required for presigned URLs",
          durationMs: performance.now() - startTime,
        };
      }

      const {
        BlobServiceClient,
        StorageSharedKeyCredential,
        generateBlobSASQueryParameters,
        BlobSASPermissions,
      } = await import("@azure/storage-blob");

      const credential = new StorageSharedKeyCredential(
        config.accountName,
        config.accountKey,
      );
      const blobService = new BlobServiceClient(
        `https://${config.accountName}.blob.core.windows.net`,
        credential,
      );

      const containerClient = blobService.getContainerClient(config.container);
      const blobClient = containerClient.getBlobClient(input.path);

      const expiresIn = input.expiresIn ?? 3600;
      const expiresOn = new Date(Date.now() + expiresIn * 1000);

      const permissions = new BlobSASPermissions();
      if (input.operation === "put") {
        permissions.write = true;
        permissions.create = true;
      } else {
        permissions.read = true;
      }

      const sasToken = generateBlobSASQueryParameters(
        {
          containerName: config.container,
          blobName: input.path,
          permissions,
          expiresOn,
        },
        credential,
      ).toString();

      const url = `${blobClient.url}?${sasToken}`;

      return {
        success: true,
        output: {
          url,
          path: input.path,
          container: config.container,
          expiresIn,
          operation: input.operation ?? "get",
        },
        durationMs: performance.now() - startTime,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        durationMs: performance.now() - startTime,
      };
    }
  },
};

// Provider registry

const providers: Record<FileProvider, FileProviderImpl> = {
  local: localProvider,
  s3: s3Provider,
  gcs: gcsProvider,
  azure: azureProvider,
};

const getProvider = (providerName?: FileProvider): FileProviderImpl => {
  return providers[providerName ?? "local"];
};

// Action handlers

const readFile = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const input = inputs as unknown as FileInput;
  if (!input.path) {
    return { success: false, error: "Path is required", durationMs: 0 };
  }
  return getProvider(input.provider).read(input);
};

const writeFile = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const input = inputs as unknown as FileWriteInput;
  if (!input.path) {
    return { success: false, error: "Path is required", durationMs: 0 };
  }
  return getProvider(input.provider).write(input);
};

const deleteFile = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const input = inputs as unknown as FileInput;
  if (!input.path) {
    return { success: false, error: "Path is required", durationMs: 0 };
  }
  return getProvider(input.provider).delete(input);
};

const listFiles = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const input = inputs as unknown as FileListInput;
  if (!input.path && !input.pattern) {
    return { success: false, error: "Path or pattern is required", durationMs: 0 };
  }
  return getProvider(input.provider).list(input);
};

const fileExists = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const input = inputs as unknown as FileInput;
  if (!input.path) {
    return { success: false, error: "Path is required", durationMs: 0 };
  }
  return getProvider(input.provider).exists(input);
};

const presignedUrl = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const input = inputs as unknown as PresignedUrlInput;
  if (!input.path) {
    return { success: false, error: "Path is required", durationMs: 0 };
  }
  const provider = getProvider(input.provider);
  if (!provider.presignedUrl) {
    return {
      success: false,
      error: `Presigned URLs not supported for provider: ${input.provider ?? "local"}`,
      durationMs: 0,
    };
  }
  return provider.presignedUrl(input);
};

/**
 * File built-in plugin definition.
 */
export const filePlugin: BuiltinPlugin = {
  id: "builtin:file",
  name: "File",
  description: "File operations for local and cloud storage (S3, GCS, Azure)",
  actions: {
    read: {
      name: "read",
      description: "Read file contents",
      handler: readFile,
    },
    write: {
      name: "write",
      description: "Write content to file",
      handler: writeFile,
    },
    delete: {
      name: "delete",
      description: "Delete a file",
      handler: deleteFile,
    },
    list: {
      name: "list",
      description: "List files in directory or bucket",
      handler: listFiles,
    },
    exists: {
      name: "exists",
      description: "Check if file exists",
      handler: fileExists,
    },
    presignedUrl: {
      name: "presignedUrl",
      description: "Generate presigned URL for direct upload/download",
      handler: presignedUrl,
    },
  },
};
