import { flushProgressSync } from "./progressSync";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import Artplayer from "artplayer";
import {
  ChevronDown,
  Gauge,
  ListVideo,
  Maximize,
  Minimize,
  MoreHorizontal,
  Pause,
  Play,
  RectangleHorizontal,
  RotateCcw,
  RotateCw,
  Volume2,
  VolumeX,
  WifiOff,
} from "lucide-react";
import { resumePosition, type LessonProgress } from "./progress";
import "./player.css";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { claimMedia, MEDIA_EVENT } from "./mediaCoordinator";

// FirstLeap owns resume, completion and retry policy.
Artplayer.LOG_VERSION = false;
Artplayer.CONTEXTMENU = false;
Artplayer.RECONNECT_TIME_MAX = 0;
Artplayer.DBCLICK_FULLSCREEN = false;
Artplayer.REMOVE_SRC_WHEN_DESTROY = true;

type Props = {
  source: string;
  poster?: string;
  title: string;
  progressID: string;
  progress?: LessonProgress;
  update: (
    id: string,
    patch: Partial<LessonProgress>,
    markLast?: boolean,
  ) => void;
  autoplay: boolean;
  onEnded: () => void;
  continuous: boolean;
  onContinuousChange: (enabled: boolean) => void;
};
const speeds = [0.75, 1, 1.25, 1.5, 1.75, 2];
function clock(value: number) {
  const s = Math.max(0, Math.floor(value || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function LearningPlayer(props: Props) {
  const shell = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const player = useRef<Artplayer | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const saved = useRef(props.progress);
  const ready = useRef(false);
  const interacted = useRef(false);
  const pausedEndSeek = useRef(false);
  const [controls, setControls] = useState<HTMLElement | null>(null);
  const [seekReady, setSeekReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [rate, setRate] = useState(1);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState(false);
  const [replayBlocked, setReplayBlocked] = useState(false);
  const [webFullscreen, setWebFullscreen] = useState(false);
  const [nativeFullscreen, setNativeFullscreen] = useState(false);
  const fullscreen = webFullscreen || nativeFullscreen;
  const [seekFeedback, setSeekFeedback] = useState<number | null>(null);
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (feedbackTimer.current !== null) clearTimeout(feedbackTimer.current);
    },
    [],
  );

  const persist = (immediate = false) => {
    const video = player.current?.video;
    if (!video || !ready.current || !Number.isFinite(video.duration)) return;
    const patch = { position: video.currentTime, duration: video.duration };
    saved.current = { ...saved.current, ...patch } as LessonProgress;
    latest.current.update(latest.current.progressID, patch, true);
    if (immediate) flushProgressSync();
  };

  const seekTo = (target: number) => {
    interacted.current = true;
    const art = player.current;
    if (!art || !ready.current) return;
    const video = art.video;
    const time = Math.max(0, Math.min(video.duration, target));
    pausedEndSeek.current = video.paused && time >= video.duration;
    video.currentTime = time;
    setPosition(time);
    art.emit("setBar", "played", time / video.duration);
    persist(true);
  };
  const seek = (offset: number) => {
    if (!ready.current) return;
    seekTo((player.current?.video.currentTime || 0) + offset);
    setSeekFeedback(offset);
    if (feedbackTimer.current !== null) clearTimeout(feedbackTimer.current);
    feedbackTimer.current = setTimeout(() => setSeekFeedback(null), 750);
  };
  const play = () => {
    const video = player.current?.video;
    if (!video) return;
    void video.play().catch(() => {
      if (video.isConnected) setReplayBlocked(true);
    });
  };
  const togglePlay = () => {
    const video = player.current?.video;
    if (video?.paused) play();
    else video?.pause();
  };

  useEffect(() => {
    const art = new Artplayer({
      container: host.current!,
      url: props.source,
      poster: props.poster || "",
      lang: "zh-cn",
      theme: "#9bcba7",
      autoplay: props.autoplay,
      autoPlayback: false,
      loop: false,
      hotkey: false,
      gesture: false,
      playsInline: true,
      moreVideoAttr: { preload: "metadata", controls: false },
    });
    player.current = art;
    const video = art.video;
    video.setAttribute("aria-label", props.title);
    art.template.$loading.setAttribute("role", "status");
    art.template.$loading.setAttribute("aria-label", "正在缓冲…");
    // React supplies semantic buttons; ArtPlayer supplies its timeline and media UI.
    for (const name of ["playAndPause", "volume", "time"])
      art.controls.remove(name);
    setControls(art.template.$controls);
    const timeline = art.template.$progress;
    timeline.tabIndex = 0;
    timeline.setAttribute("role", "slider");
    timeline.setAttribute("aria-label", "播放进度");
    timeline.setAttribute("aria-valuemin", "0");
    timeline.setAttribute("aria-disabled", "true");
    let lastSave = 0;
    const timelineValue = () => {
      timeline.setAttribute(
        "aria-valuenow",
        String(Math.floor(video.currentTime || 0)),
      );
      timeline.setAttribute("aria-valuemax", String(video.duration || 0));
      timeline.setAttribute(
        "aria-valuetext",
        `${clock(video.currentTime)} / ${clock(video.duration)}`,
      );
    };
    art.on("video:loadedmetadata", () => {
      ready.current = Number.isFinite(video.duration) && video.duration > 0;
      setSeekReady(ready.current);
      if (!ready.current) return;
      video.currentTime = resumePosition(saved.current, video.duration);
      setDuration(video.duration);
      setPosition(video.currentTime);
      timeline.setAttribute("aria-disabled", "false");
      timelineValue();
      art.template.$player.classList.remove("art-error");
      setError(false);
    });
    art.on("video:emptied", () => {
      ready.current = false;
      setSeekReady(false);
      timeline.setAttribute("aria-disabled", "true");
    });
    art.on("video:play", () => {
      interacted.current = true;
      claimMedia(video);
      pausedEndSeek.current = false;
      setPlaying(true);
      setReplayBlocked(false);
    });
    art.on("video:playing", () => setError(false));
    art.on("video:pause", () => {
      setPlaying(false);
      persist(true);
    });
    art.on("video:timeupdate", () => {
      setPosition(video.currentTime);
      timelineValue();
      if (Date.now() - lastSave >= 5000) {
        persist();
        lastSave = Date.now();
      }
    });
    art.on("video:seeking", () => {
      pausedEndSeek.current =
        video.paused && video.currentTime >= video.duration;
    });
    art.on("video:seeked", () => {
      setPosition(video.currentTime);
      timelineValue();
      persist(true);
    });
    art.on("video:ratechange", () => setRate(video.playbackRate));
    const volumeChanged = () => {
      setVolume(video.volume);
      setMuted(video.muted);
    };
    art.on("video:volumechange", volumeChanged);
    volumeChanged();
    art.on("video:error", () => {
      // Preserve the last valid snapshot before disabling further seeks/saves.
      persist(true);
      ready.current = false;
      setSeekReady(false);
      setError(true);
      setPlaying(false);
      timeline.setAttribute("aria-disabled", "true");
    });
    art.on("video:ended", () => {
      setPlaying(false);
      const current = latest.current;
      current.update(
        current.progressID,
        {
          completed: true,
          position: video.duration,
          duration: video.duration,
        },
        true,
      );
      if (pausedEndSeek.current) return;
      current.onEnded();
    });
    const visibility = () => {
      if (document.visibilityState === "hidden") persist(true);
    };
    const pageHide = () => persist(true);
    window.addEventListener("pagehide", pageHide);
    document.addEventListener("visibilitychange", visibility);
    const otherMedia = (event: Event) => {
      if ((event as CustomEvent).detail !== video) video.pause();
    };
    window.addEventListener(MEDIA_EVENT, otherMedia);
    return () => {
      persist(true);
      video.pause();
      window.removeEventListener("pagehide", pageHide);
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener(MEDIA_EVENT, otherMedia);
      art.destroy();
      player.current = null;
    };
    // Each resource is keyed by its lesson and mode; state changes never recreate it.
  }, [props.source, props.progressID]);

  useEffect(() => {
    const restore = (event: Event) => {
      if (interacted.current) return;
      const tracks = (
        event as CustomEvent<Record<string, Record<string, LessonProgress>>>
      ).detail;
      const record = tracks.lecture?.[props.progressID];
      if (!record || typeof record.position !== "number") return;
      saved.current = record;
      const video = player.current?.video;
      if (video && ready.current && video.paused) {
        const target = resumePosition(record, video.duration);
        if (Math.abs(video.currentTime - target) > 0.05) {
          video.currentTime = target;
          setPosition(target);
        }
      }
    };
    window.addEventListener("remote-progress-applied", restore);
    return () => window.removeEventListener("remote-progress-applied", restore);
  }, [props.progressID]);
  useEffect(() => {
    const changed = () =>
      setNativeFullscreen(document.fullscreenElement === shell.current);
    document.addEventListener("fullscreenchange", changed);
    return () => document.removeEventListener("fullscreenchange", changed);
  }, []);
  useEffect(() => {
    if (!webFullscreen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const escape = (event: globalThis.KeyboardEvent) => {
      const target = event.target;
      if (
        event.key === "Escape" &&
        !event.defaultPrevented &&
        !(
          target instanceof Element &&
          target.closest('[role="menu"], [role="dialog"], [role="listbox"]')
        )
      )
        setWebFullscreen(false);
    };
    document.addEventListener("keydown", escape);
    return () => {
      document.body.style.overflow = previous;
      document.removeEventListener("keydown", escape);
    };
  }, [webFullscreen]);
  const toggleFullscreen = async () => {
    if (document.fullscreenElement === shell.current) {
      await document.exitFullscreen();
    } else {
      try {
        if (!shell.current?.requestFullscreen)
          throw new Error("Use webpage fullscreen");
        await shell.current.requestFullscreen();
      } catch {
        setWebFullscreen(true);
      }
    }
  };
  const toggleWebFullscreen = async () => {
    if (document.fullscreenElement === shell.current) {
      await document.exitFullscreen();
    }
    setWebFullscreen((value) => !value);
  };
  const keyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (
      target.closest(
        'input, textarea, select, [contenteditable="true"], [role="menu"]',
      )
    )
      return;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      seek(event.key === "ArrowLeft" ? -5 : 5);
    } else if (event.key === " " && !target.closest("button")) {
      event.preventDefault();
      togglePlay();
    } else if (
      target.getAttribute("role") === "slider" &&
      ["Home", "End"].includes(event.key)
    ) {
      event.preventDefault();
      seekTo(event.key === "Home" ? 0 : duration);
    }
  };
  const extraOffsets = [10, 15, 30];
  const darkButton =
    "min-h-11 gap-1.5 text-white/80 hover:bg-white/10 hover:text-white";
  return (
    <div
      ref={shell}
      className={cn(
        "learning-player relative min-w-0 overflow-visible rounded-2xl border border-primary/20 bg-[#15271f] text-white shadow-sm isolate",
        "is-lecture",
        fullscreen &&
          "is-fullscreen flex h-full w-full flex-col rounded-none border-0",
        webFullscreen && "web-fullscreen fixed inset-0 z-[10000] h-dvh",
      )}
      role="region"
      aria-label="课程播放器"
      tabIndex={0}
      onKeyDown={keyboard}
      onFocusCapture={() => {
        if (player.current) player.current.controls.show = true;
      }}
    >
      <div
        className={cn(
          "player-stage relative w-full overflow-hidden bg-[#101a14]",
          replayBlocked ? "rounded-t-2xl" : "rounded-2xl",
          "aspect-video",
          error && "min-h-80",
          fullscreen && "min-h-0 flex-1 rounded-none aspect-auto",
        )}
      >
        <div ref={host} className="art-host absolute inset-0" />
        {seekFeedback !== null && (
          <div
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute top-1/2 z-30 flex -translate-y-1/2 flex-col items-center gap-1 rounded-2xl bg-black/50 px-5 py-3 text-white backdrop-blur-sm motion-safe:animate-in motion-safe:fade-in-0",
              seekFeedback < 0 ? "left-[12%]" : "right-[12%]",
            )}
          >
            {seekFeedback < 0 ? (
              <RotateCcw className="size-6" />
            ) : (
              <RotateCw className="size-6" />
            )}
            <span className="text-sm tabular-nums">
              {seekFeedback > 0 ? "+" : "−"}
              {Math.abs(seekFeedback)} 秒
            </span>
          </div>
        )}
        {error && (
          <div
            className="player-error pointer-events-none absolute inset-0 z-40 flex flex-col items-center justify-center gap-3 bg-[#1b2c23] p-5 text-center"
            role="alert"
          >
            <WifiOff className="size-7 text-white/60" />
            <strong className="font-medium">视频暂时无法播放</strong>
            <p className="text-xs text-white/65">
              学习进度已保留，请检查连接后重试。
            </p>
            <Button
              variant="outline"
              className="pointer-events-auto border-white/25 bg-white/5 text-white hover:bg-white/15 hover:text-white"
              onClick={() => {
                setError(false);
                player.current?.video.load();
              }}
            >
              <RotateCcw className="mr-1 size-4" />
              重新加载
            </Button>
          </div>
        )}
      </div>
      {controls &&
        createPortal(
          <div className="media-controls flex w-full items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className={cn(
                darkButton,
                "media-play media-icon size-11 shrink-0",
              )}
              aria-label={playing ? "暂停" : "播放"}
              onClick={togglePlay}
              disabled={error}
            >
              {playing ? (
                <Pause className="size-5 fill-current" />
              ) : (
                <Play className="size-5 fill-current" />
              )}
            </Button>
            <span className="media-time mr-auto whitespace-nowrap text-xs tabular-nums">
              {clock(position)}
              <span className="text-white/60"> / {clock(duration)}</span>
            </span>
            <div
              className="seek-tools flex shrink-0 items-center"
              role="group"
              aria-label="快捷跳转"
            >
              <Button
                variant="ghost"
                size="icon"
                className={cn(
                  darkButton,
                  "media-icon relative size-11 shrink-0 active:scale-95",
                )}
                aria-label="快退 5 秒"
                title="快退 5 秒"
                disabled={!seekReady}
                onClick={() => seek(-5)}
              >
                <RotateCcw className="size-6" />
                <span className="absolute top-[15px] text-[9px] font-semibold">
                  5
                </span>
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className={cn(
                  darkButton,
                  "media-icon relative size-11 shrink-0 active:scale-95",
                )}
                aria-label="快进 5 秒"
                title="快进 5 秒"
                disabled={!seekReady}
                onClick={() => seek(5)}
              >
                <RotateCw className="size-6" />
                <span className="absolute top-[15px] text-[9px] font-semibold">
                  5
                </span>
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className={cn(darkButton, "media-icon size-11 shrink-0")}
                    aria-label="更多跳转"
                    title="更多跳转"
                    disabled={!seekReady}
                  >
                    <MoreHorizontal className="size-5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  container={shell.current}
                  onEscapeKeyDown={(event) => event.stopPropagation()}
                  side="top"
                  align="start"
                  className="z-[10020] w-72 max-w-[calc(100vw-2rem)]"
                  aria-label="更多跳转"
                >
                  <div className="grid grid-cols-2 gap-1">
                    <DropdownMenuGroup>
                      <DropdownMenuLabel>快退</DropdownMenuLabel>
                      {extraOffsets.map((offset) => (
                        <DropdownMenuItem
                          key={-offset}
                          aria-label={`快退 ${offset} 秒`}
                          className="min-h-11"
                          onSelect={() => seek(-offset)}
                        >
                          <RotateCcw className="size-4" />
                          快退 {offset} 秒
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuGroup>
                    <DropdownMenuGroup>
                      <DropdownMenuLabel>快进</DropdownMenuLabel>
                      {extraOffsets.map((offset) => (
                        <DropdownMenuItem
                          key={offset}
                          aria-label={`快进 ${offset} 秒`}
                          className="min-h-11"
                          onSelect={() => seek(offset)}
                        >
                          <RotateCw className="size-4" />
                          快进 {offset} 秒
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuGroup>
                  </div>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <div className="media-toggles flex shrink-0 items-center">
              <Button
                variant="ghost"
                size="sm"
                className={cn(
                  darkButton,
                  "media-toggle min-w-11 shrink-0 px-2 text-xs",
                  props.continuous && "bg-white/10 text-[#bce6c5]",
                )}
                role="switch"
                aria-label="连续播放"
                title="连续播放"
                aria-checked={props.continuous}
                onClick={() => props.onContinuousChange(!props.continuous)}
              >
                <ListVideo className="size-4" />
                <span className="media-toggle-label">连续播放</span>
              </Button>
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  className={cn(
                    darkButton,
                    "media-speed shrink-0 gap-1 px-2 text-xs",
                  )}
                  aria-label="播放速度"
                  title="播放速度"
                >
                  <Gauge className="size-4" />
                  {rate}×<ChevronDown className="size-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                container={shell.current}
                onEscapeKeyDown={(event) => event.stopPropagation()}
                side="top"
                align="end"
                className="z-[10020]"
                aria-label="播放速度"
              >
                <DropdownMenuRadioGroup
                  value={String(rate)}
                  onValueChange={(value) => {
                    const speed = Number(value);
                    if (player.current)
                      player.current.video.playbackRate = speed;
                    setRate(speed);
                  }}
                >
                  {speeds.map((speed) => (
                    <DropdownMenuRadioItem
                      className="min-h-11"
                      key={speed}
                      value={String(speed)}
                    >
                      {speed}×
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <div className="media-volume flex items-center">
              <Button
                variant="ghost"
                size="icon"
                className={cn(darkButton, "media-icon size-11")}
                aria-label={muted ? "取消静音" : "静音"}
                onClick={() => {
                  if (player.current)
                    player.current.video.muted = !player.current.video.muted;
                }}
              >
                {muted || volume === 0 ? (
                  <VolumeX className="size-5" />
                ) : (
                  <Volume2 className="size-5" />
                )}
              </Button>
              <input
                className="media-volume-slider h-11 w-16 cursor-pointer accent-[#a2d5ad]"
                type="range"
                aria-label="音量"
                min="0"
                max="1"
                step="0.05"
                value={muted ? 0 : volume}
                onChange={(e) => {
                  if (player.current) {
                    player.current.video.muted = false;
                    player.current.video.volume = Number(e.target.value);
                  }
                }}
              />
            </div>
            <Button
              variant="ghost"
              size="icon"
              className={cn(
                darkButton,
                "media-web-fullscreen media-icon size-11 shrink-0",
              )}
              aria-label={webFullscreen ? "退出网页全屏" : "网页全屏"}
              title={webFullscreen ? "退出网页全屏（Esc）" : "网页全屏"}
              aria-pressed={webFullscreen}
              onClick={() => void toggleWebFullscreen()}
            >
              <RectangleHorizontal className="size-5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className={cn(
                darkButton,
                "media-fullscreen media-icon size-11 shrink-0",
              )}
              aria-label={nativeFullscreen ? "退出全屏" : "全屏"}
              title={nativeFullscreen ? "退出全屏" : "全屏"}
              onClick={() => void toggleFullscreen()}
            >
              {nativeFullscreen ? (
                <Minimize className="size-5" />
              ) : (
                <Maximize className="size-5" />
              )}
            </Button>
          </div>,
          controls,
        )}
      {replayBlocked && (
        <div
          className="player-notice flex flex-wrap items-center justify-between gap-2 rounded-b-2xl border-t border-white/10 bg-[#20382b] px-3 py-2 text-xs text-[#bce6c5]"
          role="status"
        >
          <span>点击播放即可继续观看。</span>
          <Button
            variant="ghost"
            size="sm"
            className={darkButton}
            onClick={play}
          >
            <Play className="mr-1 size-3.5" />
            播放
          </Button>
        </div>
      )}
    </div>
  );
}
