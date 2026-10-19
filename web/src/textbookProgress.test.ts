import { describe, expect, it } from "vitest";
import { parseReadingPosition } from "./textbookProgress";

describe("independent textbook positions", () => {
  it("accepts a complete saved position without reading another lesson", () => {
    const raw = JSON.stringify({
      version: 1,
      lessons: {
        "1:1": {
          position: 15,
          duration: 37,
          rate: 0.75,
          sentence: "s4",
          completed: false,
        },
      },
    });
    expect(parseReadingPosition(raw, "1:1")).toEqual({
      position: 15,
      duration: 37,
      rate: 0.75,
      sentence: "s4",
      completed: false,
    });
    expect(parseReadingPosition(raw, "2:1").position).toBe(0);
  });
  it("recovers from invalid storage and clamps obsolete durations", () => {
    for (const raw of [null, "{broken", "null", '{"version":7}'])
      expect(parseReadingPosition(raw, "1:1").rate).toBe(1);
    const raw = JSON.stringify({
      version: 1,
      lessons: {
        "1:1": {
          position: 500,
          duration: 37,
          rate: 9,
          sentence: null,
          completed: true,
        },
      },
    });
    expect(parseReadingPosition(raw, "1:1")).toEqual({
      position: 37,
      duration: 37,
      rate: 1,
      sentence: "",
      completed: true,
    });
  });
});
