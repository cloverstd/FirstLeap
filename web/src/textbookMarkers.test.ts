import { describe, expect, it } from "vitest";
import {
  buildMarkers,
  groupMarkers,
  markerAtPosition,
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
  it("includes both edges and retains coincident sentence boundaries", () => {
    const markers = buildMarkers(paragraphs, "sentence", 12);
    expect(markers.map((m) => m.time)).toEqual([2, 4, 4, 6, 8, 10]);
    expect(markers.filter((m) => m.time === 4).map((m) => m.edge)).toEqual([
      "end",
      "start",
    ]);
  });
  it("derives paragraph edges from timed body sentences", () => {
    expect(
      buildMarkers(paragraphs, "paragraph", 12).map((m) => [m.id, m.time]),
    ).toEqual([
      ["p1-start", 2],
      ["p1-end", 6],
      ["p2-start", 8],
      ["p2-end", 10],
    ]);
  });
  it("maps each boundary to the same content anchor and follows through gaps", () => {
    const markers = buildMarkers(paragraphs, "sentence", 12);
    expect(markers.filter((m) => m.time === 4).map((m) => m.targetId)).toEqual([
      "s1",
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
