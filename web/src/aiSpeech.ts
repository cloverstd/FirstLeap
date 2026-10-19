import type { SpeechAudio } from "./ai";

export function readySpeechDuration(audio?: SpeechAudio | null): number {
  let duration = 0;
  for (const segment of audio?.segments || []) {
    if (
      !segment.url ||
      !Number.isFinite(segment.duration) ||
      segment.duration <= 0
    )
      break;
    duration += segment.duration;
  }
  return duration;
}

export function speechPosition(audio: SpeechAudio, seconds: number) {
  const target = Math.max(0, Math.min(seconds, readySpeechDuration(audio)));
  let start = 0;
  for (let index = 0; index < audio.segments.length; index++) {
    const segment = audio.segments[index];
    if (!segment.url) break;
    const nextReady = !!audio.segments[index + 1]?.url;
    if (target < start + segment.duration || !nextReady) {
      return {
        index,
        offset: Math.min(segment.duration, Math.max(0, target - start)),
        start,
      };
    }
    start += segment.duration;
  }
  return { index: 0, offset: 0, start: 0 };
}
