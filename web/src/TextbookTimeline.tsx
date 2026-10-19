import { useEffect, useRef, useState, type ReactNode } from "react";
import { Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  audioClock,
  groupMarkers,
  markerLabel,
  type AudioMarker,
} from "./textbookMarkers";
import type { MarkerMode } from "./textbookProgress";
import { cn } from "@/lib/utils";

function MarkerList({
  markers,
  select,
}: {
  markers: AudioMarker[];
  select: (marker: AudioMarker) => void;
}) {
  return (
    <div
      aria-label="全部断点"
      onKeyDown={(event) => event.stopPropagation()}
      className="max-h-52 space-y-1 overflow-y-auto overscroll-contain"
    >
      {markers.map((marker) => (
        <Button
          key={marker.id}
          variant="ghost"
          className="h-auto min-h-11 w-full flex-col items-start gap-1 px-2 py-2 text-left"
          onClick={() => select(marker)}
        >
          <span className="flex items-center gap-2 text-xs font-medium">
            {markerLabel(marker)}
            {marker.boundary && (
              <span
                className={cn(
                  "rounded px-1.5 py-0.5 text-[10px]",
                  marker.boundary === "start"
                    ? "bg-primary/10 text-primary"
                    : "bg-amber-100 text-amber-800",
                )}
              >
                {marker.boundary === "start" ? "开始" : "结束"}
              </span>
            )}
          </span>
          <span className="line-clamp-2 whitespace-normal text-xs font-normal text-muted-foreground">
            {marker.text}
          </span>
        </Button>
      ))}
    </div>
  );
}

export function TextbookPlayerSettings({
  markers,
  mode,
  changeMode,
  seekMarker,
  children,
}: {
  markers: AudioMarker[];
  mode: MarkerMode;
  changeMode: (mode: MarkerMode) => void;
  seekMarker: (marker: AudioMarker) => void;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const start = markers.find((marker) => marker.boundary === "start");
  const end = markers.find((marker) => marker.boundary === "end");
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-9 shrink-0"
          aria-label="播放器设置"
          title="播放器设置与全部断点"
        >
          <Settings2 className="size-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        className="max-h-(--radix-popover-content-available-height) w-80 max-w-[calc(100vw-2rem)] space-y-3 overflow-y-auto p-3"
      >
        {children(() => setOpen(false))}
        <div className="space-y-2 border-t pt-3">
          <p className="text-xs font-semibold text-muted-foreground">
            断点设置
          </p>
          {start && end && (
            <p className="text-xs text-muted-foreground">
              整课循环范围：{audioClock(start.time)}–{audioClock(end.time)}
              ，跳过前奏与片尾。
            </p>
          )}
          <Tabs value={mode} onValueChange={(v) => changeMode(v as MarkerMode)}>
            <TabsList className="w-full">
              <TabsTrigger value="sentence" className="flex-1 text-xs">
                句子起点
              </TabsTrigger>
              <TabsTrigger value="paragraph" className="flex-1 text-xs">
                段落起点
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <MarkerList
            markers={markers}
            select={(marker) => {
              seekMarker(marker);
              setOpen(false);
            }}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}

function MarkerCluster({
  markers,
  seekMarker,
  style,
}: {
  markers: AudioMarker[];
  seekMarker: (marker: AudioMarker) => void;
  style: React.CSSProperties;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className="pointer-events-auto absolute top-1/2 flex h-6 w-4 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded hover:bg-primary/15 focus-visible:bg-primary/15"
          style={style}
          aria-label={`${markers.length} 个音频断点`}
          title={`${markers.length} 个相邻断点，点击选择`}
          onPointerDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          {markers.some((marker) => marker.boundary === "start") ? (
            <span className="rounded-sm bg-primary px-0.5 text-[10px] leading-4 font-semibold text-primary-foreground">
              始
            </span>
          ) : (
            <span className="h-1.5 w-2 rounded-sm bg-card ring-1 ring-primary/60" />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        className="w-80 max-w-[calc(100vw-2rem)] p-2"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <MarkerList
          markers={markers}
          select={(marker) => {
            seekMarker(marker);
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

export function TextbookTimeline({
  markers,
  duration,
  position,
  seek,
  seekMarker,
}: {
  markers: AudioMarker[];
  duration: number;
  position: number;
  seek: (time: number) => void;
  seekMarker: (marker: AudioMarker) => void;
}) {
  const track = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [preview, setPreview] = useState<number | null>(null);
  useEffect(() => {
    if (!track.current) return;
    const observer = new ResizeObserver((entries) =>
      setWidth(entries[0].contentRect.width),
    );
    observer.observe(track.current);
    return () => observer.disconnect();
  }, []);
  const value = Math.max(0, Math.min(preview ?? position, duration));
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <span className="hidden text-[11px] tabular-nums text-muted-foreground sm:block">
        {audioClock(value)}
      </span>
      <div ref={track} className="min-w-0 flex-1">
        <Slider
          aria-label="课文音频进度"
          aria-valuetext={`${audioClock(value)} / ${audioClock(duration)}`}
          min={0}
          max={duration || 1}
          step={0.05}
          value={[value]}
          disabled={duration <= 0}
          onValueChange={(v) => setPreview(v[0])}
          onValueCommit={(v) => {
            seek(v[0]);
            setPreview(null);
          }}
          className="h-11"
        >
          <div className="pointer-events-none absolute inset-x-2 top-1/2 h-1.5 -translate-y-1/2">
            {[
              ...groupMarkers(
                markers.filter((marker) => marker.boundary !== "end"),
                Math.max(1, width - 16),
                duration,
              ),
              ...markers
                .filter((marker) => marker.boundary === "end")
                .map((marker) => [marker]),
            ].map((group) => {
              const first = group[0];
              const style = {
                left: `${Math.max(0, Math.min(100, (first.time / (duration || 1)) * 100))}%`,
              };
              return group.length > 1 ? (
                <MarkerCluster
                  key={first.id}
                  markers={group}
                  style={style}
                  seekMarker={seekMarker}
                />
              ) : (
                <button
                  key={first.id}
                  className={cn(
                    "pointer-events-auto absolute top-1/2 flex h-6 w-4 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded hover:bg-primary/15 focus-visible:bg-primary/15",
                    first.boundary && "z-10",
                  )}
                  style={style}
                  aria-label={`跳到${markerLabel(first)}`}
                  title={`${markerLabel(first)} · ${first.text}`}
                  onPointerDown={(event) => event.stopPropagation()}
                  onKeyDown={(event) => event.stopPropagation()}
                  onClick={() => seekMarker(first)}
                >
                  {first.boundary ? (
                    <span
                      className={cn(
                        "rounded-sm px-0.5 text-[10px] leading-4 font-semibold",
                        first.boundary === "start"
                          ? "bg-primary text-primary-foreground"
                          : "bg-amber-700 text-white",
                      )}
                    >
                      {first.boundary === "start" ? "始" : "终"}
                    </span>
                  ) : (
                    <span className="h-1.5 w-0.5 bg-card ring-1 ring-primary/60" />
                  )}
                </button>
              );
            })}
          </div>
        </Slider>
      </div>
      <span className="hidden text-[11px] tabular-nums text-muted-foreground sm:block">
        {audioClock(duration)}
      </span>
    </div>
  );
}
