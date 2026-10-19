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
  index: number;
  text: string;
  mode: MarkerMode;
  boundary?: "start" | "end";
};
function validSentence(s: TimedSentence, duration: number) {
  return (
    s.start !== null &&
    s.end !== null &&
    Number.isFinite(s.start) &&
    Number.isFinite(s.end) &&
    s.start >= 0 &&
    s.end > s.start &&
    s.end <= duration
  );
}

export function lessonAudioRange(
  paragraphs: TimedParagraph[],
  duration: number,
) {
  const sentences = paragraphs
    .flatMap((p) => p.sentences)
    .filter((s) => validSentence(s, duration));
  if (!sentences.length) return null;
  return {
    start: Math.min(...sentences.map((s) => s.start!)),
    end: Math.max(...sentences.map((s) => s.end!)),
  };
}

export function buildMarkers(
  paragraphs: TimedParagraph[],
  mode: MarkerMode,
  duration: number,
): AudioMarker[] {
  const valid = (s: TimedSentence) => validSentence(s, duration);
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
                  start: Math.min(...sentences.map((s) => s.start!)),
                  end: Math.max(...sentences.map((s) => s.end!)),
                },
              ]
            : [];
        });
  const markers: AudioMarker[] = items
    .map((item, index) => ({
      id: `${item.id}-start`,
      time: item.start!,
      targetId: item.id,
      index: index + 1,
      text: item.text,
      mode,
    }))
    .sort((a, b) => a.time - b.time);
  if (!markers.length) return markers;
  markers[0].boundary = "start";
  const last = items.reduce((a, b) => (a.end! > b.end! ? a : b));
  markers.push({
    id: `${last.id}-end`,
    time: last.end!,
    targetId: last.id,
    index: markers.find((marker) => marker.targetId === last.id)!.index,
    text: last.text,
    mode,
    boundary: "end",
  });
  return markers;
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
  m.boundary === "end"
    ? `课文结束 · ${audioClock(m.time)}`
    : `第 ${m.index} ${m.mode === "sentence" ? "句" : "段"}起点 · ${audioClock(m.time)}${m.boundary === "start" ? " · 课文开始" : ""}`;

// Keep the preceding anchor until the next sentence or paragraph starts.
export function markerAtPosition(markers: AudioMarker[], position: number) {
  let current: AudioMarker | undefined;
  for (const marker of markers) {
    if (marker.time > position) break;
    current = marker;
  }
  return current;
}
