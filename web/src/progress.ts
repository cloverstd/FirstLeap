import { queueProgressPatch } from "./progressSync";
export type LessonProgress = {
  position: number;
  duration: number;
  completed: boolean;
  updatedAt: number;
};
export type Progress = {
  version: 1;
  lastLesson: string;
  lessons: Record<string, LessonProgress>;
};
export const STORAGE_KEY = "firstleap.progress.v1";
export const emptyProgress = (): Progress => ({
  version: 1,
  lastLesson: "",
  lessons: {},
});

export function parseProgress(raw: string | null): Progress {
  try {
    const value = JSON.parse(raw || "null");
    if (
      !value ||
      value.version !== 1 ||
      !value.lessons ||
      typeof value.lessons !== "object"
    )
      return emptyProgress();
    const result = emptyProgress();
    result.lastLesson =
      typeof value.lastLesson === "string" ? value.lastLesson : "";
    for (const [id, entry] of Object.entries(value.lessons)) {
      const e = entry as Partial<LessonProgress> | null;
      if (!e || typeof e.position !== "number" || !Number.isFinite(e.position))
        continue;
      const duration =
        typeof e.duration === "number" && Number.isFinite(e.duration)
          ? Math.max(0, e.duration)
          : 0;
      result.lessons[id] = {
        position: Math.max(
          0,
          duration ? Math.min(e.position, duration) : e.position,
        ),
        duration,
        completed: e.completed === true,
        updatedAt: typeof e.updatedAt === "number" ? e.updatedAt : 0,
      };
    }
    return result;
  } catch {
    return emptyProgress();
  }
}

export function resumePosition(
  progress: LessonProgress | undefined,
  duration: number,
): number {
  if (!progress || !Number.isFinite(duration) || duration <= 0) return 0;
  return progress.position >= duration - 3
    ? 0
    : Math.max(0, Math.min(progress.position, duration));
}

export const READING_STORAGE_KEY = "firstleap.reading.progress.v1";
export function loadProgress(key = STORAGE_KEY): Progress {
  try {
    return parseProgress(localStorage.getItem(key));
  } catch {
    return emptyProgress();
  }
}

export function saveProgress(progress: Progress, key = STORAGE_KEY): boolean {
  try {
    const previous = parseProgress(localStorage.getItem(key));
    localStorage.setItem(key, JSON.stringify(progress));
    const track = key === READING_STORAGE_KEY ? "reading" : "lecture";
    for (const [id, record] of Object.entries(progress.lessons)) {
      const old = previous.lessons[id];
      const changed = Object.fromEntries(
        Object.entries(record).filter(
          ([field, value]) =>
            field !== "updatedAt" &&
            value !== old?.[field as keyof LessonProgress],
        ),
      );
      queueProgressPatch(track, id, changed);
    }
    if (progress.lastLesson !== previous.lastLesson)
      queueProgressPatch(track, "@last", { lastLesson: progress.lastLesson });
    return true;
  } catch {
    return false;
  }
}
