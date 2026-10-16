import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import Artplayer from "artplayer";
import {
  Check, ChevronDown, Gauge, ListVideo, Maximize, Minimize, Pause, Play,
  Repeat1, RotateCcw, RotateCw, Volume2, VolumeX, WifiOff,
} from "lucide-react";
import { resumePosition, type LessonProgress } from "./progress";
import "./player.css";

// FirstLeap owns resume, completion and retry policy for both media types.
Artplayer.LOG_VERSION = false;
Artplayer.CONTEXTMENU = false;
Artplayer.RECONNECT_TIME_MAX = 0;
Artplayer.DBCLICK_FULLSCREEN = false;
Artplayer.REMOVE_SRC_WHEN_DESTROY = true;

type Props = {
  source: string;
  poster?: string;
  title: string;
  reading: boolean;
  progressID: string;
  progress?: LessonProgress;
  update: (id: string, patch: Partial<LessonProgress>, markLast?: boolean) => void;
  autoplay: boolean;
  onEnded: () => void;
  loopReading: boolean;
  onLoopChange: (enabled: boolean) => void;
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
  const [speedOpen, setSpeedOpen] = useState(false);
  const speedPanel = useRef<HTMLDivElement>(null);
  const speedTrigger = useRef<HTMLButtonElement>(null);

  const persist = () => {
    const video = player.current?.video;
    if (!video || !ready.current || !Number.isFinite(video.duration)) return;
    const patch = { position: video.currentTime, duration: video.duration };
    saved.current = { ...saved.current, ...patch } as LessonProgress;
    latest.current.update(latest.current.progressID, patch, true);
  };

  const seekTo = (target: number) => {
    const art = player.current;
    if (!art || !ready.current) return;
    const video = art.video;
    const time = Math.max(0, Math.min(video.duration, target));
    pausedEndSeek.current = video.paused && time >= video.duration;
    video.currentTime = time;
    setPosition(time);
    art.emit("setBar", "played", time / video.duration);
    persist();
  };
  const seek = (offset: number) => seekTo((player.current?.video.currentTime || 0) + offset);
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
      container: host.current!, url: props.source, poster: props.poster || "",
      lang: "zh-cn", theme: "#9bcba7", autoplay: props.autoplay,
      autoPlayback: false, loop: false, hotkey: false, gesture: false,
      playsInline: true, moreVideoAttr: { preload: "metadata", controls: false },
    });
    player.current = art;
    const video = art.video;
    video.setAttribute("aria-label", props.title);
    art.template.$loading.setAttribute("role", "status");
    art.template.$loading.setAttribute("aria-label", "正在缓冲…");
    // React supplies semantic buttons; ArtPlayer supplies its timeline and media UI.
    for (const name of ["playAndPause", "volume", "time"]) art.controls.remove(name);
    setControls(art.template.$controls);
    const timeline = art.template.$progress;
    timeline.tabIndex = 0;
    timeline.setAttribute("role", "slider");
    timeline.setAttribute("aria-label", "播放进度");
    timeline.setAttribute("aria-valuemin", "0");
    timeline.setAttribute("aria-disabled", "true");
    let lastSave = 0;
    const timelineValue = () => {
      timeline.setAttribute("aria-valuenow", String(Math.floor(video.currentTime || 0)));
      timeline.setAttribute("aria-valuemax", String(video.duration || 0));
      timeline.setAttribute("aria-valuetext", `${clock(video.currentTime)} / ${clock(video.duration)}`);
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
      pausedEndSeek.current = false;
      setPlaying(true);
      setReplayBlocked(false);
    });
    art.on("video:playing", () => setError(false));
    art.on("video:pause", () => { setPlaying(false); persist(); });
    art.on("video:timeupdate", () => {
      setPosition(video.currentTime);
      timelineValue();
      if (Date.now() - lastSave >= 5000) { persist(); lastSave = Date.now(); }
    });
    art.on("video:seeking", () => {
      pausedEndSeek.current = video.paused && video.currentTime >= video.duration;
    });
    art.on("video:seeked", () => {
      setPosition(video.currentTime);
      timelineValue();
      persist();
    });
    art.on("video:ratechange", () => setRate(video.playbackRate));
    const volumeChanged = () => { setVolume(video.volume); setMuted(video.muted); };
    art.on("video:volumechange", volumeChanged);
    volumeChanged();
    art.on("video:error", () => {
      // Preserve the last valid snapshot before disabling further seeks/saves.
      persist();
      ready.current = false;
      setSeekReady(false);
      setError(true);
      setPlaying(false);
      timeline.setAttribute("aria-disabled", "true");
    });
    art.on("video:ended", () => {
      setPlaying(false);
      const current = latest.current;
      current.update(current.progressID, {
        completed: true, position: video.duration, duration: video.duration,
      }, true);
      if (pausedEndSeek.current) return;
      if (current.reading && current.loopReading) {
        video.currentTime = 0;
        persist();
        play();
      } else current.onEnded();
    });
    const visibility = () => { if (document.visibilityState === "hidden") persist(); };
    window.addEventListener("pagehide", persist);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      persist();
      video.pause();
      window.removeEventListener("pagehide", persist);
      document.removeEventListener("visibilitychange", visibility);
      art.destroy();
      player.current = null;
    };
    // Each resource is keyed by its lesson and mode; state changes never recreate it.
  }, [props.source, props.progressID]);

  useEffect(() => {
    const changed = () => setNativeFullscreen(document.fullscreenElement === shell.current);
    document.addEventListener("fullscreenchange", changed);
    return () => document.removeEventListener("fullscreenchange", changed);
  }, []);
  useEffect(() => {
    if (!webFullscreen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setWebFullscreen(false);
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
    } else if (webFullscreen) {
      setWebFullscreen(false);
    } else {
      try {
        if (!shell.current?.requestFullscreen) throw new Error("Use webpage fullscreen");
        await shell.current.requestFullscreen();
      } catch { setWebFullscreen(true); }
    }
  };
  useEffect(() => {
    if (!speedOpen) return;
    speedPanel.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
    const outside = (e: PointerEvent) => {
      if (!speedPanel.current?.contains(e.target as Node) && !speedTrigger.current?.contains(e.target as Node))
        setSpeedOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [speedOpen]);

  const keyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest('input, textarea, select, [contenteditable="true"], [role="menu"]')) return;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      seek(event.key === "ArrowLeft" ? -5 : 5);
    } else if (event.key === " " && !target.closest("button")) {
      event.preventDefault(); togglePlay();
    } else if (target.getAttribute("role") === "slider" && ["Home", "End"].includes(event.key)) {
      event.preventDefault(); seekTo(event.key === "Home" ? 0 : duration);
    }
  };
  const offsets = props.reading ? [-10, -5, 5, 10] : [-30, -15, -10, -5, 5, 10, 15, 30];

  return (
    <div ref={shell} className={`learning-player ${props.reading ? "is-reading" : "is-lecture"} ${fullscreen ? "is-fullscreen" : ""} ${webFullscreen ? "web-fullscreen" : ""}`}
      role="region" aria-label="课程播放器" tabIndex={0} onKeyDown={keyboard}
      onFocusCapture={() => { if (player.current) player.current.controls.show = true; }}>
      <div className="player-stage">
        <div ref={host} className="art-host" />
        {error && <div className="player-error" role="alert">
          <WifiOff size={28} /><strong>视频暂时无法播放</strong>
          <p>学习进度已保留，请检查连接后重试。</p>
          <button onClick={() => {
            setError(false);
            player.current?.video.load();
          }}><RotateCcw size={16} />重新加载</button>
        </div>}
      </div>
      {controls && createPortal(<div className="media-controls">
        <button className="media-icon" aria-label={playing ? "暂停" : "播放"} onClick={togglePlay} disabled={error}>
          {playing ? <Pause size={21} fill="currentColor" /> : <Play size={21} fill="currentColor" />}
        </button>
        <span className="media-time">{clock(position)}<span> / {clock(duration)}</span></span>
        <div className="media-volume">
          <button className="media-icon" aria-label={muted ? "取消静音" : "静音"} onClick={() => {
            if (player.current) player.current.video.muted = !player.current.video.muted;
          }}>{muted || volume === 0 ? <VolumeX size={20} /> : <Volume2 size={20} />}</button>
          <input type="range" aria-label="音量" min="0" max="1" step="0.05" value={muted ? 0 : volume}
            onChange={(e) => {
              if (player.current) { player.current.video.muted = false; player.current.video.volume = Number(e.target.value); }
            }} />
        </div>
        <button className="media-icon" aria-label={fullscreen ? "退出全屏" : "全屏"} onClick={() => void toggleFullscreen()}>
          {fullscreen ? <Minimize size={21} /> : <Maximize size={21} />}
        </button>
      </div>, controls)}
      <div className="learning-dock">
        <div className="dock-settings">
          <span className="dock-caption">{props.reading ? "LISTEN & REPEAT" : "LEARN AT YOUR PACE"}</span>
          <div className="dock-toggles">
            {props.reading && <button className="dock-toggle" role="switch" aria-checked={props.loopReading}
              onClick={() => props.onLoopChange(!props.loopReading)}><Repeat1 size={17} />循环当前视频</button>}
            <button className="dock-toggle" role="switch" aria-checked={props.continuous}
              onClick={() => props.onContinuousChange(!props.continuous)}><ListVideo size={17} />连续播放</button>
          </div>
          <div className="speed-control">
            <button ref={speedTrigger} aria-label="播放速度" aria-haspopup="menu" aria-expanded={speedOpen}
              onClick={() => setSpeedOpen(!speedOpen)}><Gauge size={17} /><span>{rate}×</span><ChevronDown size={13} /></button>
            {speedOpen && <div ref={speedPanel} className="speed-menu" role="menu" aria-label="播放速度" onKeyDown={(e) => {
              const items = Array.from(speedPanel.current!.querySelectorAll<HTMLButtonElement>("button"));
              const index = items.indexOf(document.activeElement as HTMLButtonElement);
              if (["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft"].includes(e.key)) {
                e.preventDefault(); e.stopPropagation();
                items[(index + (e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : -1) + items.length) % items.length].focus();
              } else if (e.key === "Escape") {
                e.preventDefault(); e.stopPropagation(); setSpeedOpen(false); speedTrigger.current?.focus();
              } else if (e.key === "Tab") setSpeedOpen(false);
            }}>
              {speeds.map((speed) => <button key={speed} role="menuitemradio" aria-checked={rate === speed}
                onClick={() => {
                  if (player.current) player.current.video.playbackRate = speed;
                  setRate(speed); setSpeedOpen(false); speedTrigger.current?.focus();
                }}><span>{speed}×</span>{rate === speed && <Check size={14} />}</button>)}
            </div>}
          </div>
        </div>
        <div className="seek-tools" role="group" aria-label="快捷跳转">
          {offsets.map((offset) => <button key={offset} type="button" disabled={!seekReady}
            aria-label={`${offset < 0 ? "快退" : "快进"} ${Math.abs(offset)} 秒`} onClick={() => seek(offset)}>
            {offset < 0 ? <RotateCcw size={17} /> : <RotateCw size={17} />}
            <span>{offset > 0 ? "+" : "−"}{Math.abs(offset)}<small>s</small></span>
          </button>)}
        </div>
        {replayBlocked && <div className="player-notice" role="status">
          <span>{props.reading && props.loopReading ? "已回到开头，点击播放即可继续循环。" : "点击播放即可继续观看。"}</span>
          <button onClick={play}><Play size={14} />播放</button>
        </div>}
      </div>
    </div>
  );
}
