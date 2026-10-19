import { useEffect, useRef, useState } from "react";
import { List, MapPin } from "lucide-react";
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
  buildMarkers,
  groupMarkers,
  markerLabel,
  type AudioMarker,
  type TimedParagraph,
} from "./textbookMarkers";
import type { MarkerMode } from "./textbookProgress";

function MarkerMenu({
  markers,
  seek,
  children,
}: {
  markers: AudioMarker[];
  seek: (time: number) => void;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        side="top"
        align="center"
        className="w-80 max-w-[calc(100vw-2rem)] p-2"
      >
        <p className="px-2 py-2 text-xs font-semibold text-muted-foreground">
          选择音频断点
        </p>
        <div className="max-h-64 space-y-1 overflow-y-auto">
          {markers.map((m) => (
            <Button
              key={m.id}
              variant="ghost"
              className="h-auto min-h-11 w-full flex-col items-start gap-1 px-2 py-2 text-left"
              onClick={() => {
                seek(m.time);
                setOpen(false);
              }}
            >
              <span className="text-xs font-medium">{markerLabel(m)}</span>
              <span className="line-clamp-2 whitespace-normal text-xs font-normal text-muted-foreground">
                {m.text}
              </span>
            </Button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
export function TextbookTimeline({
  paragraphs,
  duration,
  position,
  mode,
  changeMode,
  seek,
}: {
  paragraphs: TimedParagraph[];
  duration: number;
  position: number;
  mode: MarkerMode;
  changeMode: (mode: MarkerMode) => void;
  seek: (time: number) => void;
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
  const markers = buildMarkers(paragraphs, mode, duration);
  const value = Math.min(preview ?? position, duration);
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Tabs
          value={mode}
          onValueChange={(v) => changeMode(v as MarkerMode)}
          aria-label="断点类型"
        >
          <TabsList className="h-8">
            <TabsTrigger value="sentence" className="text-xs">
              句子起止
            </TabsTrigger>
            <TabsTrigger value="paragraph" className="text-xs">
              段落起止
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <span className="hidden sm:inline">上方起点 · 下方终点</span>
          <MarkerMenu markers={markers} seek={seek}>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 gap-1 text-xs"
              aria-label="全部断点"
            >
              <List className="size-3.5" />
              断点列表
            </Button>
          </MarkerMenu>
        </div>
      </div>
      <div ref={track} className="relative mx-3 pt-7 pb-7">
        {(["start", "end"] as const).map((edge) =>
          groupMarkers(
            markers.filter((m) => m.edge === edge),
            width,
            duration,
          ).map((group) => {
            const first = group[0];
            const props = {
              className: `absolute flex h-7 min-w-7 -translate-x-1/2 items-center justify-center rounded text-primary transition-colors hover:bg-primary/10 focus-visible:bg-primary/10 ${edge === "start" ? "top-0" : "bottom-0"}`,
              style: {
                left: `${Math.max(0, Math.min(100, (first.time / duration) * 100))}%`,
              },
            };
            return group.length > 1 ? (
              <MarkerMenu key={first.id} markers={group} seek={seek}>
                <button
                  {...props}
                  aria-label={`${group.length} 个${edge === "start" ? "起点" : "终点"}断点`}
                >
                  <span className="rounded bg-secondary px-1 text-[10px] font-semibold">
                    {group.length}
                  </span>
                </button>
              </MarkerMenu>
            ) : (
              <button
                key={first.id}
                {...props}
                aria-label={`跳到${markerLabel(first)}`}
                title={`${markerLabel(first)}\n${first.text}`}
                onClick={() => seek(first.time)}
              >
                {edge === "start" ? (
                  <MapPin className="size-3.5" />
                ) : (
                  <span className="size-2 rounded-sm border-2 border-primary/65" />
                )}
              </button>
            );
          }),
        )}
        <Slider
          aria-label="课文音频进度"
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
          className="h-5"
        />
      </div>
      <div className="flex justify-between text-[11px] tabular-nums text-muted-foreground">
        <span>{audioClock(value)}</span>
        <span>{audioClock(duration)}</span>
      </div>
    </div>
  );
}
