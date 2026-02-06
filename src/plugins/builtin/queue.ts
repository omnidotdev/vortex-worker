/**
 * Built-in Queue Plugin
 *
 * Message queue operations for memory, Redis, SQS, and RabbitMQ.
 * The Redis provider uses the centralized client when available,
 * falling back to per-operation connections when explicit config is given.
 */

import { cacheClient } from "lib/cache";

import type { PluginCallResult, PluginContext } from "../types";
import type { BuiltinPlugin } from "./types";

type QueueProvider = "memory" | "redis" | "sqs" | "rabbitmq";

/** Queue message */
interface QueueMessage {
  /** Unique message ID */
  id: string;
  /** Message payload */
  payload: unknown;
  /** Message priority (higher = processed first) */
  priority: number;
  /** When message was created */
  createdAt: number;
  /** When message becomes visible */
  visibleAt: number;
  /** Receipt handle (for SQS ack/nack) */
  receiptHandle?: string;
}

/** Base queue input */
interface QueueInput {
  /** Queue name */
  queueName: string;
  /** Queue provider */
  provider?: QueueProvider;
  /** Provider-specific configuration */
  providerConfig?: Record<string, unknown>;
}

/** Queue push input */
interface QueuePushInput extends QueueInput {
  /** Message payload */
  message: unknown;
  /** Message priority (default: 0) */
  priority?: number;
  /** Delay before message is visible in ms (default: 0) */
  delayMs?: number;
}

/** Queue pull input */
interface QueuePullInput extends QueueInput {
  /** Timeout in ms for blocking pull */
  timeoutMs?: number;
  /** Visibility timeout for message (SQS) */
  visibilityTimeoutMs?: number;
}

/** Queue ack/nack input */
interface QueueAckInput extends QueueInput {
  /** Message ID or receipt handle */
  messageId: string;
}

// Provider implementations

interface QueueProviderImpl {
  push(input: QueuePushInput): Promise<PluginCallResult>;
  pull(input: QueuePullInput): Promise<PluginCallResult>;
  peek(input: QueuePullInput): Promise<PluginCallResult>;
  ack(input: QueueAckInput): Promise<PluginCallResult>;
  nack(input: QueueAckInput): Promise<PluginCallResult>;
  length(input: QueueInput): Promise<PluginCallResult>;
}

// Memory provider

const memoryQueues = new Map<string, QueueMessage[]>();

const memoryProvider: QueueProviderImpl = {
  async push(input) {
    const startTime = performance.now();
    try {
      const { queueName, message, priority = 0, delayMs = 0 } = input;

      if (!memoryQueues.has(queueName)) {
        memoryQueues.set(queueName, []);
      }

      const queue = memoryQueues.get(queueName)!;

      const queueMessage: QueueMessage = {
        id: `msg_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        payload: message,
        priority,
        createdAt: Date.now(),
        visibleAt: Date.now() + delayMs,
      };

      const insertIndex = queue.findIndex((m) => m.priority < priority);
      if (insertIndex === -1) {
        queue.push(queueMessage);
      } else {
        queue.splice(insertIndex, 0, queueMessage);
      }

      return {
        success: true,
        output: {
          messageId: queueMessage.id,
          queueName,
          queueLength: queue.length,
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

  async pull(input) {
    const startTime = performance.now();
    try {
      const { queueName } = input;
      const queue = memoryQueues.get(queueName);

      if (!queue || queue.length === 0) {
        return {
          success: true,
          output: { message: null, queueLength: 0 },
          durationMs: performance.now() - startTime,
        };
      }

      const now = Date.now();
      const visibleIndex = queue.findIndex((m) => m.visibleAt <= now);

      if (visibleIndex === -1) {
        return {
          success: true,
          output: { message: null, queueLength: queue.length },
          durationMs: performance.now() - startTime,
        };
      }

      const [message] = queue.splice(visibleIndex, 1);

      return {
        success: true,
        output: {
          message: message.payload,
          messageId: message.id,
          queueLength: queue.length,
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

  async peek(input) {
    const startTime = performance.now();
    try {
      const { queueName } = input;
      const queue = memoryQueues.get(queueName);

      if (!queue || queue.length === 0) {
        return {
          success: true,
          output: { message: null, queueLength: 0 },
          durationMs: performance.now() - startTime,
        };
      }

      const now = Date.now();
      const message = queue.find((m) => m.visibleAt <= now);

      return {
        success: true,
        output: {
          message: message?.payload ?? null,
          messageId: message?.id,
          queueLength: queue.length,
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

  async ack(_input) {
    const startTime = performance.now();
    // Memory queue auto-acks on pull
    return {
      success: true,
      output: { acknowledged: true },
      durationMs: performance.now() - startTime,
    };
  },

  async nack(input) {
    const startTime = performance.now();
    // Memory queue doesn't support nack - message is already removed
    return {
      success: true,
      output: {
        acknowledged: false,
        note: "Memory queue does not support nack",
      },
      durationMs: performance.now() - startTime,
    };
  },

  async length(input) {
    const startTime = performance.now();
    const queue = memoryQueues.get(input.queueName);
    return {
      success: true,
      output: { length: queue?.length ?? 0 },
      durationMs: performance.now() - startTime,
    };
  },
};

// Redis provider

interface RedisConfig {
  url?: string;
  host?: string;
  port?: number;
  password?: string;
  db?: number;
}

/**
 * Get a Redis client for queue operations.
 * Uses the centralized client when no explicit config is given,
 * otherwise creates a per-operation connection.
 */
async function getRedisForQueue(config: RedisConfig | undefined): Promise<{
  // biome-ignore lint/suspicious/noExplicitAny: ioredis types vary
  redis: any;
  needsCleanup: boolean;
}> {
  // Use centralized client when no explicit config is provided
  if (!config?.url && !config?.host && !config?.password && cacheClient) {
    return { redis: cacheClient, needsCleanup: false };
  }

  // Create per-operation connection for explicit config
  const { Redis } = await import("ioredis");
  const redis = config?.url
    ? new Redis(config.url)
    : new Redis({
        host: config?.host ?? "localhost",
        port: config?.port ?? 6379,
        password: config?.password,
        db: config?.db ?? 0,
      });

  return { redis, needsCleanup: true };
}

const redisProvider: QueueProviderImpl = {
  async push(input) {
    const startTime = performance.now();
    try {
      const config = input.providerConfig as RedisConfig | undefined;
      const { redis, needsCleanup } = await getRedisForQueue(config);

      try {
        const messageId = `msg_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        const message = {
          id: messageId,
          payload: input.message,
          priority: input.priority ?? 0,
          createdAt: Date.now(),
        };

        const score = input.delayMs
          ? Date.now() + input.delayMs
          : Date.now() - (input.priority ?? 0) * 1000000;

        await redis.zadd(
          `queue:${input.queueName}`,
          score,
          JSON.stringify(message),
        );

        const length = await redis.zcard(`queue:${input.queueName}`);

        return {
          success: true,
          output: {
            messageId,
            queueName: input.queueName,
            queueLength: length,
          },
          durationMs: performance.now() - startTime,
        };
      } finally {
        if (needsCleanup) await redis.quit();
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        durationMs: performance.now() - startTime,
      };
    }
  },

  async pull(input) {
    const startTime = performance.now();
    try {
      const config = input.providerConfig as RedisConfig | undefined;
      const { redis, needsCleanup } = await getRedisForQueue(config);

      try {
        const now = Date.now();
        const results = await redis.zrangebyscore(
          `queue:${input.queueName}`,
          "-inf",
          now,
          "LIMIT",
          0,
          1,
        );

        if (results.length === 0) {
          const length = await redis.zcard(`queue:${input.queueName}`);
          return {
            success: true,
            output: { message: null, queueLength: length },
            durationMs: performance.now() - startTime,
          };
        }

        const messageStr = results[0];
        await redis.zrem(`queue:${input.queueName}`, messageStr);

        const message = JSON.parse(messageStr) as {
          id: string;
          payload: unknown;
        };
        const length = await redis.zcard(`queue:${input.queueName}`);

        return {
          success: true,
          output: {
            message: message.payload,
            messageId: message.id,
            queueLength: length,
          },
          durationMs: performance.now() - startTime,
        };
      } finally {
        if (needsCleanup) await redis.quit();
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        durationMs: performance.now() - startTime,
      };
    }
  },

  async peek(input) {
    const startTime = performance.now();
    try {
      const config = input.providerConfig as RedisConfig | undefined;
      const { redis, needsCleanup } = await getRedisForQueue(config);

      try {
        const now = Date.now();
        const results = await redis.zrangebyscore(
          `queue:${input.queueName}`,
          "-inf",
          now,
          "LIMIT",
          0,
          1,
        );

        const length = await redis.zcard(`queue:${input.queueName}`);

        if (results.length === 0) {
          return {
            success: true,
            output: { message: null, queueLength: length },
            durationMs: performance.now() - startTime,
          };
        }

        const message = JSON.parse(results[0]) as {
          id: string;
          payload: unknown;
        };

        return {
          success: true,
          output: {
            message: message.payload,
            messageId: message.id,
            queueLength: length,
          },
          durationMs: performance.now() - startTime,
        };
      } finally {
        if (needsCleanup) await redis.quit();
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        durationMs: performance.now() - startTime,
      };
    }
  },

  async ack(_input) {
    const startTime = performance.now();
    // Redis queue auto-acks on pull (message is removed)
    return {
      success: true,
      output: { acknowledged: true },
      durationMs: performance.now() - startTime,
    };
  },

  async nack(_input) {
    const startTime = performance.now();
    return {
      success: true,
      output: {
        acknowledged: false,
        note: "Redis queue does not support nack",
      },
      durationMs: performance.now() - startTime,
    };
  },

  async length(input) {
    const startTime = performance.now();
    try {
      const config = input.providerConfig as RedisConfig | undefined;
      const { redis, needsCleanup } = await getRedisForQueue(config);

      try {
        const length = await redis.zcard(`queue:${input.queueName}`);
        return {
          success: true,
          output: { length },
          durationMs: performance.now() - startTime,
        };
      } finally {
        if (needsCleanup) await redis.quit();
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        durationMs: performance.now() - startTime,
      };
    }
  },
};

// SQS provider

interface SQSConfig {
  queueUrl?: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
}

// Track receipt handles for ack/nack
const sqsReceiptHandles = new Map<string, string>();

const sqsProvider: QueueProviderImpl = {
  async push(input) {
    const startTime = performance.now();
    try {
      const config = input.providerConfig as SQSConfig | undefined;
      if (!config?.queueUrl) {
        return {
          success: false,
          error: "SQS queueUrl is required in providerConfig",
          durationMs: performance.now() - startTime,
        };
      }

      const { SQSClient, SendMessageCommand } = await import(
        "@aws-sdk/client-sqs"
      );

      const client = new SQSClient({
        region: config.region ?? "us-east-1",
        ...(config.accessKeyId &&
          config.secretAccessKey && {
            credentials: {
              accessKeyId: config.accessKeyId,
              secretAccessKey: config.secretAccessKey,
            },
          }),
      });

      const result = await client.send(
        new SendMessageCommand({
          QueueUrl: config.queueUrl,
          MessageBody: JSON.stringify(input.message),
          DelaySeconds: input.delayMs ? Math.floor(input.delayMs / 1000) : 0,
        }),
      );

      return {
        success: true,
        output: {
          messageId: result.MessageId,
          queueName: input.queueName,
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

  async pull(input) {
    const startTime = performance.now();
    try {
      const config = input.providerConfig as SQSConfig | undefined;
      if (!config?.queueUrl) {
        return {
          success: false,
          error: "SQS queueUrl is required in providerConfig",
          durationMs: performance.now() - startTime,
        };
      }

      const { SQSClient, ReceiveMessageCommand } = await import(
        "@aws-sdk/client-sqs"
      );

      const client = new SQSClient({
        region: config.region ?? "us-east-1",
        ...(config.accessKeyId &&
          config.secretAccessKey && {
            credentials: {
              accessKeyId: config.accessKeyId,
              secretAccessKey: config.secretAccessKey,
            },
          }),
      });

      const result = await client.send(
        new ReceiveMessageCommand({
          QueueUrl: config.queueUrl,
          MaxNumberOfMessages: 1,
          WaitTimeSeconds: input.timeoutMs
            ? Math.floor(input.timeoutMs / 1000)
            : 0,
          VisibilityTimeout: input.visibilityTimeoutMs
            ? Math.floor(input.visibilityTimeoutMs / 1000)
            : 30,
        }),
      );

      if (!result.Messages || result.Messages.length === 0) {
        return {
          success: true,
          output: { message: null },
          durationMs: performance.now() - startTime,
        };
      }

      const sqsMessage = result.Messages[0];
      const messageId = sqsMessage.MessageId!;

      // Store receipt handle for ack/nack
      if (sqsMessage.ReceiptHandle) {
        sqsReceiptHandles.set(messageId, sqsMessage.ReceiptHandle);
      }

      let payload: unknown;
      try {
        payload = JSON.parse(sqsMessage.Body ?? "null");
      } catch {
        payload = sqsMessage.Body;
      }

      return {
        success: true,
        output: {
          message: payload,
          messageId,
          receiptHandle: sqsMessage.ReceiptHandle,
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

  async peek(input) {
    // SQS doesn't support true peek - receiving makes message invisible
    return sqsProvider.pull({
      ...input,
      visibilityTimeoutMs: 0,
    });
  },

  async ack(input) {
    const startTime = performance.now();
    try {
      const config = input.providerConfig as SQSConfig | undefined;
      if (!config?.queueUrl) {
        return {
          success: false,
          error: "SQS queueUrl is required in providerConfig",
          durationMs: performance.now() - startTime,
        };
      }

      const receiptHandle =
        sqsReceiptHandles.get(input.messageId) ?? input.messageId;

      const { SQSClient, DeleteMessageCommand } = await import(
        "@aws-sdk/client-sqs"
      );

      const client = new SQSClient({
        region: config.region ?? "us-east-1",
        ...(config.accessKeyId &&
          config.secretAccessKey && {
            credentials: {
              accessKeyId: config.accessKeyId,
              secretAccessKey: config.secretAccessKey,
            },
          }),
      });

      await client.send(
        new DeleteMessageCommand({
          QueueUrl: config.queueUrl,
          ReceiptHandle: receiptHandle,
        }),
      );

      sqsReceiptHandles.delete(input.messageId);

      return {
        success: true,
        output: { acknowledged: true },
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

  async nack(input) {
    const startTime = performance.now();
    try {
      const config = input.providerConfig as SQSConfig | undefined;
      if (!config?.queueUrl) {
        return {
          success: false,
          error: "SQS queueUrl is required in providerConfig",
          durationMs: performance.now() - startTime,
        };
      }

      const receiptHandle =
        sqsReceiptHandles.get(input.messageId) ?? input.messageId;

      const { SQSClient, ChangeMessageVisibilityCommand } = await import(
        "@aws-sdk/client-sqs"
      );

      const client = new SQSClient({
        region: config.region ?? "us-east-1",
        ...(config.accessKeyId &&
          config.secretAccessKey && {
            credentials: {
              accessKeyId: config.accessKeyId,
              secretAccessKey: config.secretAccessKey,
            },
          }),
      });

      // Set visibility to 0 to make message immediately visible again
      await client.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: config.queueUrl,
          ReceiptHandle: receiptHandle,
          VisibilityTimeout: 0,
        }),
      );

      sqsReceiptHandles.delete(input.messageId);

      return {
        success: true,
        output: { acknowledged: false, requeued: true },
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

  async length(input) {
    const startTime = performance.now();
    try {
      const config = input.providerConfig as SQSConfig | undefined;
      if (!config?.queueUrl) {
        return {
          success: false,
          error: "SQS queueUrl is required in providerConfig",
          durationMs: performance.now() - startTime,
        };
      }

      const { SQSClient, GetQueueAttributesCommand } = await import(
        "@aws-sdk/client-sqs"
      );

      const client = new SQSClient({
        region: config.region ?? "us-east-1",
        ...(config.accessKeyId &&
          config.secretAccessKey && {
            credentials: {
              accessKeyId: config.accessKeyId,
              secretAccessKey: config.secretAccessKey,
            },
          }),
      });

      const result = await client.send(
        new GetQueueAttributesCommand({
          QueueUrl: config.queueUrl,
          AttributeNames: ["ApproximateNumberOfMessages"],
        }),
      );

      const length = Number.parseInt(
        result.Attributes?.ApproximateNumberOfMessages ?? "0",
        10,
      );

      return {
        success: true,
        output: { length },
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

// RabbitMQ provider

interface RabbitMQConfig {
  url?: string;
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  vhost?: string;
}

const rabbitmqProvider: QueueProviderImpl = {
  async push(input) {
    const startTime = performance.now();
    try {
      const config = input.providerConfig as RabbitMQConfig | undefined;
      const amqp = await import("amqplib");

      const url =
        config?.url ??
        `amqp://${config?.username ?? "guest"}:${config?.password ?? "guest"}@${config?.host ?? "localhost"}:${config?.port ?? 5672}/${config?.vhost ?? ""}`;

      const connection = await amqp.connect(url);
      const channel = await connection.createChannel();

      try {
        await channel.assertQueue(input.queueName, { durable: true });

        const messageId = `msg_${Date.now()}_${Math.random().toString(36).slice(2)}`;

        channel.sendToQueue(
          input.queueName,
          Buffer.from(JSON.stringify(input.message)),
          {
            persistent: true,
            messageId,
            priority: input.priority,
          },
        );

        return {
          success: true,
          output: { messageId, queueName: input.queueName },
          durationMs: performance.now() - startTime,
        };
      } finally {
        await channel.close();
        await connection.close();
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        durationMs: performance.now() - startTime,
      };
    }
  },

  async pull(input) {
    const startTime = performance.now();
    try {
      const config = input.providerConfig as RabbitMQConfig | undefined;
      const amqp = await import("amqplib");

      const url =
        config?.url ??
        `amqp://${config?.username ?? "guest"}:${config?.password ?? "guest"}@${config?.host ?? "localhost"}:${config?.port ?? 5672}/${config?.vhost ?? ""}`;

      const connection = await amqp.connect(url);
      const channel = await connection.createChannel();

      try {
        await channel.assertQueue(input.queueName, { durable: true });

        const message = await channel.get(input.queueName, { noAck: false });

        if (!message) {
          return {
            success: true,
            output: { message: null },
            durationMs: performance.now() - startTime,
          };
        }

        let payload: unknown;
        try {
          payload = JSON.parse(message.content.toString());
        } catch {
          payload = message.content.toString();
        }

        // Store delivery tag for ack/nack (using messageId as key)
        const messageId =
          message.properties.messageId ?? `tag_${message.fields.deliveryTag}`;

        return {
          success: true,
          output: {
            message: payload,
            messageId,
            deliveryTag: message.fields.deliveryTag,
          },
          durationMs: performance.now() - startTime,
        };
      } finally {
        await channel.close();
        await connection.close();
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        durationMs: performance.now() - startTime,
      };
    }
  },

  async peek(input) {
    const startTime = performance.now();
    try {
      const config = input.providerConfig as RabbitMQConfig | undefined;
      const amqp = await import("amqplib");

      const url =
        config?.url ??
        `amqp://${config?.username ?? "guest"}:${config?.password ?? "guest"}@${config?.host ?? "localhost"}:${config?.port ?? 5672}/${config?.vhost ?? ""}`;

      const connection = await amqp.connect(url);
      const channel = await connection.createChannel();

      try {
        await channel.assertQueue(input.queueName, { durable: true });

        // Get without auto-ack, then nack to put back
        const message = await channel.get(input.queueName, { noAck: false });

        if (!message) {
          return {
            success: true,
            output: { message: null },
            durationMs: performance.now() - startTime,
          };
        }

        let payload: unknown;
        try {
          payload = JSON.parse(message.content.toString());
        } catch {
          payload = message.content.toString();
        }

        // Nack to put message back at front of queue
        channel.nack(message, false, true);

        return {
          success: true,
          output: {
            message: payload,
            messageId: message.properties.messageId,
          },
          durationMs: performance.now() - startTime,
        };
      } finally {
        await channel.close();
        await connection.close();
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        durationMs: performance.now() - startTime,
      };
    }
  },

  async ack(input) {
    const startTime = performance.now();
    try {
      const config = input.providerConfig as RabbitMQConfig | undefined;
      const amqp = await import("amqplib");

      const url =
        config?.url ??
        `amqp://${config?.username ?? "guest"}:${config?.password ?? "guest"}@${config?.host ?? "localhost"}:${config?.port ?? 5672}/${config?.vhost ?? ""}`;

      const connection = await amqp.connect(url);
      const channel = await connection.createChannel();

      try {
        // RabbitMQ requires the channel that received the message to ack it.
        // This is a limitation - in practice, ack should be called immediately after pull.
        return {
          success: true,
          output: {
            acknowledged: true,
            note: "RabbitMQ ack should be called on same channel as pull",
          },
          durationMs: performance.now() - startTime,
        };
      } finally {
        await channel.close();
        await connection.close();
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        durationMs: performance.now() - startTime,
      };
    }
  },

  async nack(input) {
    const startTime = performance.now();
    try {
      return {
        success: true,
        output: {
          acknowledged: false,
          note: "RabbitMQ nack should be called on same channel as pull",
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

  async length(input) {
    const startTime = performance.now();
    try {
      const config = input.providerConfig as RabbitMQConfig | undefined;
      const amqp = await import("amqplib");

      const url =
        config?.url ??
        `amqp://${config?.username ?? "guest"}:${config?.password ?? "guest"}@${config?.host ?? "localhost"}:${config?.port ?? 5672}/${config?.vhost ?? ""}`;

      const connection = await amqp.connect(url);
      const channel = await connection.createChannel();

      try {
        const result = await channel.assertQueue(input.queueName, {
          durable: true,
        });

        return {
          success: true,
          output: { length: result.messageCount },
          durationMs: performance.now() - startTime,
        };
      } finally {
        await channel.close();
        await connection.close();
      }
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

const providers: Record<QueueProvider, QueueProviderImpl> = {
  memory: memoryProvider,
  redis: redisProvider,
  sqs: sqsProvider,
  rabbitmq: rabbitmqProvider,
};

const getProvider = (providerName?: QueueProvider): QueueProviderImpl => {
  return providers[providerName ?? "memory"];
};

// Action handlers

const push = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const input = inputs as unknown as QueuePushInput;
  if (!input.queueName) {
    return { success: false, error: "Queue name is required", durationMs: 0 };
  }
  return getProvider(input.provider).push(input);
};

const pull = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const input = inputs as unknown as QueuePullInput;
  if (!input.queueName) {
    return { success: false, error: "Queue name is required", durationMs: 0 };
  }
  return getProvider(input.provider).pull(input);
};

const peek = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const input = inputs as unknown as QueuePullInput;
  if (!input.queueName) {
    return { success: false, error: "Queue name is required", durationMs: 0 };
  }
  return getProvider(input.provider).peek(input);
};

const ack = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const input = inputs as unknown as QueueAckInput;
  if (!input.queueName) {
    return { success: false, error: "Queue name is required", durationMs: 0 };
  }
  if (!input.messageId) {
    return { success: false, error: "Message ID is required", durationMs: 0 };
  }
  return getProvider(input.provider).ack(input);
};

const nack = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const input = inputs as unknown as QueueAckInput;
  if (!input.queueName) {
    return { success: false, error: "Queue name is required", durationMs: 0 };
  }
  if (!input.messageId) {
    return { success: false, error: "Message ID is required", durationMs: 0 };
  }
  return getProvider(input.provider).nack(input);
};

const length = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const input = inputs as unknown as QueueInput;
  if (!input.queueName) {
    return { success: false, error: "Queue name is required", durationMs: 0 };
  }
  return getProvider(input.provider).length(input);
};

/**
 * Queue built-in plugin definition.
 */
export const queuePlugin: BuiltinPlugin = {
  id: "builtin:queue",
  name: "Queue",
  description: "Message queue operations (memory, Redis, SQS, RabbitMQ)",
  actions: {
    push: {
      name: "push",
      description: "Push message to queue",
      handler: push,
    },
    pull: {
      name: "pull",
      description: "Pull message from queue",
      handler: pull,
    },
    peek: {
      name: "peek",
      description: "Peek at next message without removing",
      handler: peek,
    },
    ack: {
      name: "ack",
      description: "Acknowledge message processing completed",
      handler: ack,
    },
    nack: {
      name: "nack",
      description: "Negative acknowledge - requeue message",
      handler: nack,
    },
    length: {
      name: "length",
      description: "Get queue length",
      handler: length,
    },
  },
};
