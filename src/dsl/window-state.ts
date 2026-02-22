/**
 * In-memory window state manager for workflow-level event windowing.
 *
 * Supports tumbling, sliding, and session windows with optional
 * groupBy partitioning and configurable emit strategies.
 */

import type { WindowStep } from "./types";

const DEFAULT_PARTITION = "__default__";

export type WindowConfig = WindowStep["window"];

export type WindowFrame = {
  /** Events collected in this frame */
  events: unknown[];
  /** Frame open time (epoch ms) */
  openedAt: number;
  /** Frame close time (epoch ms), set when the frame is emitted */
  closedAt?: number;
  /** Partition key value */
  partition: string;
};

type PartitionState = {
  /** Active frames for this partition */
  frames: WindowFrame[];
  /** Timestamp of the last event added (epoch ms) */
  lastEventAt: number;
};

/**
 * Manage window state for a single workflow step execution.
 *
 * Events are fed one at a time via `add()`. Completed window frames
 * are collected via `flush()` after all events have been added.
 * For `onEach` emit strategy, partial results are emitted on every
 * `add()` call and collected via `drain()`.
 */
class WindowStateManager {
  #config: WindowConfig;
  #partitions: Map<string, PartitionState>;
  #emitted: WindowFrame[];
  #now: () => number;

  constructor(config: WindowConfig, now?: () => number) {
    this.#config = config;
    this.#partitions = new Map();
    this.#emitted = [];
    // Allow injecting a clock for deterministic tests
    this.#now = now ?? (() => Date.now());
  }

  /**
   * Add an event to the appropriate partition and window frame.
   *
   * Returns any frames that were emitted as a result of this event
   * (only relevant for `onEach` emit strategy or maxSize triggers).
   */
  add(event: unknown): WindowFrame[] {
    const key = this.#getPartitionKey(event);
    const ts = this.#now();
    const emitted: WindowFrame[] = [];

    let state = this.#partitions.get(key);

    if (!state) {
      state = { frames: [], lastEventAt: ts };
      this.#partitions.set(key, state);
    }

    switch (this.#config.windowType) {
      case "tumbling":
        emitted.push(...this.#addTumbling(state, event, ts, key));
        break;
      case "sliding":
        emitted.push(...this.#addSliding(state, event, ts, key));
        break;
      case "session":
        emitted.push(...this.#addSession(state, event, ts, key));
        break;
    }

    state.lastEventAt = ts;

    this.#emitted.push(...emitted);

    return emitted;
  }

  /**
   * Flush all remaining open frames and return every emitted frame.
   *
   * Called after all events have been added. Closes any open windows
   * that have not yet been emitted (relevant for `onClose` strategy).
   */
  flush(): WindowFrame[] {
    const ts = this.#now();

    for (const [, state] of this.#partitions) {
      for (const frame of state.frames) {
        if (frame.events.length > 0 && !frame.closedAt) {
          frame.closedAt = ts;
          this.#emitted.push(frame);
        }
      }

      state.frames = [];
    }

    const result = [...this.#emitted];
    this.#emitted = [];

    return result;
  }

  /**
   * Drain only the frames that have been emitted so far without
   * closing open windows. Useful for `onEach` streaming.
   */
  drain(): WindowFrame[] {
    const result = [...this.#emitted];
    this.#emitted = [];

    return result;
  }

  // -- Tumbling window logic --

  #addTumbling(
    state: PartitionState,
    event: unknown,
    ts: number,
    partition: string,
  ): WindowFrame[] {
    const emitted: WindowFrame[] = [];

    // Get or create the single active frame
    let frame = state.frames[0];

    if (!frame) {
      frame = { events: [], openedAt: ts, partition };
      state.frames = [frame];
    }

    // Check if the current frame's duration has elapsed
    if (ts - frame.openedAt >= this.#config.duration) {
      // Close the expired frame if it has events
      if (frame.events.length > 0) {
        frame.closedAt = frame.openedAt + this.#config.duration;
        emitted.push(frame);
      }

      // Start a new frame
      frame = { events: [], openedAt: ts, partition };
      state.frames = [frame];
    }

    frame.events.push(event);

    // Check maxSize
    if (this.#config.maxSize && frame.events.length >= this.#config.maxSize) {
      frame.closedAt = ts;
      emitted.push(frame);

      // Start a new frame for subsequent events
      state.frames = [{ events: [], openedAt: ts, partition }];
    }

    // For onEach, emit the current frame snapshot
    if (this.#config.emit === "onEach" && emitted.length === 0) {
      emitted.push({
        events: [...frame.events],
        openedAt: frame.openedAt,
        partition,
      });
    }

    return emitted;
  }

  // -- Sliding window logic --

  #addSliding(
    state: PartitionState,
    event: unknown,
    ts: number,
    partition: string,
  ): WindowFrame[] {
    const emitted: WindowFrame[] = [];
    const slideDuration = this.#config.slideDuration ?? this.#config.duration;

    // Close and emit any frames that have exceeded their duration
    const closedIndices: number[] = [];

    for (let i = 0; i < state.frames.length; i++) {
      const frame = state.frames[i];

      if (ts - frame.openedAt >= this.#config.duration) {
        if (frame.events.length > 0 && !frame.closedAt) {
          frame.closedAt = frame.openedAt + this.#config.duration;
          emitted.push(frame);
        }

        closedIndices.push(i);
      }
    }

    // Remove closed frames (iterate in reverse to preserve indices)
    for (let i = closedIndices.length - 1; i >= 0; i--) {
      state.frames.splice(closedIndices[i], 1);
    }

    // Check if we need a new sliding frame
    const lastFrame = state.frames[state.frames.length - 1];
    const needNewFrame = !lastFrame || ts - lastFrame.openedAt >= slideDuration;

    if (needNewFrame) {
      const newFrame: WindowFrame = {
        events: [],
        openedAt: ts,
        partition,
      };
      state.frames.push(newFrame);
    }

    // Add event to all active frames (overlapping windows)
    for (const frame of state.frames) {
      frame.events.push(event);

      // Check maxSize per frame
      if (
        this.#config.maxSize &&
        frame.events.length >= this.#config.maxSize &&
        !frame.closedAt
      ) {
        frame.closedAt = ts;
        emitted.push(frame);
      }
    }

    // Remove any frames that were just closed by maxSize
    state.frames = state.frames.filter((f) => !f.closedAt);

    // For onEach, emit the most recent frame snapshot
    if (this.#config.emit === "onEach" && emitted.length === 0) {
      const current = state.frames[state.frames.length - 1];

      if (current) {
        emitted.push({
          events: [...current.events],
          openedAt: current.openedAt,
          partition,
        });
      }
    }

    return emitted;
  }

  // -- Session window logic --

  #addSession(
    state: PartitionState,
    event: unknown,
    ts: number,
    partition: string,
  ): WindowFrame[] {
    const emitted: WindowFrame[] = [];
    const gap = this.#config.sessionGap ?? this.#config.duration;

    let frame = state.frames[0];

    // Close active session if inactivity gap is exceeded
    if (frame && frame.events.length > 0) {
      if (ts - state.lastEventAt > gap) {
        frame.closedAt = state.lastEventAt;
        emitted.push(frame);

        frame = undefined as unknown as WindowFrame;
        state.frames = [];
      }
    }

    if (!frame) {
      frame = { events: [], openedAt: ts, partition };
      state.frames = [frame];
    }

    frame.events.push(event);

    // Check maxSize
    if (this.#config.maxSize && frame.events.length >= this.#config.maxSize) {
      frame.closedAt = ts;
      emitted.push(frame);
      state.frames = [];
    }

    // For onEach, emit the current session snapshot
    if (this.#config.emit === "onEach" && emitted.length === 0) {
      emitted.push({
        events: [...frame.events],
        openedAt: frame.openedAt,
        partition,
      });
    }

    return emitted;
  }

  // -- Utilities --

  /**
   * Extract partition key value from an event object.
   *
   * Returns DEFAULT_PARTITION when no groupBy is configured or
   * the event does not contain the specified field.
   */
  #getPartitionKey(event: unknown): string {
    if (!this.#config.groupBy) return DEFAULT_PARTITION;

    if (
      event !== null &&
      typeof event === "object" &&
      this.#config.groupBy in event
    ) {
      const value = (event as Record<string, unknown>)[this.#config.groupBy];

      if (value !== null && value !== undefined) {
        return String(value);
      }
    }

    return DEFAULT_PARTITION;
  }
}

export default WindowStateManager;
