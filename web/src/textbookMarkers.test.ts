import { describe, expect, it } from "vitest";
import {
  buildMarkers,
  groupMarkers,
  markerAtPosition,
  markerLabel,
  lessonAudioRange,
} from "./textbookMarkers";
const paragraphs = [
  {
    id: "p1",
    sentences: [
      { id: "s1", text: "Hello", start: 2, end: 4 },
      { id: "s2", text: "Again", start: 4, end: 6 },
    ],
  },
  {
    id: "note",
    sentences: [{ id: "untimed", text: "A note", start: null, end: null }],
  },
  { id: "p2", sentences: [{ id: "s3", text: "Goodbye", start: 8, end: 10 }] },
];
describe("audio boundary markers", () => {
  it("marks the first start and adds only the final sentence end", () => {
    const markers = buildMarkers(paragraphs, "sentence", 12);
    expect(markers.map((m) => [m.id, m.time])).toEqual([
      ["s1-start", 2],
      ["s2-start", 4],
      ["s3-start", 8],
      ["s3-end", 10],
    ]);
    expect(markers[0].boundary).toBe("start");
    expect(markerLabel(markers[0])).toContain("课文开始");
    expect(markers.at(-1)?.boundary).toBe("end");
    expect(markerLabel(markers.at(-1)!)).toBe("课文结束 · 0:10");
  });
  it("keeps the same body boundaries when using paragraph starts", () => {
    expect(
      buildMarkers(paragraphs, "paragraph", 12).map((m) => [m.id, m.time]),
    ).toEqual([
      ["p1-start", 2],
      ["p2-start", 8],
      ["p2-end", 10],
    ]);
    expect(lessonAudioRange(paragraphs, 12)).toEqual({ start: 2, end: 10 });
  });
  it("rejects unusable timing without falling back to the intro and outro", () => {
    const invalid = [
      {
        id: "p",
        sentences: [
          { id: "empty", text: "Note", start: null, end: null },
          { id: "negative", text: "Invalid", start: -1, end: 1 },
          { id: "reversed", text: "Invalid", start: 4, end: 3 },
          { id: "long", text: "Invalid", start: 4, end: 20 },
          { id: "nan", text: "Invalid", start: NaN, end: 5 },
        ],
      },
    ];
    expect(lessonAudioRange(invalid, 12)).toBeNull();
    expect(buildMarkers(invalid, "sentence", 12)).toEqual([]);
    expect(lessonAudioRange([...invalid, ...paragraphs], 12)).toEqual({
      start: 2,
      end: 10,
    });
    expect(lessonAudioRange([], 12)).toBeNull();
  });
  it("uses the latest valid end even with overlapping timing", () => {
    const overlapping = [
      {
        id: "p",
        sentences: [
          { id: "s1", text: "Long", start: 2, end: 10 },
          { id: "s2", text: "Short", start: 4, end: 6 },
        ],
      },
    ];
    expect(lessonAudioRange(overlapping, 12)).toEqual({ start: 2, end: 10 });
    for (const mode of ["sentence", "paragraph"] as const) {
      const markers = buildMarkers(overlapping, mode, 12);
      expect(markers[0].time).toBe(2);
      expect(markers.at(-1)?.time).toBe(10);
    }
  });
  it("maps each boundary to the same content anchor and follows through gaps", () => {
    const markers = buildMarkers(paragraphs, "sentence", 12);
    expect(markers.filter((m) => m.time === 4).map((m) => m.targetId)).toEqual([
      "s2",
    ]);
    expect(markerAtPosition(markers, 1)).toBeUndefined();
    expect(markerAtPosition(markers, 3)?.targetId).toBe("s1");
    expect(markerAtPosition(markers, 4)?.targetId).toBe("s2");
    expect(markerAtPosition(markers, 7)?.targetId).toBe("s2");
    expect(markerAtPosition(markers, 10)?.targetId).toBe("s3");
    expect(
      markerAtPosition(buildMarkers(paragraphs, "paragraph", 12), 7)?.targetId,
    ).toBe("p1");
  });
  it("makes every dense marker accessible without merging the whole track", () => {
    const markers = buildMarkers(paragraphs, "sentence", 12);
    const groups = groupMarkers(markers, 100, 12);
    expect(groups.flat()).toEqual(markers);
    expect(groups.length).toBeGreaterThan(1);
  });
});
