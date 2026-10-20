import { describe, expect, it } from "vitest";
import {
  parseShadowSettings,
  shadowDelay,
  shadowSegments,
} from "./shadowReading";

const paragraphs = [
  {
    id: "p1",
    sentences: [
      { id: "s1", text: "Hello", start: 2, end: 3.8 },
      { id: "s2", text: "Again", start: 5, end: 6.8 },
    ],
  },
  {
    id: "note",
    sentences: [{ id: "untimed", text: "Note", start: null, end: null }],
  },
  { id: "p2", sentences: [{ id: "s3", text: "Goodbye", start: 8, end: 10 }] },
];

describe("shadow reading turns", () => {
  it("uses consecutive starts and the final body end, excluding intro and outro", () => {
    expect(
      shadowSegments(paragraphs, "sentence", 12).map((s) => [
        s.start,
        s.end,
        s.marker.targetId,
      ]),
    ).toEqual([
      [2, 5, "s1"],
      [5, 8, "s2"],
      [8, 10, "s3"],
    ]);
    expect(
      shadowSegments(paragraphs, "paragraph", 12).map((s) => [
        s.start,
        s.end,
        s.marker.targetId,
      ]),
    ).toEqual([
      [2, 8, "p1"],
      [8, 10, "p2"],
    ]);
  });
  it("skips invalid timings and merges duplicate starts into one positive turn", () => {
    const invalid = {
      id: "bad",
      sentences: [
        { id: "nan", text: "Invalid", start: NaN, end: 5 },
        { id: "negative", text: "Invalid", start: -1, end: 2 },
        { id: "reversed", text: "Invalid", start: 3, end: 2 },
        { id: "long", text: "Invalid", start: 4, end: 20 },
      ],
    };
    expect(shadowSegments([invalid], "sentence", 12)).toEqual([]);
    const duplicate = {
      id: "duplicate",
      sentences: [{ id: "same", text: "Same", start: 2, end: 4 }],
    };
    expect(
      shadowSegments([invalid, duplicate, ...paragraphs], "sentence", 12).map(
        (s) => [s.start, s.end],
      ),
    ).toEqual([
      [2, 5],
      [5, 8],
      [8, 10],
    ]);
  });
  it("scales the wait with playback speed and rejects unusable durations", () => {
    expect(shadowDelay(4, 1)).toBe(4000);
    expect(shadowDelay(4, 2)).toBe(2000);
    expect(shadowDelay(0.39, 0.5)).toBe(780);
    for (const duration of [0, -1, NaN, Infinity])
      expect(shadowDelay(duration, 1)).toBe(0);
    for (const rate of [0, -1, NaN, Infinity])
      expect(shadowDelay(4, rate)).toBe(0);
  });
  it("defaults safely and restores browser preferences", () => {
    for (const raw of [
      null,
      "broken",
      "{}",
      "null",
      '{"enabled":"true","mode":"other"}',
    ])
      expect(parseShadowSettings(raw)).toEqual({
        enabled: false,
        mode: "sentence",
      });
    expect(parseShadowSettings('{"enabled":true,"mode":"paragraph"}')).toEqual({
      enabled: true,
      mode: "paragraph",
    });
  });
});
