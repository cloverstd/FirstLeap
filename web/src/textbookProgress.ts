export const TEXTBOOK_PROGRESS_KEY = "firstleap.textbook.progress.v1";
export const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];
export type ReadingPosition = {
  position: number;
  duration: number;
  rate: number;
  sentence: string;
  completed: boolean;
};
const empty = (): ReadingPosition => ({
  position: 0,
  duration: 0,
  rate: 1,
  sentence: "",
  completed: false,
});
export function parseReadingPosition(
  raw: string | null,
  key: string,
): ReadingPosition {
  try {
    const data = JSON.parse(raw || "null");
    const item = data?.version === 1 ? data.lessons?.[key] : null;
    if (
      !item ||
      !Number.isFinite(item.position) ||
      !Number.isFinite(item.duration)
    )
      return empty();
    const duration = Math.max(0, item.duration);
    return {
      position: Math.max(0, Math.min(item.position, duration)),
      duration,
      rate: RATES.includes(item.rate) ? item.rate : 1,
      sentence: typeof item.sentence === "string" ? item.sentence : "",
      completed: item.completed === true,
    };
  } catch {
    return empty();
  }
}
export function readPosition(key: string) {
  try {
    return parseReadingPosition(
      localStorage.getItem(TEXTBOOK_PROGRESS_KEY),
      key,
    );
  } catch {
    return empty();
  }
}
export function writePosition(key: string, value: ReadingPosition): boolean {
  try {
    let data;
    try {
      data = JSON.parse(localStorage.getItem(TEXTBOOK_PROGRESS_KEY) || "null");
    } catch {
      /* Replace invalid storage. */
    }
    if (
      data?.version !== 1 ||
      !data.lessons ||
      Array.isArray(data.lessons) ||
      typeof data.lessons !== "object"
    )
      data = { version: 1, lessons: {} };
    data.lessons[key] = value;
    data.lastLesson = key;
    localStorage.setItem(TEXTBOOK_PROGRESS_KEY, JSON.stringify(data));
    return true;
  } catch {
    return false;
  }
}
