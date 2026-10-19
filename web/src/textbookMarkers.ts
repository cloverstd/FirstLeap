import type { MarkerMode } from "./textbookProgress";
export type TimedSentence = {
  id: string;
  text: string;
  start: number | null;
  end: number | null;
};
export type TimedParagraph = { id: string; sentences: TimedSentence[] };
export type AudioMarker = {
  id: string;
  time: number;
  targetId: string;
  edge: "start" | "end";
  index: number;
  text: string;
  mode: MarkerMode;
};
export function buildMarkers(
  paragraphs: TimedParagraph[],
  mode: MarkerMode,
  duration: number,
): AudioMarker[] {
  const valid = (s: TimedSentence) =>
    s.start !== null &&
    s.end !== null &&
    Number.isFinite(s.start) &&
    Number.isFinite(s.end) &&
    s.start >= 0 &&
    s.end > s.start &&
    s.end <= duration;
  const items =
    mode === "sentence"
      ? paragraphs.flatMap((p) => p.sentences).filter(valid)
      : paragraphs.flatMap((p) => {
          const sentences = p.sentences.filter(valid);
          return sentences.length
            ? [
                {
                  id: p.id,
                  text: sentences.map((s) => s.text).join(" "),
                  start: sentences[0].start,
                  end: sentences[sentences.length - 1].end,
                },
              ]
            : [];
        });
  return items
    .flatMap((item, index) => [
      {
        id: `${item.id}-start`,
        time: item.start!,
        targetId: item.id,
        edge: "start" as const,
        index: index + 1,
        text: item.text,
        mode,
      },
      {
        id: `${item.id}-end`,
        time: item.end!,
        targetId: item.id,
        edge: "end" as const,
        index: index + 1,
        text: item.text,
        mode,
      },
    ])
    .sort((a, b) => a.time - b.time);
}
export function groupMarkers(
  markers: AudioMarker[],
  width: number,
  duration: number,
): AudioMarker[][] {
  const groups: AudioMarker[][] = [];
  for (const marker of markers) {
    const last = groups[groups.length - 1];
    if (
      last &&
      ((marker.time - last[0].time) / Math.max(duration, 1)) * width < 20
    )
      last.push(marker);
    else groups.push([marker]);
  }
  return groups;
}
export const audioClock = (seconds: number) =>
  `${Math.floor(Math.max(0, seconds) / 60)}:${String(Math.floor(Math.max(0, seconds) % 60)).padStart(2, "0")}`;
export const markerLabel = (m: AudioMarker) =>
  `第 ${m.index} ${m.mode === "sentence" ? "句" : "段"}${m.edge === "start" ? "起点" : "终点"} · ${audioClock(m.time)}`;

// Keep the preceding anchor during pauses between sentences. At a shared
// boundary, the incoming sentence takes over; an explicit end-marker selection
// can still retain its own target while paused.
export function markerAtPosition(markers: AudioMarker[], position: number) {
  let current: AudioMarker | undefined;
  for (const marker of markers) {
    if (marker.time > position) break;
    if (!current || marker.time > current.time || marker.edge === "start")
      current = marker;
  }
  return current;
}
