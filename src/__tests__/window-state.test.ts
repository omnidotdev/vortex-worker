/**
 * WindowStateManager Tests
 *
 * Tests for in-workflow event windowing with tumbling, sliding,
 * and session modes, groupBy partitioning, and emit strategies.
 */

import { describe, expect, it } from "bun:test";

import WindowStateManager from "../dsl/window-state";

// Helper to create a controllable clock
function createClock(start = 0) {
  let time = start;

  return {
    now: () => time,
    advance: (ms: number) => {
      time += ms;
    },
    set: (ms: number) => {
      time = ms;
    },
  };
}

// Helper to create a basic event
function event(id: number, extra?: Record<string, unknown>) {
  return { id, ...extra };
}

describe("WindowStateManager", () => {
  describe("tumbling windows", () => {
    it("should accumulate events within a single window", () => {
      const clock = createClock(1000);
      const mgr = new WindowStateManager(
        {
          windowType: "tumbling",
          duration: 5000,
          emit: "onClose",
        },
        clock.now,
      );

      mgr.add(event(1));
      clock.advance(1000);
      mgr.add(event(2));
      clock.advance(1000);
      mgr.add(event(3));

      const frames = mgr.flush();

      expect(frames).toHaveLength(1);
      expect(frames[0].events).toHaveLength(3);
      expect(frames[0].openedAt).toBe(1000);
    });

    it("should close a window when duration elapses", () => {
      const clock = createClock(1000);
      const mgr = new WindowStateManager(
        {
          windowType: "tumbling",
          duration: 3000,
          emit: "onClose",
        },
        clock.now,
      );

      mgr.add(event(1));
      clock.advance(1000);
      mgr.add(event(2));

      // Advance past the window duration
      clock.advance(3000);
      mgr.add(event(3));

      const frames = mgr.flush();

      // First window (events 1, 2) closed on duration, second (event 3) on flush
      expect(frames).toHaveLength(2);
      expect(frames[0].events).toEqual([event(1), event(2)]);
      expect(frames[0].closedAt).toBeDefined();
      expect(frames[1].events).toEqual([event(3)]);
    });

    it("should close a window when maxSize is reached", () => {
      const clock = createClock(1000);
      const mgr = new WindowStateManager(
        {
          windowType: "tumbling",
          duration: 60000,
          maxSize: 2,
          emit: "onClose",
        },
        clock.now,
      );

      const emitted1 = mgr.add(event(1));
      expect(emitted1).toHaveLength(0);

      const emitted2 = mgr.add(event(2));
      // maxSize=2 reached, frame emitted
      expect(emitted2).toHaveLength(1);
      expect(emitted2[0].events).toEqual([event(1), event(2)]);

      mgr.add(event(3));

      const frames = mgr.flush();
      // The maxSize frame was already emitted, plus the remaining event on flush
      expect(frames).toHaveLength(2);
    });

    it("should emit partial snapshots with onEach strategy", () => {
      const clock = createClock(1000);
      const mgr = new WindowStateManager(
        {
          windowType: "tumbling",
          duration: 60000,
          emit: "onEach",
        },
        clock.now,
      );

      const emitted1 = mgr.add(event(1));
      expect(emitted1).toHaveLength(1);
      expect(emitted1[0].events).toEqual([event(1)]);

      clock.advance(100);
      const emitted2 = mgr.add(event(2));
      expect(emitted2).toHaveLength(1);
      expect(emitted2[0].events).toEqual([event(1), event(2)]);
    });

    it("should handle empty flush gracefully", () => {
      const mgr = new WindowStateManager({
        windowType: "tumbling",
        duration: 5000,
        emit: "onClose",
      });

      const frames = mgr.flush();

      expect(frames).toHaveLength(0);
    });
  });

  describe("sliding windows", () => {
    it("should create overlapping frames based on slideDuration", () => {
      const clock = createClock(0);
      const mgr = new WindowStateManager(
        {
          windowType: "sliding",
          duration: 4000,
          slideDuration: 2000,
          emit: "onClose",
        },
        clock.now,
      );

      // t=0: event A -> frame 1 opens at 0
      mgr.add(event(1));

      // t=2000: event B -> frame 2 opens at 2000 (slideDuration elapsed)
      clock.set(2000);
      mgr.add(event(2));

      // t=3000: event C -> both frames active, no new frame needed
      clock.set(3000);
      mgr.add(event(3));

      // t=4000: frame 1 should close (duration=4000 from t=0)
      clock.set(4000);
      mgr.add(event(4));

      const frames = mgr.flush();

      // frame 1 (t=0): events 1,2,3 (closed at t=4000)
      // frame 2 (t=2000): events 2,3,4 (flushed)
      // frame 3 (t=4000): event 4 (flushed)
      expect(frames.length).toBeGreaterThanOrEqual(2);

      // The first frame should contain events from t=0 to t=4000
      const firstFrame = frames[0];
      expect(firstFrame.events).toEqual([event(1), event(2), event(3)]);
    });

    it("should add events to all active overlapping frames", () => {
      const clock = createClock(0);
      const mgr = new WindowStateManager(
        {
          windowType: "sliding",
          duration: 6000,
          slideDuration: 3000,
          emit: "onClose",
        },
        clock.now,
      );

      // t=0: event 1 -> frame A opens
      mgr.add(event(1));

      // t=3000: event 2 -> frame B opens (slideDuration elapsed)
      // Both A and B receive event 2
      clock.set(3000);
      mgr.add(event(2));

      // t=5000: event 3 -> still within both windows
      clock.set(5000);
      mgr.add(event(3));

      const frames = mgr.flush();

      // Frame A opened at 0, should have events 1, 2, 3
      // Frame B opened at 3000, should have events 2, 3
      const frameA = frames.find((f) => f.openedAt === 0);
      const frameB = frames.find((f) => f.openedAt === 3000);

      expect(frameA).toBeDefined();
      expect(frameA!.events).toHaveLength(3);
      expect(frameB).toBeDefined();
      expect(frameB!.events).toHaveLength(2);
    });

    it("should close frames on maxSize", () => {
      const clock = createClock(0);
      const mgr = new WindowStateManager(
        {
          windowType: "sliding",
          duration: 60000,
          slideDuration: 30000,
          maxSize: 2,
          emit: "onClose",
        },
        clock.now,
      );

      mgr.add(event(1));
      const emitted = mgr.add(event(2));

      // Frame should close on maxSize
      expect(emitted.length).toBeGreaterThanOrEqual(1);
      expect(emitted[0].events).toEqual([event(1), event(2)]);
    });

    it("should emit partial with onEach strategy", () => {
      const clock = createClock(0);
      const mgr = new WindowStateManager(
        {
          windowType: "sliding",
          duration: 10000,
          slideDuration: 5000,
          emit: "onEach",
        },
        clock.now,
      );

      const emitted1 = mgr.add(event(1));
      expect(emitted1).toHaveLength(1);
      expect(emitted1[0].events).toEqual([event(1)]);

      const emitted2 = mgr.add(event(2));
      expect(emitted2).toHaveLength(1);
      expect(emitted2[0].events).toEqual([event(1), event(2)]);
    });

    it("should default slideDuration to duration when not specified", () => {
      const clock = createClock(0);
      const mgr = new WindowStateManager(
        {
          windowType: "sliding",
          duration: 5000,
          emit: "onClose",
        },
        clock.now,
      );

      mgr.add(event(1));

      // At exactly the duration, a new frame should open
      clock.set(5000);
      mgr.add(event(2));

      const frames = mgr.flush();

      // Should have two frames since slideDuration = duration (effectively tumbling)
      expect(frames.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("session windows", () => {
    it("should keep a session open while events arrive within the gap", () => {
      const clock = createClock(1000);
      const mgr = new WindowStateManager(
        {
          windowType: "session",
          duration: 5000,
          sessionGap: 3000,
          emit: "onClose",
        },
        clock.now,
      );

      mgr.add(event(1));
      clock.advance(1000); // t=2000, within gap
      mgr.add(event(2));
      clock.advance(1000); // t=3000, within gap
      mgr.add(event(3));

      const frames = mgr.flush();

      expect(frames).toHaveLength(1);
      expect(frames[0].events).toHaveLength(3);
      expect(frames[0].openedAt).toBe(1000);
    });

    it("should close a session when the gap is exceeded", () => {
      const clock = createClock(1000);
      const mgr = new WindowStateManager(
        {
          windowType: "session",
          duration: 60000,
          sessionGap: 2000,
          emit: "onClose",
        },
        clock.now,
      );

      mgr.add(event(1));
      clock.advance(1000); // t=2000
      mgr.add(event(2));

      // Gap of 3000ms exceeds sessionGap of 2000ms
      clock.advance(3000); // t=5000
      mgr.add(event(3));

      const frames = mgr.flush();

      // Session 1 (events 1, 2), Session 2 (event 3)
      expect(frames).toHaveLength(2);
      expect(frames[0].events).toEqual([event(1), event(2)]);
      expect(frames[1].events).toEqual([event(3)]);
    });

    it("should close a session on maxSize", () => {
      const clock = createClock(0);
      const mgr = new WindowStateManager(
        {
          windowType: "session",
          duration: 60000,
          sessionGap: 5000,
          maxSize: 2,
          emit: "onClose",
        },
        clock.now,
      );

      mgr.add(event(1));
      clock.advance(100);
      const emitted = mgr.add(event(2));

      expect(emitted).toHaveLength(1);
      expect(emitted[0].events).toEqual([event(1), event(2)]);

      // Next event starts a new session
      clock.advance(100);
      mgr.add(event(3));

      const frames = mgr.flush();
      expect(frames).toHaveLength(2);
    });

    it("should default sessionGap to duration when not specified", () => {
      const clock = createClock(0);
      const mgr = new WindowStateManager(
        {
          windowType: "session",
          duration: 2000,
          emit: "onClose",
        },
        clock.now,
      );

      mgr.add(event(1));
      clock.advance(1000);
      mgr.add(event(2));

      // Exceeds duration (used as gap fallback)
      clock.advance(3000);
      mgr.add(event(3));

      const frames = mgr.flush();

      expect(frames).toHaveLength(2);
      expect(frames[0].events).toHaveLength(2);
      expect(frames[1].events).toHaveLength(1);
    });

    it("should emit partial with onEach strategy", () => {
      const clock = createClock(0);
      const mgr = new WindowStateManager(
        {
          windowType: "session",
          duration: 60000,
          sessionGap: 5000,
          emit: "onEach",
        },
        clock.now,
      );

      const emitted1 = mgr.add(event(1));
      expect(emitted1).toHaveLength(1);
      expect(emitted1[0].events).toEqual([event(1)]);

      clock.advance(1000);
      const emitted2 = mgr.add(event(2));
      expect(emitted2).toHaveLength(1);
      expect(emitted2[0].events).toEqual([event(1), event(2)]);
    });
  });

  describe("groupBy partitioning", () => {
    it("should partition events by the specified field", () => {
      const clock = createClock(0);
      const mgr = new WindowStateManager(
        {
          windowType: "tumbling",
          duration: 60000,
          groupBy: "userId",
          emit: "onClose",
        },
        clock.now,
      );

      mgr.add(event(1, { userId: "alice" }));
      mgr.add(event(2, { userId: "bob" }));
      mgr.add(event(3, { userId: "alice" }));
      mgr.add(event(4, { userId: "bob" }));

      const frames = mgr.flush();

      expect(frames).toHaveLength(2);

      const aliceFrame = frames.find((f) => f.partition === "alice");
      const bobFrame = frames.find((f) => f.partition === "bob");

      expect(aliceFrame).toBeDefined();
      expect(aliceFrame!.events).toHaveLength(2);
      expect(bobFrame).toBeDefined();
      expect(bobFrame!.events).toHaveLength(2);
    });

    it("should use default partition when groupBy field is missing", () => {
      const clock = createClock(0);
      const mgr = new WindowStateManager(
        {
          windowType: "tumbling",
          duration: 60000,
          groupBy: "userId",
          emit: "onClose",
        },
        clock.now,
      );

      mgr.add(event(1, { userId: "alice" }));
      mgr.add(event(2)); // no userId
      mgr.add({ name: "no-id-event" }); // no userId

      const frames = mgr.flush();

      expect(frames).toHaveLength(2);

      const aliceFrame = frames.find((f) => f.partition === "alice");
      const defaultFrame = frames.find((f) => f.partition === "__default__");

      expect(aliceFrame).toBeDefined();
      expect(aliceFrame!.events).toHaveLength(1);
      expect(defaultFrame).toBeDefined();
      expect(defaultFrame!.events).toHaveLength(2);
    });

    it("should handle groupBy with session windows independently", () => {
      const clock = createClock(0);
      const mgr = new WindowStateManager(
        {
          windowType: "session",
          duration: 60000,
          sessionGap: 2000,
          groupBy: "sensorId",
          emit: "onClose",
        },
        clock.now,
      );

      mgr.add(event(1, { sensorId: "A" }));
      clock.advance(1000);
      mgr.add(event(2, { sensorId: "B" }));
      clock.advance(1000);
      mgr.add(event(3, { sensorId: "A" })); // within gap for A

      // Exceed gap for sensor B (last B event at t=1000, now at t=5000)
      clock.advance(3000);
      mgr.add(event(4, { sensorId: "B" })); // new session for B

      const frames = mgr.flush();

      // Sensor A: 1 session with events 1, 3
      // Sensor B: 2 sessions (event 2) and (event 4)
      const sensorAFrames = frames.filter((f) => f.partition === "A");
      const sensorBFrames = frames.filter((f) => f.partition === "B");

      expect(sensorAFrames).toHaveLength(1);
      expect(sensorAFrames[0].events).toHaveLength(2);
      expect(sensorBFrames).toHaveLength(2);
    });
  });

  describe("drain", () => {
    it("should return emitted frames without closing open windows", () => {
      const clock = createClock(0);
      const mgr = new WindowStateManager(
        {
          windowType: "tumbling",
          duration: 60000,
          maxSize: 2,
          emit: "onClose",
        },
        clock.now,
      );

      mgr.add(event(1));
      mgr.add(event(2)); // maxSize triggers emit
      mgr.add(event(3)); // starts new window

      const drained = mgr.drain();
      expect(drained).toHaveLength(1);
      expect(drained[0].events).toEqual([event(1), event(2)]);

      // Event 3 is still in an open window
      const flushed = mgr.flush();
      expect(flushed).toHaveLength(1);
      expect(flushed[0].events).toEqual([event(3)]);
    });
  });

  describe("edge cases", () => {
    it("should handle non-object events for groupBy", () => {
      const clock = createClock(0);
      const mgr = new WindowStateManager(
        {
          windowType: "tumbling",
          duration: 60000,
          groupBy: "key",
          emit: "onClose",
        },
        clock.now,
      );

      mgr.add("string-event");
      mgr.add(42);
      mgr.add(null);

      const frames = mgr.flush();

      // All go to default partition
      expect(frames).toHaveLength(1);
      expect(frames[0].events).toHaveLength(3);
      expect(frames[0].partition).toBe("__default__");
    });

    it("should handle single event", () => {
      const clock = createClock(0);
      const mgr = new WindowStateManager(
        {
          windowType: "tumbling",
          duration: 5000,
          emit: "onClose",
        },
        clock.now,
      );

      mgr.add(event(1));

      const frames = mgr.flush();

      expect(frames).toHaveLength(1);
      expect(frames[0].events).toEqual([event(1)]);
    });

    it("should handle maxSize of 1", () => {
      const clock = createClock(0);
      const mgr = new WindowStateManager(
        {
          windowType: "tumbling",
          duration: 60000,
          maxSize: 1,
          emit: "onClose",
        },
        clock.now,
      );

      const emitted1 = mgr.add(event(1));
      expect(emitted1).toHaveLength(1);

      const emitted2 = mgr.add(event(2));
      expect(emitted2).toHaveLength(1);

      const frames = mgr.flush();
      // Both events were emitted individually via maxSize
      expect(frames).toHaveLength(2);
    });

    it("should coerce groupBy values to strings", () => {
      const clock = createClock(0);
      const mgr = new WindowStateManager(
        {
          windowType: "tumbling",
          duration: 60000,
          groupBy: "code",
          emit: "onClose",
        },
        clock.now,
      );

      mgr.add({ code: 200, id: 1 });
      mgr.add({ code: 200, id: 2 });
      mgr.add({ code: 404, id: 3 });

      const frames = mgr.flush();

      const frame200 = frames.find((f) => f.partition === "200");
      const frame404 = frames.find((f) => f.partition === "404");

      expect(frame200).toBeDefined();
      expect(frame200!.events).toHaveLength(2);
      expect(frame404).toBeDefined();
      expect(frame404!.events).toHaveLength(1);
    });
  });
});
