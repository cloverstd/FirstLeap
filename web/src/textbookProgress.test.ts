import { afterEach, describe, expect, it, vi } from "vitest";
import {
  lastLessonInBook,
  parseReadingPosition,
  parseTextbookProgress,
  readPosition,
  writePosition,
} from "./textbookProgress";

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
      markerMode: "sentence",
      lastVisitedAt: 0,
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
      markerMode: "sentence",
      lastVisitedAt: 0,
    });
  });
});

afterEach(() => vi.unstubAllGlobals());
describe("textbook progress merging", () => {
  it("keeps explicit completion and marker choices when a player saves a position", () => {
    const memory = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => memory.get(key) || null,
      setItem: (key: string, value: string) => memory.set(key, value),
    });
    writePosition("1:1", { position: 5, duration: 37 }, true);
    writePosition("1:1", { completed: true, markerMode: "paragraph" });
    writePosition("1:1", { position: 12, duration: 37, rate: 1.25 });
    expect(readPosition("1:1")).toMatchObject({
      completed: true,
      markerMode: "paragraph",
      position: 12,
    });
    writePosition("1:1", { completed: false });
    writePosition("1:1", { position: 13 });
    expect(readPosition("1:1").completed).toBe(false);
    expect(readPosition("1:3").markerMode).toBe("sentence");
    writePosition("1:3", { completed: true, duration: 40 });
    const state = parseTextbookProgress(memory.values().next().value || null);
    expect(state.lastLesson).toBe("1:1");
    expect(lastLessonInBook(state, 1)).toBe("1:1");
  });
  it("keeps session progress when persistent storage is unavailable", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
    });
    expect(
      writePosition("4:48", {
        duration: 100,
        position: 35,
        markerMode: "paragraph",
      }),
    ).toBe(false);
    expect(readPosition("4:48")).toMatchObject({
      position: 35,
      markerMode: "paragraph",
    });
  });
});
