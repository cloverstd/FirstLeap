import { useEffect, useRef, useState } from "react";
import { Headphones, Pause, Play, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  api,
  watchJob,
  type Explanation,
  type SpeechAudio,
  type SpeechView,
} from "./ai";
import { readySpeechDuration, speechPosition } from "./aiSpeech";
import { claimMedia, MEDIA_EVENT } from "./mediaCoordinator";

const RATE_KEY = "firstleap.ai-speech.rate.v1";
const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];
function savedRate() {
  try {
    const value = Number(localStorage.getItem(RATE_KEY));
    return RATES.includes(value) ? value : 1;
  } catch {
    return 1;
  }
}
function clock(value: number) {
  const seconds = Math.max(0, Math.floor(value));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
function inProgress(audio?: SpeechAudio) {
  return (
    !!audio &&
    ["queued", "preparing", "generating", "interrupted"].includes(audio.status)
  );
}

export default function AISpeechPlayer({
  explanation,
}: {
  explanation: Explanation;
}) {
  const [view, setView] = useState<SpeechView | null>(null);
  const [selected, setSelected] = useState<SpeechAudio | null>(null);
  const [error, setError] = useState("");
  const [requesting, setRequesting] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [position, setPosition] = useState(0);
  const [rate, setRate] = useState(savedRate);
  const media = useRef<HTMLAudioElement | null>(null);
  const wanted = useRef(false);
  const index = useRef(0);
  const seekOffset = useRef(0);
  const generation = useRef(0);
  const alive = useRef(true);
  const audioRef = useRef(selected);
  audioRef.current = selected;
  const path = `/api/ai/explanations/${explanation.id}/speech`;
  const lookup = `${path}?version=${encodeURIComponent(explanation.contentVersion)}`;
  const body = (regenerate = false, retry = false) =>
    JSON.stringify({
      contentVersion: explanation.contentVersion,
      regenerate,
      retry,
    });

  useEffect(() => {
    const abort = new AbortController();
    const element = media.current;
    alive.current = true;
    void (async () => {
      let data = await api<SpeechView>(lookup, { signal: abort.signal });
      if (!abort.signal.aborted) setView(data);
      if (data.enabled) {
        data = await api<SpeechView>(path, {
          method: "POST",
          signal: abort.signal,
          body: body(),
        });
        if (!abort.signal.aborted) setView(data);
      }
    })().catch((e) => {
      if (!abort.signal.aborted) setError((e as Error).message);
    });
    return () => {
      alive.current = false;
      abort.abort();
      wanted.current = false;
      generation.current++;
      if (element) {
        element.pause();
        element.removeAttribute("src");
        element.load();
      }
    };
  }, [explanation.id, explanation.contentVersion]);

  const jobID = view?.jobId || "";
  useEffect(() => {
    if (!jobID) return;
    return watchJob(
      jobID,
      (state) => {
        const next =
          state.speech ||
          (state.status === "done" ? (state.result as SpeechView) : null);
        if (next) setView(next);
        if (state.status !== "running") {
          void api<SpeechView>(lookup)
            .then((data) => {
              if (alive.current) setView(data);
            })
            .catch(() => {});
        }
      },
      () => {
        /* Polling restores status after an SSE interruption or server restart. */
      },
    );
  }, [jobID, lookup]);

  const pending = view?.pending || view?.audio;
  const active = !!jobID || (!!view?.enabled && inProgress(pending));
  useEffect(() => {
    if (!active) return;
    const abort = new AbortController();
    let fetching = false;
    const timer = window.setInterval(() => {
      if (fetching) return;
      fetching = true;
      void (async () => {
        let data = await api<SpeechView>(lookup, { signal: abort.signal });
        const next = data.pending || data.audio;
        if (data.enabled && !data.jobId && next?.status === "interrupted") {
          data = await api<SpeechView>(path, {
            method: "POST",
            signal: abort.signal,
            body: body(),
          });
        }
        if (!abort.signal.aborted) {
          setView(data);
          setError("");
        }
      })()
        .catch((e) => {
          if (!abort.signal.aborted) setError((e as Error).message);
        })
        .finally(() => {
          fetching = false;
        });
    }, 1500);
    return () => {
      abort.abort();
      window.clearInterval(timer);
    };
  }, [active, lookup]);

  // Pin a playing generation. A newly completed replacement is selected once
  // the listener pauses or finishes, so its arrival never interrupts playback.
  useEffect(() => {
    const next = view?.audio;
    if (!next) return;
    if (!selected || next.id === selected.id) setSelected(next);
    else if (!wanted.current) {
      generation.current++;
      media.current?.pause();
      media.current?.removeAttribute("src");
      index.current = 0;
      setPosition(0);
      setWaiting(false);
      setSelected(next);
    }
  }, [view?.audio, playing]);

  const stop = () => {
    wanted.current = false;
    media.current?.pause();
    setPlaying(false);
    setWaiting(false);
  };
  useEffect(() => {
    const other = (event: Event) => {
      if ((event as CustomEvent).detail !== media.current) stop();
    };
    window.addEventListener(MEDIA_EVENT, other);
    return () => window.removeEventListener(MEDIA_EVENT, other);
  }, []);

  const playMedia = () => {
    const element = media.current;
    if (!element) return;
    const token = generation.current;
    element.playbackRate = rate;
    claimMedia(element);
    void element.play().catch(() => {
      if (alive.current && token === generation.current && wanted.current) {
        stop();
        setError("播放未能开始，请再点击一次播放。");
      }
    });
  };
  const loadSegment = (next: number, offset: number, autoplay: boolean) => {
    const audio = audioRef.current,
      element = media.current;
    if (!audio || !element || !audio.segments[next]?.url) return;
    generation.current++;
    index.current = next;
    seekOffset.current = offset;
    element.src = audio.segments[next].url!;
    element.load();
    setPosition(
      audio.segments
        .slice(0, next)
        .reduce((sum, segment) => sum + segment.duration, 0) + offset,
    );
    setWaiting(false);
    if (autoplay) playMedia();
  };
  useEffect(() => {
    if (waiting && wanted.current && selected?.segments[index.current]?.url)
      loadSegment(index.current, 0, true);
    else if (
      waiting &&
      selected &&
      (selected.status === "ready" ||
        selected.status === "error" ||
        view?.audio?.id !== selected.id ||
        !!view?.pending)
    )
      stop();
  }, [selected, waiting, view?.audio?.id, view?.pending?.id]);

  const toggle = () => {
    if (wanted.current) {
      stop();
      return;
    }
    if (!selected) return;
    setError("");
    wanted.current = true;
    setPlaying(true);
    const element = media.current;
    if (element?.getAttribute("src") && !element.ended) playMedia();
    else {
      const location = speechPosition(
        selected,
        position >= readySpeechDuration(selected) && selected.status === "ready"
          ? 0
          : position,
      );
      loadSegment(location.index, location.offset, true);
    }
  };
  const ended = () => {
    const audio = audioRef.current;
    if (!audio || !wanted.current) return;
    const next = index.current + 1;
    setPosition(
      audio.segments
        .slice(0, next)
        .reduce((sum, part) => sum + part.duration, 0),
    );
    if (audio.segments[next]?.url) loadSegment(next, 0, true);
    else if (
      next < audio.segments.length &&
      inProgress(audio) &&
      view?.audio?.id === audio.id &&
      !view?.pending
    ) {
      index.current = next;
      setWaiting(true);
    } else stop();
  };
  const generate = async (regenerate: boolean) => {
    setRequesting(true);
    setError("");
    try {
      const data = await api<SpeechView>(path, {
        method: "POST",
        body: body(regenerate, !regenerate),
      });
      if (alive.current) setView(data);
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      if (alive.current) setRequesting(false);
    }
  };

  if (view && !view.enabled && !view.audio && !error) return null;
  const duration = readySpeechDuration(selected);
  const complete = selected?.status === "ready";
  const completed =
    pending?.segments.filter((segment) => !!segment.url).length || 0;
  const status =
    pending?.status === "queued"
      ? "语音正在排队…"
      : pending?.status === "preparing"
        ? "正在准备老师的讲课稿…"
        : pending?.status === "interrupted"
          ? view?.enabled
            ? "正在恢复语音生成…"
            : "语音尚未生成完成，启用语音合成后可继续。"
          : inProgress(pending)
            ? `正在生成语音：${completed}/${pending?.segments.length || 0} 段，已生成的部分可先听。`
            : pending?.status === "ready"
              ? "语音已保存，随时可以收听。"
              : "";
  return (
    <section className="ai-speech" aria-label="AI 语音讲解">
      <div className="ai-speech-heading">
        <Headphones size={17} />
        <strong>听老师讲解</strong>
      </div>
      <p className="ai-subtle" role="status">
        {waiting
          ? "正在等待下一段语音…"
          : status || (!view ? "正在查找讲解语音…" : "")}
      </p>
      <div className="ai-speech-controls">
        <Button
          type="button"
          size="sm"
          disabled={!duration}
          onClick={toggle}
          aria-label={playing ? "暂停 AI 讲解" : "播放 AI 讲解"}
        >
          {playing ? <Pause size={15} /> : <Play size={15} />}
          {playing ? "暂停" : "播放"}
        </Button>
        <label className="ai-speech-rate">
          播放倍速
          <select
            aria-label="AI 讲解播放倍速"
            value={rate}
            onChange={(e) => {
              const next = Number(e.target.value);
              setRate(next);
              if (media.current) media.current.playbackRate = next;
              try {
                localStorage.setItem(RATE_KEY, String(next));
              } catch {
                /* Playback works without browser storage. */
              }
            }}
          >
            {RATES.map((value) => (
              <option key={value} value={value}>
                {value}×
              </option>
            ))}
          </select>
        </label>
      </div>
      <input
        className="ai-speech-timeline"
        type="range"
        aria-label="AI 讲解播放进度"
        min={0}
        max={duration || 1}
        step={0.1}
        value={Math.min(position, duration)}
        disabled={!duration}
        onChange={(e) => {
          if (!selected) return;
          const location = speechPosition(selected, Number(e.target.value));
          loadSegment(location.index, location.offset, wanted.current);
        }}
      />
      <p className="ai-subtle">
        {clock(position)} / {clock(duration)}
        {!complete && duration > 0 ? "（已生成部分）" : ""}
      </p>
      <audio
        ref={media}
        aria-label="AI 讲解音频"
        preload="metadata"
        onLoadedMetadata={() => {
          if (media.current) {
            media.current.currentTime = seekOffset.current;
            media.current.playbackRate = rate;
          }
        }}
        onTimeUpdate={() => {
          const audio = audioRef.current;
          if (audio && media.current && !waiting)
            setPosition(
              audio.segments
                .slice(0, index.current)
                .reduce((sum, segment) => sum + segment.duration, 0) +
                media.current.currentTime,
            );
        }}
        onEnded={ended}
        onError={() => {
          if (media.current?.getAttribute("src")) {
            stop();
            setError("音频加载失败，请重试播放；文件缺失时可重新生成语音。");
          }
        }}
      />
      {(error || pending?.error) && (
        <p className="ai-warning" role="alert">
          {error || pending?.error}
        </p>
      )}
      <div className="ai-speech-actions">
        {view?.enabled &&
          !active &&
          (pending?.status === "error" || !view.audio || error) && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={requesting}
              onClick={() => void generate(false)}
            >
              重试语音
            </Button>
          )}
        {view?.enabled && !!view.audio && !active && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={requesting}
            onClick={() => void generate(true)}
          >
            <RotateCcw size={13} />
            重新生成语音
          </Button>
        )}
        {(error || pending?.error) && <a href="/settings">检查系统配置</a>}
      </div>
      {selected?.script && (
        <details className="ai-speech-script">
          <summary>查看讲课稿</summary>
          <p>{selected.script}</p>
        </details>
      )}
    </section>
  );
}
