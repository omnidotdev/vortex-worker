/**
 * Built-in Storage Plugin
 *
 * Cloud storage abstraction for S3, GCS, Azure Blob, and local filesystem.
 */

import type { PluginCallResult, PluginContext } from "../types";
import type { BuiltinPlugin } from "./types";

/** Storage provider types */
type StorageProvider = "s3" | "gcs" | "azure" | "local";

/** Storage configuration */
interface StorageConfig {
  /** Provider type */
  provider: StorageProvider;
  /** Bucket/container name (not needed for local) */
  bucket?: string;
  /** Region (for S3) */
  region?: string;
  /** Endpoint URL (for S3-compatible services) */
  endpoint?: string;
  /** Access key ID (for S3) */
  accessKeyId?: string;
  /** Secret access key (for S3) */
  secretAccessKey?: string;
  /** Base path for local storage */
  basePath?: string;
}

/** Upload input */
interface UploadInput extends StorageConfig {
  /** Remote path/key */
  key: string;
  /** Local file path or content */
  source: string;
  /** Is source file path (vs content) */
  isFile?: boolean;
  /** Content type */
  contentType?: string;
  /** Custom metadata */
  metadata?: Record<string, string>;
  /** Make publicly accessible */
  public?: boolean;
}

/** Download input */
interface DownloadInput extends StorageConfig {
  /** Remote path/key */
  key: string;
  /** Local destination path */
  destination?: string;
  /** Return as text */
  asText?: boolean;
  /** Return as base64 */
  asBase64?: boolean;
}

/** List input */
interface ListInput extends StorageConfig {
  /** Prefix to filter */
  prefix?: string;
  /** Delimiter for hierarchy */
  delimiter?: string;
  /** Max results */
  maxKeys?: number;
  /** Continuation token */
  continuationToken?: string;
}

/** Delete input */
interface DeleteInput extends StorageConfig {
  /** Key(s) to delete */
  keys: string | string[];
}

/** Copy input */
interface CopyInput extends StorageConfig {
  /** Source key */
  sourceKey: string;
  /** Destination key */
  destinationKey: string;
  /** Destination bucket (for cross-bucket copy) */
  destinationBucket?: string;
}

/** Presigned URL input */
interface PresignInput extends StorageConfig {
  /** Key */
  key: string;
  /** Expiration in seconds */
  expiresIn?: number;
  /** Operation type */
  operation?: "get" | "put";
}

/** Check existence input */
interface ExistsInput extends StorageConfig {
  /** Key to check */
  key: string;
}

/** Get metadata input */
interface HeadInput extends StorageConfig {
  /** Key to get metadata for */
  key: string;
}

/**
 * Get S3 client (dynamic import to avoid bundling when not used).
 */
const getS3Client = async (config: StorageConfig) => {
  const { S3Client } = await import("@aws-sdk/client-s3");

  return new S3Client({
    region: config.region ?? "us-east-1",
    endpoint: config.endpoint,
    credentials: config.accessKeyId
      ? {
          accessKeyId: config.accessKeyId,
          secretAccessKey: config.secretAccessKey ?? "",
        }
      : undefined,
    forcePathStyle: !!config.endpoint,
  });
};

/**
 * Upload file to storage.
 */
const upload = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as UploadInput;

    if (input.provider === "local") {
      const { mkdir, writeFile } = await import("node:fs/promises");
      const { dirname, join } = await import("node:path");

      const fullPath = join(input.basePath ?? "/tmp", input.key);
      await mkdir(dirname(fullPath), { recursive: true });

      if (input.isFile) {
        const file = Bun.file(input.source);
        const content = await file.arrayBuffer();
        await writeFile(fullPath, Buffer.from(content));
      } else {
        await writeFile(fullPath, input.source);
      }

      return {
        success: true,
        output: {
          key: input.key,
          path: fullPath,
          provider: "local",
        },
        durationMs: performance.now() - startTime,
      };
    }

    if (input.provider === "s3") {
      const { PutObjectCommand } = await import("@aws-sdk/client-s3");
      const client = await getS3Client(input);

      let body: Buffer | string;
      let contentType = input.contentType;

      if (input.isFile) {
        const file = Bun.file(input.source);
        body = Buffer.from(await file.arrayBuffer());
        contentType = contentType ?? file.type;
      } else {
        body = input.source;
        contentType = contentType ?? "text/plain";
      }

      const command = new PutObjectCommand({
        Bucket: input.bucket,
        Key: input.key,
        Body: body,
        ContentType: contentType,
        Metadata: input.metadata,
        ACL: input.public ? "public-read" : undefined,
      });

      await client.send(command);

      return {
        success: true,
        output: {
          key: input.key,
          bucket: input.bucket,
          provider: "s3",
          contentType,
        },
        durationMs: performance.now() - startTime,
      };
    }

    return {
      success: false,
      error: `Provider ${input.provider} not yet implemented. Use 's3' or 'local'.`,
      durationMs: performance.now() - startTime,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      durationMs: performance.now() - startTime,
    };
  }
};

/**
 * Download file from storage.
 */
const download = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as DownloadInput;

    if (input.provider === "local") {
      const { readFile } = await import("node:fs/promises");
      const { join } = await import("node:path");

      const fullPath = join(input.basePath ?? "/tmp", input.key);
      const content = await readFile(fullPath);

      if (input.destination) {
        await Bun.write(input.destination, content);
        return {
          success: true,
          output: {
            key: input.key,
            destination: input.destination,
            size: content.length,
          },
          durationMs: performance.now() - startTime,
        };
      }

      return {
        success: true,
        output: {
          key: input.key,
          content: input.asBase64
            ? content.toString("base64")
            : input.asText
              ? content.toString("utf-8")
              : content,
          size: content.length,
        },
        durationMs: performance.now() - startTime,
      };
    }

    if (input.provider === "s3") {
      const { GetObjectCommand } = await import("@aws-sdk/client-s3");
      const client = await getS3Client(input);

      const command = new GetObjectCommand({
        Bucket: input.bucket,
        Key: input.key,
      });

      const response = await client.send(command);
      const body = await response.Body?.transformToByteArray();

      if (!body) {
        throw new Error("Empty response body");
      }

      const content = Buffer.from(body);

      if (input.destination) {
        await Bun.write(input.destination, content);
        return {
          success: true,
          output: {
            key: input.key,
            bucket: input.bucket,
            destination: input.destination,
            size: content.length,
            contentType: response.ContentType,
          },
          durationMs: performance.now() - startTime,
        };
      }

      return {
        success: true,
        output: {
          key: input.key,
          bucket: input.bucket,
          content: input.asBase64
            ? content.toString("base64")
            : input.asText
              ? content.toString("utf-8")
              : content,
          size: content.length,
          contentType: response.ContentType,
        },
        durationMs: performance.now() - startTime,
      };
    }

    return {
      success: false,
      error: `Provider ${input.provider} not yet implemented.`,
      durationMs: performance.now() - startTime,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      durationMs: performance.now() - startTime,
    };
  }
};

/**
 * List objects in storage.
 */
const list = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as ListInput;

    if (input.provider === "local") {
      const { readdir, stat } = await import("node:fs/promises");
      const { join } = await import("node:path");

      const basePath = join(input.basePath ?? "/tmp", input.prefix ?? "");
      const entries = await readdir(basePath, { withFileTypes: true });

      const objects = await Promise.all(
        entries.map(async (entry) => {
          const fullPath = join(basePath, entry.name);
          const stats = await stat(fullPath);
          return {
            key: join(input.prefix ?? "", entry.name),
            size: stats.size,
            lastModified: stats.mtime.toISOString(),
            isDirectory: entry.isDirectory(),
          };
        }),
      );

      return {
        success: true,
        output: {
          objects,
          count: objects.length,
          provider: "local",
        },
        durationMs: performance.now() - startTime,
      };
    }

    if (input.provider === "s3") {
      const { ListObjectsV2Command } = await import("@aws-sdk/client-s3");
      const client = await getS3Client(input);

      const command = new ListObjectsV2Command({
        Bucket: input.bucket,
        Prefix: input.prefix,
        Delimiter: input.delimiter,
        MaxKeys: input.maxKeys,
        ContinuationToken: input.continuationToken,
      });

      const response = await client.send(command);

      const objects = (response.Contents ?? []).map((obj) => ({
        key: obj.Key,
        size: obj.Size,
        lastModified: obj.LastModified?.toISOString(),
        etag: obj.ETag,
      }));

      const prefixes = (response.CommonPrefixes ?? []).map((p) => p.Prefix);

      return {
        success: true,
        output: {
          objects,
          prefixes,
          count: objects.length,
          isTruncated: response.IsTruncated,
          nextContinuationToken: response.NextContinuationToken,
        },
        durationMs: performance.now() - startTime,
      };
    }

    return {
      success: false,
      error: `Provider ${input.provider} not yet implemented.`,
      durationMs: performance.now() - startTime,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      durationMs: performance.now() - startTime,
    };
  }
};

/**
 * Delete objects from storage.
 */
const remove = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as DeleteInput;
    const keys = Array.isArray(input.keys) ? input.keys : [input.keys];

    if (input.provider === "local") {
      const { unlink } = await import("node:fs/promises");
      const { join } = await import("node:path");

      let deleted = 0;
      for (const key of keys) {
        try {
          await unlink(join(input.basePath ?? "/tmp", key));
          deleted++;
        } catch {
          // Ignore missing files.
        }
      }

      return {
        success: true,
        output: { deleted, requested: keys.length },
        durationMs: performance.now() - startTime,
      };
    }

    if (input.provider === "s3") {
      const { DeleteObjectsCommand } = await import("@aws-sdk/client-s3");
      const client = await getS3Client(input);

      const command = new DeleteObjectsCommand({
        Bucket: input.bucket,
        Delete: {
          Objects: keys.map((key) => ({ Key: key })),
        },
      });

      const response = await client.send(command);

      return {
        success: true,
        output: {
          deleted: response.Deleted?.length ?? 0,
          errors: response.Errors?.map((e) => ({ key: e.Key, message: e.Message })),
        },
        durationMs: performance.now() - startTime,
      };
    }

    return {
      success: false,
      error: `Provider ${input.provider} not yet implemented.`,
      durationMs: performance.now() - startTime,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      durationMs: performance.now() - startTime,
    };
  }
};

/**
 * Copy object within or between buckets.
 */
const copy = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as CopyInput;

    if (input.provider === "local") {
      const { copyFile, mkdir } = await import("node:fs/promises");
      const { dirname, join } = await import("node:path");

      const sourcePath = join(input.basePath ?? "/tmp", input.sourceKey);
      const destPath = join(input.basePath ?? "/tmp", input.destinationKey);

      await mkdir(dirname(destPath), { recursive: true });
      await copyFile(sourcePath, destPath);

      return {
        success: true,
        output: {
          sourceKey: input.sourceKey,
          destinationKey: input.destinationKey,
        },
        durationMs: performance.now() - startTime,
      };
    }

    if (input.provider === "s3") {
      const { CopyObjectCommand } = await import("@aws-sdk/client-s3");
      const client = await getS3Client(input);

      const destBucket = input.destinationBucket ?? input.bucket;

      const command = new CopyObjectCommand({
        Bucket: destBucket,
        Key: input.destinationKey,
        CopySource: `${input.bucket}/${input.sourceKey}`,
      });

      await client.send(command);

      return {
        success: true,
        output: {
          sourceKey: input.sourceKey,
          sourceBucket: input.bucket,
          destinationKey: input.destinationKey,
          destinationBucket: destBucket,
        },
        durationMs: performance.now() - startTime,
      };
    }

    return {
      success: false,
      error: `Provider ${input.provider} not yet implemented.`,
      durationMs: performance.now() - startTime,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      durationMs: performance.now() - startTime,
    };
  }
};

/**
 * Generate presigned URL.
 */
const presign = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as PresignInput;

    if (input.provider === "s3") {
      const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
      const { GetObjectCommand, PutObjectCommand } = await import("@aws-sdk/client-s3");

      const client = await getS3Client(input);
      const expiresIn = input.expiresIn ?? 3600;

      const command = input.operation === "put"
        ? new PutObjectCommand({ Bucket: input.bucket, Key: input.key })
        : new GetObjectCommand({ Bucket: input.bucket, Key: input.key });

      const url = await getSignedUrl(client, command, { expiresIn });

      return {
        success: true,
        output: {
          url,
          key: input.key,
          expiresIn,
          operation: input.operation ?? "get",
        },
        durationMs: performance.now() - startTime,
      };
    }

    return {
      success: false,
      error: `Presigned URLs only supported for S3.`,
      durationMs: performance.now() - startTime,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      durationMs: performance.now() - startTime,
    };
  }
};

/**
 * Check if object exists.
 */
const exists = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as ExistsInput;

    if (input.provider === "local") {
      const { access } = await import("node:fs/promises");
      const { join } = await import("node:path");

      try {
        await access(join(input.basePath ?? "/tmp", input.key));
        return {
          success: true,
          output: { exists: true, key: input.key },
          durationMs: performance.now() - startTime,
        };
      } catch {
        return {
          success: true,
          output: { exists: false, key: input.key },
          durationMs: performance.now() - startTime,
        };
      }
    }

    if (input.provider === "s3") {
      const { HeadObjectCommand } = await import("@aws-sdk/client-s3");
      const client = await getS3Client(input);

      try {
        await client.send(new HeadObjectCommand({
          Bucket: input.bucket,
          Key: input.key,
        }));

        return {
          success: true,
          output: { exists: true, key: input.key },
          durationMs: performance.now() - startTime,
        };
      } catch {
        return {
          success: true,
          output: { exists: false, key: input.key },
          durationMs: performance.now() - startTime,
        };
      }
    }

    return {
      success: false,
      error: `Provider ${input.provider} not yet implemented.`,
      durationMs: performance.now() - startTime,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      durationMs: performance.now() - startTime,
    };
  }
};

/**
 * Get object metadata.
 */
const head = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as HeadInput;

    if (input.provider === "local") {
      const { stat } = await import("node:fs/promises");
      const { join } = await import("node:path");

      const fullPath = join(input.basePath ?? "/tmp", input.key);
      const stats = await stat(fullPath);

      return {
        success: true,
        output: {
          key: input.key,
          size: stats.size,
          lastModified: stats.mtime.toISOString(),
          isDirectory: stats.isDirectory(),
        },
        durationMs: performance.now() - startTime,
      };
    }

    if (input.provider === "s3") {
      const { HeadObjectCommand } = await import("@aws-sdk/client-s3");
      const client = await getS3Client(input);

      const response = await client.send(new HeadObjectCommand({
        Bucket: input.bucket,
        Key: input.key,
      }));

      return {
        success: true,
        output: {
          key: input.key,
          size: response.ContentLength,
          contentType: response.ContentType,
          etag: response.ETag,
          lastModified: response.LastModified?.toISOString(),
          metadata: response.Metadata,
        },
        durationMs: performance.now() - startTime,
      };
    }

    return {
      success: false,
      error: `Provider ${input.provider} not yet implemented.`,
      durationMs: performance.now() - startTime,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      durationMs: performance.now() - startTime,
    };
  }
};

/**
 * Storage built-in plugin definition.
 */
export const storagePlugin: BuiltinPlugin = {
  id: "builtin:storage",
  name: "Storage",
  description: "Cloud storage abstraction (S3, GCS, Azure, local)",
  actions: {
    upload: {
      name: "upload",
      description: "Upload file to storage",
      handler: upload,
    },
    download: {
      name: "download",
      description: "Download file from storage",
      handler: download,
    },
    list: {
      name: "list",
      description: "List objects in storage",
      handler: list,
    },
    delete: {
      name: "delete",
      description: "Delete objects from storage",
      handler: remove,
    },
    copy: {
      name: "copy",
      description: "Copy object within or between buckets",
      handler: copy,
    },
    presign: {
      name: "presign",
      description: "Generate presigned URL for direct access",
      handler: presign,
    },
    exists: {
      name: "exists",
      description: "Check if object exists",
      handler: exists,
    },
    head: {
      name: "head",
      description: "Get object metadata",
      handler: head,
    },
  },
};
