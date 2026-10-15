import { describe, expect, it } from "vitest";
import { emptyProgress, parseProgress, resumePosition } from "./progress";

describe("browser progress", () => {
  it("recovers safely from invalid storage or an incompatible version", () => {
    for (const raw of [
      null,
      "broken",
      "{}",
      '{"version":2,"lessons":{}}',
      '{"version":1,"lessons":null}',
    ])
      expect(parseProgress(raw)).toEqual(emptyProgress());
  });
  it("restores the last lesson and validates playback positions", () => {
    const saved = parseProgress(
      JSON.stringify({
        version: 1,
        lastLesson: "a",
        lessons: {
          a: { position: 45, duration: 100, completed: false },
          b: { position: -20, duration: 100 },
          c: { position: 500, duration: 100, completed: true },
          d: null,
        },
      }),
    );
    expect(saved.lastLesson).toBe("a");
    expect(resumePosition(saved.lessons.a, 100)).toBe(45);
    expect(saved.lessons.b.position).toBe(0);
    expect(saved.lessons.c.position).toBe(100);
    expect(saved.lessons.c.completed).toBe(true);
    expect(saved.lessons.d).toBeUndefined();
  });
  it("starts completed playback from the beginning and handles missing metadata", () => {
    const progress = {
      position: 99,
      duration: 100,
      completed: true,
      updatedAt: 0,
    };
    expect(resumePosition(progress, 100)).toBe(0);
    expect(resumePosition(progress, NaN)).toBe(0);
    expect(resumePosition(undefined, 100)).toBe(0);
  });
});
