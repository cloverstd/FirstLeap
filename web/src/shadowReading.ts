import { useEffect, useRef, useState } from "react";
import {
  buildMarkers,
  lessonAudioRange,
  type AudioMarker,
  type TimedParagraph,
} from "./textbookMarkers";
import type { MarkerMode } from "./textbookProgress";

export const SHADOW_READING_KEY = "firstleap.shadow-reading.v1";
export type ShadowSettings = { enabled: boolean; mode: MarkerMode };
export type ShadowSegment = { start: number; end: number; marker: AudioMarker };

export function parseShadowSettings(raw: string | null): ShadowSettings {
  try {
    const value = JSON.parse(raw || "null");
    return {
      enabled: value?.enabled === true,
      mode: value?.mode === "paragraph" ? "paragraph" : "sentence",
    };
  } catch {
    return { enabled: false, mode: "sentence" };
  }
}

export function shadowSegments(
  paragraphs: TimedParagraph[],
  mode: MarkerMode,
  duration: number,
): ShadowSegment[] {
  const ends = new Map(
    mode === "sentence"
      ? paragraphs.flatMap((p) => p.sentences.map((s) => [s.id, s.end] as const))
      : paragraphs.map(
          (p) => [p.id, lessonAudioRange([p], duration)?.end] as const,
        ),
  );
  const segments: ShadowSegment[] = [];
  for (const marker of buildMarkers(paragraphs, mode, duration)) {
    if (marker.boundary === "end") continue;
    const end = ends.get(marker.targetId)!;
    const previous = segments.at(-1);
    // Equal starts share a turn; include all speech at that boundary.
    if (previous?.start === marker.time)
      previous.end = Math.max(previous.end, end);
    else segments.push({ start: marker.time, end, marker });
  }
  return segments.map((segment, index) => ({
    ...segment,
    // Stop at this turn's own end, before the next turn can become audible.
    end: Math.min(segment.end, segments[index + 1]?.start ?? duration),
  }));
}

export function shadowDelay(duration: number, rate: number) {
  return Number.isFinite(duration) &&
    duration > 0 &&
    Number.isFinite(rate) &&
    rate > 0
    ? (duration / rate) * 1000
    : 0;
}

type ShadowWait = {
  until: number;
  marker?: AudioMarker;
  position: number;
  resume: () => void;
};

export function useShadowReading() {
  const [settings, setSettings] = useState<ShadowSettings>(() => {
    try {
      return parseShadowSettings(localStorage.getItem(SHADOW_READING_KEY));
    } catch {
      return parseShadowSettings(null);
    }
  });
  const settingsRef = useRef(settings);
  const waiting = useRef<ShadowWait | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [turn, setTurn] = useState<ShadowWait | null>(null);
  const [remaining, setRemaining] = useState(0);
  const cancel = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    waiting.current = null;
    setTurn(null);
  };
  const finish = () => {
    const pending = waiting.current;
    cancel();
    pending?.resume();
  };
  const wait = (
    delay: number,
    resume: () => void,
    position: number,
    marker?: AudioMarker,
  ) => {
    cancel();
    const pending = {
      until: performance.now() + delay,
      resume,
      position,
      marker,
    };
    waiting.current = pending;
    setTurn(pending);
    setRemaining(Math.ceil(delay / 1000));
    timer.current = setTimeout(() => {
      if (waiting.current === pending) finish();
    }, delay);
  };
  const configure = (next: ShadowSettings) => {
    settingsRef.current = next;
    setSettings(next);
    try {
      localStorage.setItem(SHADOW_READING_KEY, JSON.stringify(next));
    } catch {
      // Playback and the current session's preference still work without storage.
    }
  };
  useEffect(() => {
    if (!turn) return;
    const ticker = setInterval(() => {
      setRemaining(
        Math.max(0, Math.ceil((turn.until - performance.now()) / 1000)),
      );
    }, 100);
    return () => clearInterval(ticker);
  }, [turn]);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
      waiting.current = null;
    },
    [],
  );
  return {
    settings,
    settingsRef,
    configure,
    waiting,
    turn,
    remaining,
    wait,
    cancel,
    finish,
  };
}
