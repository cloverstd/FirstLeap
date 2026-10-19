import { useSyncExternalStore } from "react";

export const TEXTBOOK_PROGRESS_KEY = "firstleap.textbook.progress.v1";
export const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];
export type MarkerMode = "sentence" | "paragraph";
export type ReadingPosition = {
  position: number;
  duration: number;
  rate: number;
  sentence: string;
  completed: boolean;
  markerMode: MarkerMode;
  lastVisitedAt: number;
};
export type TextbookProgress = {
  version: 1;
  lastLesson: string;
  lessons: Record<string, ReadingPosition>;
};
const empty = (): ReadingPosition => ({
  position: 0,
  duration: 0,
  rate: 1,
  sentence: "",
  completed: false,
  markerMode: "sentence",
  lastVisitedAt: 0,
});
const blank = (): TextbookProgress => ({
  version: 1,
  lastLesson: "",
  lessons: {},
});

export function parseTextbookProgress(raw: string | null): TextbookProgress {
  const result = blank();
  try {
    const data = JSON.parse(raw || "null");
    if (
      data?.version !== 1 ||
      !data.lessons ||
      typeof data.lessons !== "object" ||
      Array.isArray(data.lessons)
    )
      return result;
    result.lastLesson =
      typeof data.lastLesson === "string" ? data.lastLesson : "";
    for (const [key, entry] of Object.entries(data.lessons)) {
      const item = entry as Partial<ReadingPosition> | null;
      if (
        !item ||
        !Number.isFinite(item.position) ||
        !Number.isFinite(item.duration)
      )
        continue;
      const duration = Math.max(0, item.duration!);
      result.lessons[key] = {
        position: Math.max(0, Math.min(item.position!, duration)),
        duration,
        rate: RATES.includes(item.rate!) ? item.rate! : 1,
        sentence: typeof item.sentence === "string" ? item.sentence : "",
        completed: item.completed === true,
        markerMode: item.markerMode === "paragraph" ? "paragraph" : "sentence",
        lastVisitedAt: Number.isFinite(item.lastVisitedAt)
          ? Math.max(0, item.lastVisitedAt!)
          : 0,
      };
    }
  } catch {
    /* A damaged record must never prevent opening the classroom. */
  }
  return result;
}
export function parseReadingPosition(
  raw: string | null,
  key: string,
): ReadingPosition {
  return parseTextbookProgress(raw).lessons[key] || empty();
}
let cachedRaw: string | null | undefined;
let cached = blank();
const listeners = new Set<() => void>();
function snapshot() {
  let raw = null;
  try {
    raw = localStorage.getItem(TEXTBOOK_PROGRESS_KEY);
  } catch {
    /* Session-only progress remains available. */
  }
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cached = parseTextbookProgress(raw);
  }
  return cached;
}
function changed() {
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  const storage = (event: StorageEvent) => {
    if (event.key === TEXTBOOK_PROGRESS_KEY || event.key === null) changed();
  };
  window.addEventListener("storage", storage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", storage);
  };
}
export function useTextbookProgress() {
  return useSyncExternalStore(subscribe, snapshot, () => cached);
}
export function readPosition(key: string) {
  return snapshot().lessons[key] || empty();
}

// Every update merges into the latest record, rather than a player's old snapshot.
export function writePosition(
  key: string,
  patch: Partial<ReadingPosition>,
  markLast = false,
): boolean {
  const previous = snapshot();
  const data = {
    ...previous,
    lessons: {
      ...previous.lessons,
      [key]: { ...(previous.lessons[key] || empty()), ...patch },
    },
  };
  if (markLast) {
    data.lastLesson = key;
    data.lessons[key].lastVisitedAt = Date.now();
  }
  const raw = JSON.stringify(data);
  let success = true;
  try {
    localStorage.setItem(TEXTBOOK_PROGRESS_KEY, raw);
    cachedRaw = raw;
  } catch {
    success = false;
  }
  cached = data;
  changed();
  return success;
}
export function lastLessonInBook(progress: TextbookProgress, book: number) {
  const keys = Object.keys(progress.lessons).filter(
    (key) =>
      key.startsWith(`${book}:`) && progress.lessons[key].lastVisitedAt > 0,
  );
  keys.sort(
    (a, b) =>
      progress.lessons[b].lastVisitedAt - progress.lessons[a].lastVisitedAt,
  );
  return (
    keys[0] ||
    (progress.lastLesson.startsWith(`${book}:`) ? progress.lastLesson : "")
  );
}
