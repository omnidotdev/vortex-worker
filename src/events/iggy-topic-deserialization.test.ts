import { describe, expect, it } from "bun:test";

import {
  deserializeBaseTopic,
  deserializeTopic,
  deserializeTopics,
} from "@iggy.rs/sdk/dist/wire/topic/topic.utils.js";

/**
 * Build a binary buffer for a base topic header (no partitions).
 * Matches the Iggy server wire format:
 *   id(4) + createdAt(8) + partitionsCount(4) + compressionAlgorithm(1) +
 *   messageExpiry(8) + maxTopicSize(8) + replicationFactor(1) +
 *   sizeBytes(8) + messagesCount(8) + nameLength(1) + name(N)
 * Total: 51 + nameLength bytes
 */
function buildBaseTopicBuffer(opts: {
  id: number;
  name: string;
  partitionsCount: number;
}): Buffer {
  const nameBytes = Buffer.from(opts.name);
  const buf = Buffer.alloc(51 + nameBytes.length);
  let pos = 0;

  buf.writeUInt32LE(opts.id, pos);
  pos += 4; // id
  buf.writeBigUInt64LE(BigInt(Date.now()) * 1000n, pos);
  pos += 8; // createdAt (microseconds)
  buf.writeUInt32LE(opts.partitionsCount, pos);
  pos += 4; // partitionsCount
  buf.writeUInt8(1, pos);
  pos += 1; // compressionAlgorithm (None)
  buf.writeBigUInt64LE(0n, pos);
  pos += 8; // messageExpiry
  buf.writeBigUInt64LE(0n, pos);
  pos += 8; // maxTopicSize
  buf.writeUInt8(1, pos);
  pos += 1; // replicationFactor
  buf.writeBigUInt64LE(1024n, pos);
  pos += 8; // sizeBytes
  buf.writeBigUInt64LE(42n, pos);
  pos += 8; // messagesCount
  buf.writeUInt8(nameBytes.length, pos);
  pos += 1; // nameLength
  nameBytes.copy(buf, pos);

  return buf;
}

/**
 * Build a 40-byte binary partition buffer.
 *   id(4) + createdAt(8) + segmentsCount(4) + currentOffset(8) +
 *   sizeBytes(8) + messagesCount(8)
 */
function buildPartitionBuffer(id: number): Buffer {
  const buf = Buffer.alloc(40);
  buf.writeUInt32LE(id, 0);
  buf.writeBigUInt64LE(BigInt(Date.now()) * 1000n, 4);
  buf.writeUInt32LE(1, 12); // segmentsCount
  buf.writeBigUInt64LE(100n, 16); // currentOffset
  buf.writeBigUInt64LE(512n, 24); // sizeBytes (SDK also reads messagesCount from same offset)

  return buf;
}

describe("Iggy SDK topic deserialization (patched)", () => {
  describe("deserializeBaseTopic", () => {
    it("parses a single base topic header correctly", () => {
      const buf = buildBaseTopicBuffer({
        id: 1,
        name: "user.created",
        partitionsCount: 3,
      });

      const { bytesRead, data } = deserializeBaseTopic(buf);

      expect(data.id).toBe(1);
      expect(data.name).toBe("user.created");
      expect(data.partitionsCount).toBe(3);
      expect(bytesRead).toBe(51 + "user.created".length);
    });
  });

  describe("deserializeTopics (GET_TOPICS list response)", () => {
    it("parses multiple topics from a concatenated buffer without partition data", () => {
      const topic1 = buildBaseTopicBuffer({
        id: 1,
        name: "user.created",
        partitionsCount: 3,
      });
      const topic2 = buildBaseTopicBuffer({
        id: 2,
        name: "order.placed",
        partitionsCount: 3,
      });
      const topic3 = buildBaseTopicBuffer({
        id: 3,
        name: "payment.completed",
        partitionsCount: 5,
      });

      const buf = Buffer.concat([topic1, topic2, topic3]);
      const topics = deserializeTopics(buf);

      expect(topics).toHaveLength(3);
      expect(topics[0].id).toBe(1);
      expect(topics[0].name).toBe("user.created");
      expect(topics[0].partitionsCount).toBe(3);
      expect(topics[1].id).toBe(2);
      expect(topics[1].name).toBe("order.placed");
      expect(topics[2].id).toBe(3);
      expect(topics[2].name).toBe("payment.completed");
      expect(topics[2].partitionsCount).toBe(5);
    });

    it("does not attempt to read partition data from list response", () => {
      // Build a buffer with topics that claim 3 partitions each,
      // but no partition bytes follow, this is the real GET_TOPICS format.
      // Without the patch, this would throw a Buffer out-of-range error.
      const topics = Array.from({ length: 5 }, (_, i) =>
        buildBaseTopicBuffer({
          id: i + 1,
          name: `topic-${i + 1}`,
          partitionsCount: 3,
        }),
      );

      const buf = Buffer.concat(topics);
      const result = deserializeTopics(buf);

      expect(result).toHaveLength(5);

      for (let i = 0; i < 5; i++) {
        expect(result[i].id).toBe(i + 1);
        expect(result[i].name).toBe(`topic-${i + 1}`);
      }
    });

    it("returns empty array for empty buffer", () => {
      const result = deserializeTopics(Buffer.alloc(0));
      expect(result).toHaveLength(0);
    });

    it("handles single topic in list response", () => {
      const buf = buildBaseTopicBuffer({
        id: 99,
        name: "solo",
        partitionsCount: 1,
      });

      const result = deserializeTopics(buf);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(99);
      expect(result[0].name).toBe("solo");
    });
  });

  describe("deserializeTopic (GET_TOPIC single response)", () => {
    it("parses a topic with partition data", () => {
      const baseTopic = buildBaseTopicBuffer({
        id: 1,
        name: "events",
        partitionsCount: 2,
      });
      const partition1 = buildPartitionBuffer(1);
      const partition2 = buildPartitionBuffer(2);

      const buf = Buffer.concat([baseTopic, partition1, partition2]);
      const { data } = deserializeTopic(buf);

      expect(data.id).toBe(1);
      expect(data.name).toBe("events");
      expect(data.partitions).toHaveLength(2);
      expect(data.partitions[0].id).toBe(1);
      expect(data.partitions[1].id).toBe(2);
    });

    it("reads exactly partitionsCount partitions and no more", () => {
      // Build a buffer with 2 partitions declared but 3 partition buffers appended.
      // The patched code should only read 2, not consume the trailing bytes.
      const baseTopic = buildBaseTopicBuffer({
        id: 1,
        name: "test",
        partitionsCount: 2,
      });
      const partitions = [1, 2, 3].map(buildPartitionBuffer);

      const buf = Buffer.concat([baseTopic, ...partitions]);
      const { bytesRead, data } = deserializeTopic(buf);

      expect(data.partitions).toHaveLength(2);
      // Should have consumed base + 2 partitions, not all 3
      const expectedBytes = 51 + "test".length + 2 * 40;
      expect(bytesRead).toBe(expectedBytes);
    });

    it("handles zero partitions", () => {
      const buf = buildBaseTopicBuffer({
        id: 5,
        name: "empty",
        partitionsCount: 0,
      });

      const { data } = deserializeTopic(buf);

      expect(data.id).toBe(5);
      expect(data.name).toBe("empty");
      expect(data.partitions).toHaveLength(0);
    });
  });
});
