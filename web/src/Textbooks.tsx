import { flushProgressSync } from "./progressSync";
import { AIWorkspace } from "./AIWorkspace";
import type { AITarget } from "./ai";
import { VocabularyEntry, type TextVocabulary } from "./VocabularyEntry";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  Headphones,
  Languages,
  Pause,
  Play,
  Repeat,
  Repeat1,
  Sparkles,
  RotateCcw,
} from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { claimMedia, MEDIA_EVENT } from "./mediaCoordinator";
import {
  RATES,
  lastLessonInBook,
  readPosition,
  useTextbookProgress,
  writePosition,
  type MarkerMode,
  type ReadingPosition,
} from "./textbookProgress";
import { TextbookTimeline, TextbookPlayerSettings } from "./TextbookTimeline";
import {
  audioClock as clock,
  buildMarkers,
  lessonAudioRange,
  markerAtPosition,
  type AudioMarker,
} from "./textbookMarkers";

export type TextWord = {
  id: string;
  text: string;
  before: string;
  start: number | null;
  end: number | null;
};
export type TextSentence = {
  id: string;
  text: string;
  translationZh?: string;
  start: number | null;
  end: number | null;
  words: TextWord[];
};
export type TextLesson = {
  book: number;
  lesson: number;
  label: string;
  titleEn: string;
  titleZh: string;
  instruction: string;
  instructionZh: string;
  question: string;
  duration: number;
  revision: string;
  alignment: string;
  paragraphs: {
    id: string;
    speaker?: string;
    note?: string;
    sentences: TextSentence[];
  }[];
  vocabulary: TextVocabulary[];
  translation: string[];
  lectureLessonId?: string;
};
type LessonSummary = Pick<
  TextLesson,
  | "lesson"
  | "label"
  | "titleEn"
  | "titleZh"
  | "duration"
  | "alignment"
  | "lectureLessonId"
>;
type Book = {
  book: number;
  name: string;
  subtitleEn: string;
  available: boolean;
  lessonCount: number;
  lessons: LessonSummary[];
  downloads: string[];
};
type Source = {
  url: string;
  kind: "full" | "sentence" | "word" | "vocabulary";
  offset: number;
  id: string;
};
type LoopMode = "off" | "lesson" | "selection";
const bookNames = ["", "英语初阶", "实践与进步", "培养技能", "流利英语"];
const numerals = ["", "一", "二", "三", "四"];
export function navigateBook(path: string) {
  history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
  window.scrollTo({ top: 0 });
}
function Link({
  to,
  children,
  className,
  ...props
}: { to: string; children: React.ReactNode; className?: string } & Omit<
  React.AnchorHTMLAttributes<HTMLAnchorElement>,
  "href"
>) {
  return (
    <a
      {...props}
      href={to}
      className={className}
      onClick={(e) => {
        if (!e.ctrlKey && !e.metaKey && !e.shiftKey && e.button === 0) {
          e.preventDefault();
          navigateBook(to);
        }
      }}
    >
      {children}
    </a>
  );
}
function useResource<T>(url: string) {
  const [value, setValue] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setValue(null);
    setError("");
    void fetch(url, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok)
          throw new Error(
            (await response.json()).error || "暂时无法加载，请重试",
          );
        return response.json() as Promise<T>;
      })
      .then((data) => {
        if (!controller.signal.aborted) setValue(data);
      })
      .catch((e) => {
        if (!controller.signal.aborted)
          setError(e instanceof Error ? e.message : "暂时无法加载");
      });
    return () => controller.abort();
  }, [url, attempt]);
  return { value, error, retry: () => setAttempt((v) => v + 1) };
}
function Loading({ error, retry }: { error: string; retry: () => void }) {
  return (
    <div
      className="flex min-h-72 flex-col items-center justify-center gap-4 py-16 text-muted-foreground"
      role="status"
    >
      <BookOpen className="size-8" />
      <p>{error || "正在打开课本…"}</p>
      {error && (
        <Button variant="outline" onClick={retry}>
          重新加载
        </Button>
      )}
    </div>
  );
}
function BookProgress({ book, total }: { book: number; total: number }) {
  const progress = useTextbookProgress();
  const done = Object.entries(progress.lessons).filter(([key, item]) => {
    const [b, n] = key.split(":").map(Number);
    return (
      b === book &&
      item.completed &&
      n >= 1 &&
      (book === 1 ? n <= 143 && n % 2 === 1 : n <= [0, 0, 96, 60, 48][book])
    );
  }).length;
  const percent = total ? Math.round((done / total) * 100) : 0;
  return (
    <div className="space-y-2" aria-label={`第${numerals[book]}册学习进度`}>
      <div className="flex justify-between gap-4 text-xs text-muted-foreground">
        <span>
          已学 <strong className="text-primary">{done}</strong> / {total} 课
        </span>
        <span>{percent}%</span>
      </div>
      <Progress
        aria-label={`第${numerals[book]}册完成度`}
        value={percent}
        className="h-1.5"
      />
    </div>
  );
}
function CompletionButton({
  lessonKey,
  duration,
  className,
}: {
  lessonKey: string;
  duration: number;
  className?: string;
}) {
  const progress = useTextbookProgress();
  const [failed, setFailed] = useState(false);
  const completed = progress.lessons[lessonKey]?.completed || false;
  return (
    <div className={className}>
      <Button
        variant={completed ? "secondary" : "outline"}
        size="sm"
        aria-label={`第${numerals[Number(lessonKey.split(":")[0])]}册第${lessonKey.split(":")[1]}课，${completed ? "标记未学" : "标记已学"}`}
        aria-pressed={completed}
        className="min-h-11 gap-1.5 whitespace-nowrap"
        onClick={() =>
          setFailed(
            !writePosition(lessonKey, { completed: !completed, duration }),
          )
        }
      >
        {completed ? (
          <CheckCircle2 className="size-4" />
        ) : (
          <Check className="size-4" />
        )}
        {completed ? "已学 · 标记未学" : "标记已学"}
      </Button>
      {failed && (
        <p role="status" className="mt-1 text-xs text-destructive">
          当前浏览器无法保存进度
        </p>
      )}
    </div>
  );
}
export function Textbooks({ pathname }: { pathname: string }) {
  const parts = pathname.split("/").filter(Boolean);
  const book = Number(parts[1]),
    lesson = Number(parts[3]);
  const validLesson =
    Number.isInteger(lesson) &&
    lesson >= 1 &&
    lesson <= [0, 143, 96, 60, 48][book] &&
    (book !== 1 || lesson % 2 === 1);
  const valid =
    parts.length === 1 ||
    (Number.isInteger(book) &&
      book >= 1 &&
      book <= 4 &&
      (parts.length === 2 ||
        (parts.length === 4 && parts[2] === "lessons" && validLesson)));
  if (!valid)
    return (
      <main className="page-shell">
        <Loading
          error="没有找到这本教材或课文"
          retry={() => navigateBook("/books")}
        />
      </main>
    );
  return (
    <main className="page textbook-page page-shell pb-12">
      <nav
        aria-label="面包屑"
        className="breadcrumb my-6 flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
      >
        <Link
          to="/books"
          className="inline-flex items-center gap-1.5 hover:text-primary"
        >
          <BookOpen className="size-3.5" />
          课程
        </Link>
        {book > 0 && (
          <>
            <ChevronRight className="size-3" />
            <Link to={`/books/${book}`}>
              第{numerals[book]}册 · {bookNames[book]}
            </Link>
          </>
        )}
        {lesson > 0 && (
          <>
            <ChevronRight className="size-3" />
            <span>
              {book === 1
                ? `Lesson ${lesson} & ${lesson + 1}`
                : `Lesson ${lesson}`}
            </span>
          </>
        )}
      </nav>
      {lesson > 0 ? (
        <TextbookLesson key={`${book}:${lesson}`} book={book} lesson={lesson} />
      ) : book > 0 ? (
        <BookContents key={book} book={book} />
      ) : (
        <Bookshelf />
      )}
    </main>
  );
}
function Bookshelf() {
  const { value: books, error, retry } = useResource<Book[]>("/api/books");
  const progress = useTextbookProgress();
  if (!books) return <Loading error={error} retry={retry} />;
  return (
    <>
      <header className="my-10 space-y-4 sm:my-14">
        <Badge variant="secondary" className="gap-1.5 px-3 py-1.5">
          <BookOpen className="size-3.5" />
          我的随身课本
        </Badge>
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
          把熟悉的课文，读成自己的表达。
        </h1>
        <p className="text-muted-foreground">
          从第一句问候开始。点读、精听，每一课都留下进步。
        </p>
      </header>
      <div className="bookshelf grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
        {books.map((b) => {
          const last = lastLessonInBook(progress, b.book);
          return (
            <Card key={b.book} className="gap-0 overflow-hidden pt-0 shadow-sm">
              <Link
                to={`/books/${b.book}`}
                className={cn(
                  "textbook-cover group relative flex min-h-72 flex-col overflow-hidden bg-primary p-6 text-white transition-colors hover:bg-primary/95",
                  ["", "", "bg-[#3e6559]", "bg-[#51674e]", "bg-[#3b5b58]"][
                    b.book
                  ],
                )}
              >
                <div
                  aria-hidden="true"
                  className="absolute inset-y-0 left-0 w-2 border-r border-white/10 bg-black/10"
                />
                <span className="text-[10px] tracking-[.18em] text-white/75">
                  NEW CONCEPT ENGLISH
                </span>
                <strong className="my-5 font-serif text-7xl font-normal text-chalk">
                  0{b.book}
                </strong>
                <h2 className="text-2xl font-medium">{bookNames[b.book]}</h2>
                <p className="mt-2 font-serif text-sm text-white/75">
                  {b.subtitleEn || "New Concept English"}
                </p>
                <span className="mt-6 flex items-center gap-2 border-t border-white/20 pt-4 text-xs text-white/85">
                  <Headphones className="size-4" />
                  {b.available
                    ? `${b.lessonCount} 课 · 原音精听`
                    : "教材正在准备"}
                  <ChevronRight className="ml-auto size-4 transition-transform group-hover:translate-x-1" />
                </span>
              </Link>
              <CardContent className="space-y-4 px-5 pt-5">
                <BookProgress book={b.book} total={b.lessonCount} />
                <Link
                  to={
                    last
                      ? `/books/${b.book}/lessons/${last.split(":")[1]}`
                      : `/books/${b.book}`
                  }
                  className={cn(
                    buttonVariants({ variant: "outline", size: "sm" }),
                    "w-full gap-2",
                  )}
                >
                  <Play className="size-3.5" />
                  {last ? `继续 Lesson ${last.split(":")[1]}` : "打开课本"}
                </Link>
              </CardContent>
            </Card>
          );
        })}
      </div>
      <p className="mt-6 text-xs leading-6 text-muted-foreground">
        学习记录保存在当前浏览器。第一册按相邻两课组成一个学习单元。
      </p>
    </>
  );
}
function BookContents({ book }: { book: number }) {
  const { value, error, retry } = useResource<Book>(`/api/books/${book}`);
  const progress = useTextbookProgress();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  if (!value) return <Loading error={error} retry={retry} />;
  const lastKey = lastLessonInBook(progress, book);
  const resume =
    value.lessons.find((l) => `${book}:${l.lesson}` === lastKey) ||
    value.lessons.find(
      (l) => !progress.lessons[`${book}:${l.lesson}`]?.completed,
    ) ||
    value.lessons[0];
  const lessons = value.lessons.filter(
    (l) =>
      `${l.label} ${l.titleEn} ${l.titleZh}`
        .toLowerCase()
        .includes(query.toLowerCase().trim()) &&
      (filter === "all" ||
        (filter === "completed"
          ? progress.lessons[`${book}:${l.lesson}`]?.completed
          : !progress.lessons[`${book}:${l.lesson}`]?.completed)),
  );
  return (
    <>
      <header className="my-10 space-y-3">
        <p className="text-xs tracking-widest text-muted-foreground">
          {value.subtitleEn}
        </p>
        <h1 className="text-3xl font-semibold sm:text-4xl">{value.name}</h1>
        <p className="text-muted-foreground">
          {value.lessonCount} 课 · 原音点读 · 逐词跟随
        </p>
      </header>
      <Card className="mb-7 bg-white/70 shadow-none">
        <CardContent className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="w-full sm:max-w-lg">
            <BookProgress book={book} total={value.lessonCount} />
          </div>
          {resume && (
            <Link
              to={`/books/${book}/lessons/${resume.lesson}`}
              className={cn(buttonVariants(), "gap-2")}
            >
              <Play className="size-4" />
              {lastKey ? "继续学习" : "开始学习"} · Lesson {resume.lesson}
            </Link>
          )}
        </CardContent>
      </Card>
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <Input
          className="h-11 w-full bg-card sm:max-w-xs"
          aria-label="搜索课文"
          placeholder="搜索课号或课文标题"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Tabs value={filter} onValueChange={setFilter}>
          <TabsList>
            <TabsTrigger value="all">全部</TabsTrigger>
            <TabsTrigger value="unlearned">未学</TabsTrigger>
            <TabsTrigger value="completed">已学</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="ml-auto flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          <Download className="size-4" />
          {value.downloads.map((format) => (
            <a
              className="py-3 hover:text-primary hover:underline"
              key={format}
              href={`/api/books/${book}/downloads/${format}`}
            >
              {format.toUpperCase()}
            </a>
          ))}
        </div>
      </div>
      <div className="textbook-contents grid gap-3">
        {lessons.map((l) => {
          const saved = progress.lessons[`${book}:${l.lesson}`];
          return (
            <Card
              key={l.lesson}
              className="flex-row flex-wrap items-center gap-2 py-2 pr-3 shadow-none transition-colors hover:border-primary/40"
            >
              <Link
                to={`/books/${book}/lessons/${l.lesson}`}
                className="textbook-lesson-card flex min-w-0 flex-1 items-center gap-3 p-4"
              >
                <span
                  className={cn(
                    "grid size-10 shrink-0 place-items-center rounded-xl bg-secondary text-xs font-semibold text-primary",
                    saved?.completed && "bg-primary text-white",
                  )}
                >
                  {saved?.completed ? (
                    <Check className="size-4" />
                  ) : (
                    String(l.lesson).padStart(2, "0")
                  )}
                </span>
                <div className="min-w-0 space-y-1">
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    {l.label}
                  </span>
                  <h2 className="truncate font-medium">{l.titleEn}</h2>
                  <p className="truncate text-xs text-muted-foreground">
                    {l.titleZh}
                  </p>
                  <small className="block text-[11px] text-primary">
                    {saved?.completed
                      ? "已学"
                      : saved?.position > 0
                        ? `学习中 · ${clock(saved.position)} / ${clock(l.duration)}`
                        : `${clock(l.duration)} · 未学`}
                  </small>
                </div>
              </Link>
              <CompletionButton
                lessonKey={`${book}:${l.lesson}`}
                duration={l.duration}
                className="ml-auto"
              />
            </Card>
          );
        })}
      </div>
      {lessons.length === 0 && (
        <p className="py-12 text-center text-muted-foreground">
          没有找到课文，换个关键词或筛选试试。
        </p>
      )}
    </>
  );
}
export function TextbookLesson({
  book,
  lesson,
  embedded = false,
}: {
  book: number;
  lesson: number;
  embedded?: boolean;
}) {
  const { value, error, retry } = useResource<TextLesson>(
    `/api/books/${book}/lessons/${lesson}`,
  );
  useEffect(() => {
    if (value && !embedded)
      document.title = `${value.label} · ${value.titleEn} | FirstLeap`;
  }, [value, embedded]);
  if (!value) return <Loading error={error} retry={retry} />;
  return (
    <AIWorkspace
      key={`${book}:${lesson}:${value.revision}`}
      lesson={value}
      heading={<ReadingHeading lesson={value} embedded={embedded} />}
    >
      {(explain) => (
        <ReadingRoom lesson={value} embedded={embedded} onExplain={explain} />
      )}
    </AIWorkspace>
  );
}
function ReadingHeading({
  lesson,
  embedded,
}: {
  lesson: TextLesson;
  embedded: boolean;
}) {
  return (
    <header className="reading-heading mb-7 flex flex-wrap items-start justify-between gap-5 pt-5 sm:pt-8">
      <div className="space-y-3">
        <Badge variant="secondary" className="font-normal">
          {lesson.label} · 课文精听
        </Badge>
        <h1
          className={cn(
            "font-serif text-4xl leading-tight tracking-tight sm:text-5xl",
            embedded && "sm:text-4xl",
          )}
        >
          {lesson.titleEn}
        </h1>
        <p className="text-muted-foreground">{lesson.titleZh}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <CompletionButton
          lessonKey={`${lesson.book}:${lesson.lesson}`}
          duration={lesson.duration}
        />
        {lesson.lectureLessonId && (
          <a
            className={cn(
              buttonVariants({ variant: "ghost", size: "sm" }),
              "gap-1",
            )}
            href={`/learn/${lesson.lectureLessonId}`}
          >
            观看讲解
            <ChevronRight className="size-4" />
          </a>
        )}
        {embedded && (
          <Link
            to={`/books/${lesson.book}/lessons/${lesson.lesson}`}
            className={buttonVariants({ variant: "ghost", size: "sm" })}
          >
            打开课程
            <BookOpen className="ml-1 size-4" />
          </Link>
        )}
      </div>
    </header>
  );
}
function centerReadingAnchor(id: string) {
  const target = document.getElementById(id);
  if (!target?.getClientRects().length) return;
  const rect = target.getBoundingClientRect();
  window.scrollTo({
    top: window.scrollY + rect.top + (rect.height - window.innerHeight) / 2,
    behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ? "instant"
      : "smooth",
  });
}
function ReadingRoom({
  lesson,
  embedded,
  onExplain,
}: {
  lesson: TextLesson;
  embedded: boolean;
  onExplain: (target: AITarget) => void;
}) {
  const base = `/api/books/${lesson.book}/lessons/${lesson.lesson}`;
  const key = `${lesson.book}:${lesson.lesson}`;
  const progress = useTextbookProgress();
  const record = progress.lessons[key] || readPosition(key);
  const [initial] = useState(() => readPosition(key));
  const audio = useRef<HTMLAudioElement>(null);
  const source = useRef<Source>({
    url: `${base}/audio`,
    kind: "full",
    offset: 0,
    id: "full",
  });
  const interacted = useRef(false);
  const generation = useRef(0),
    playIntent = useRef(false),
    switching = useRef(false),
    manualEnd = useRef(false);
  const repeatTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loopRef = useRef<LoopMode>("off"),
    rateRef = useRef(initial.rate);
  const fullPosition = useRef(
    initial.position >= lesson.duration - 0.2 ? 0 : initial.position,
  );
  const lastSave = useRef(0);
  const [position, setPosition] = useState(fullPosition.current),
    [playing, setPlaying] = useState(false),
    [running, setRunning] = useState(false);
  const [loopMode, setLoopMode] = useState<LoopMode>("off"),
    [rate, setRate] = useState(initial.rate);
  const [selected, setSelected] = useState(""),
    [kind, setKind] = useState<Source["kind"]>("full");
  const [error, setError] = useState(""),
    [storageError, setStorageError] = useState(false);
  const [tab, setTab] = useState("passage"),
    [follow, setFollow] = useState(true);
  const [translations, setTranslations] = useState<Set<string>>(
    () => new Set(),
  );
  const [focusedMarker, setFocusedMarker] = useState<AudioMarker | null>(null);
  const markers = useMemo(
    () => buildMarkers(lesson.paragraphs, record.markerMode, lesson.duration),
    [lesson.paragraphs, record.markerMode, lesson.duration],
  );
  const loopRange = useMemo(
    () => lessonAudioRange(lesson.paragraphs, lesson.duration),
    [lesson.paragraphs, lesson.duration],
  );
  const anchor =
    focusedMarker &&
    !playing &&
    focusedMarker.mode === record.markerMode &&
    Math.abs(position - focusedMarker.time) < 0.1
      ? focusedMarker
      : markerAtPosition(markers, position);
  const sentences = lesson.paragraphs.flatMap((p) => p.sentences);
  const current = sentences.find(
    (s) =>
      s.start !== null &&
      s.end !== null &&
      position >= s.start &&
      position < s.end,
  );
  const currentWord = current?.words.find(
    (w) =>
      w.start !== null &&
      w.end !== null &&
      position >= w.start &&
      position < w.end,
  );
  const currentRef = useRef(current?.id || initial.sentence);
  currentRef.current =
    (anchor?.mode === "sentence" ? anchor.targetId : current?.id) ||
    currentRef.current;
  const firstIndex = sentences.findIndex(
    (s) =>
      s.id ===
      ((anchor?.mode === "sentence" ? anchor.targetId : current?.id) ||
        (position >= (sentences[0]?.start ?? 0) ? currentRef.current : "")),
  );
  const save = (patch: Partial<ReadingPosition>, markLast = false) => {
    if (!writePosition(key, patch, markLast)) setStorageError(true);
  };
  const persist = (immediate = false) => {
    save({
      position: fullPosition.current,
      duration: lesson.duration,
      rate: rateRef.current,
      sentence:
        sentences.find(
          (s) =>
            s.start !== null &&
            s.end !== null &&
            fullPosition.current >= s.start &&
            fullPosition.current < s.end,
        )?.id || readPosition(key).sentence,
    });
    if (immediate) flushProgressSync();
  };
  const clearRepeat = () => {
    if (repeatTimer.current !== null) clearTimeout(repeatTimer.current);
    repeatTimer.current = null;
  };
  const stop = () => {
    playIntent.current = false;
    generation.current++;
    clearRepeat();
    audio.current?.pause();
    setRunning(false);
    setPlaying(false);
  };
  const changeLoop = (mode: LoopMode) => {
    loopRef.current = mode;
    setLoopMode(mode);
    if (mode !== "selection" && repeatTimer.current !== null) stop();
    const media = audio.current;
    if (mode === "lesson" && loopRange && source.current.kind === "full") {
      if (
        fullPosition.current < loopRange.start ||
        fullPosition.current >= loopRange.end
      ) {
        fullPosition.current = loopRange.start;
        setPosition(loopRange.start);
        if (media && media.readyState >= 1) media.currentTime = loopRange.start;
        persist(true);
      }
    }
  };
  const play = () => {
    interacted.current = true;
    const media = audio.current;
    if (!media) return;
    manualEnd.current = false;
    if (
      loopRef.current === "lesson" &&
      loopRange &&
      source.current.kind === "full" &&
      (fullPosition.current < loopRange.start ||
        fullPosition.current >= loopRange.end)
    ) {
      fullPosition.current = loopRange.start;
      setPosition(loopRange.start);
      if (media.readyState >= 1) media.currentTime = loopRange.start;
    }
    playIntent.current = true;
    setRunning(true);
    claimMedia(media);
    const token = generation.current;
    void media.play().catch((e) => {
      if (
        token === generation.current &&
        playIntent.current &&
        e.name !== "AbortError"
      ) {
        playIntent.current = false;
        setRunning(false);
        setPlaying(false);
        setError("播放未能开始，点击重试继续。");
      }
    });
  };
  const start = (next: Source, autoplay = true, seek?: number) => {
    interacted.current = true;
    const media = audio.current;
    if (!media) return;
    if (
      source.current.kind === "full" &&
      media.readyState >= 1 &&
      media.currentSrc === new URL(source.current.url, location.href).href
    ) {
      fullPosition.current = media.currentTime;
      persist(true);
    }
    const sameFull =
      source.current.kind === "full" &&
      next.kind === "full" &&
      media.readyState >= 1 &&
      !error;
    if (seek !== undefined)
      fullPosition.current = Math.max(0, Math.min(lesson.duration, seek));
    else if (
      next.kind === "full" &&
      fullPosition.current >= lesson.duration - 0.2
    )
      fullPosition.current = 0;
    if (next.kind !== "full" && loopRef.current === "lesson") changeLoop("off");
    if (next.kind === "full" && loopRef.current === "selection")
      changeLoop("off");
    stop();
    setFocusedMarker(null);
    setError("");
    source.current = next;
    setKind(next.kind);
    setSelected(next.id === "full" ? "" : next.id);
    manualEnd.current = seek !== undefined && seek >= lesson.duration;
    if (next.kind !== "vocabulary")
      setPosition(next.kind === "full" ? fullPosition.current : next.offset);
    if (sameFull) {
      media.currentTime = Math.min(fullPosition.current, media.duration);
      persist(true);
    } else {
      switching.current = true;
      media.src = next.url;
      media.load();
    }
    media.playbackRate = rateRef.current;
    media.preservesPitch = true;
    if (autoplay && !manualEnd.current) play();
  };
  const repeatLesson = () => {
    const media = audio.current;
    if (!media || !loopRange) return;
    save({ completed: true });
    fullPosition.current = loopRange.start;
    media.currentTime = loopRange.start;
    setPosition(loopRange.start);
    persist(true);
    if (media.paused) play();
  };
  const tick = () => {
    const media = audio.current;
    if (
      !media ||
      media.readyState < 1 ||
      source.current.kind === "vocabulary" ||
      media.currentSrc !== new URL(source.current.url, location.href).href
    )
      return;
    if (
      source.current.kind === "full" &&
      loopRef.current === "lesson" &&
      loopRange &&
      playIntent.current &&
      !manualEnd.current &&
      media.currentTime >= loopRange.end
    ) {
      repeatLesson();
      return;
    }
    setPosition(source.current.offset + media.currentTime);
    if (source.current.kind === "full") {
      fullPosition.current = media.currentTime;
      if (Date.now() - lastSave.current > 2000) {
        persist();
        lastSave.current = Date.now();
      }
    }
  };
  const chooseSentence = (sentence: TextSentence) => {
    if (sentence.start !== null && sentence.end !== null)
      start({
        url: `${base}/clips/${sentence.id}`,
        kind: "sentence",
        offset: sentence.start,
        id: sentence.id,
      });
  };
  const move = (direction: number) => {
    if (firstIndex < 0 && direction < 0) return;
    const next = sentences[firstIndex + direction];
    if (next) {
      setTab("passage");
      chooseSentence(next);
    }
  };
  const toggle = () => {
    if (playIntent.current) stop();
    else if (error) start(source.current);
    else play();
  };
  const seek = (target: number, marker?: AudioMarker) => {
    const resume = playIntent.current;
    setTab("passage");
    setFollow(true);
    start(
      { url: `${base}/audio`, kind: "full", offset: 0, id: "full" },
      resume,
      target,
    );
    setFocusedMarker(marker ?? null);
  };
  useEffect(() => {
    const restore = (event: Event) => {
      if (
        interacted.current ||
        playIntent.current ||
        source.current.kind !== "full"
      )
        return;
      const tracks = (
        event as CustomEvent<
          Record<string, Record<string, Partial<ReadingPosition>>>
        >
      ).detail;
      const remote = tracks.text?.[key];
      if (!remote || typeof remote.position !== "number") return;
      const target = Math.max(
        0,
        Math.min(
          remote.position >= lesson.duration - 0.2 ? 0 : remote.position,
          lesson.duration,
        ),
      );
      fullPosition.current = target;
      if (remote.rate && RATES.includes(remote.rate)) {
        rateRef.current = remote.rate;
        setRate(remote.rate);
      }
      const media = audio.current;
      if (media && media.readyState >= 1 && media.paused) {
        if (Math.abs(media.currentTime - target) > 0.05)
          media.currentTime = target;
        if (media.playbackRate !== rateRef.current)
          media.playbackRate = rateRef.current;
      }
      setPosition(target);
    };
    window.addEventListener("remote-progress-applied", restore);
    return () => window.removeEventListener("remote-progress-applied", restore);
  }, [key]);
  useEffect(() => {
    const media = audio.current!;
    media.src = source.current.url;
    media.load();
    save({ duration: lesson.duration }, true);
    const other = (e: Event) => {
      if ((e as CustomEvent).detail !== media) stop();
    };
    const hide = () => persist(true);
    const visibility = () => {
      if (document.visibilityState === "hidden") persist(true);
    };
    window.addEventListener(MEDIA_EVENT, other);
    window.addEventListener("pagehide", hide);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      playIntent.current = false;
      generation.current++;
      clearRepeat();
      persist(true);
      media.pause();
      media.removeAttribute("src");
      media.load();
      window.removeEventListener(MEDIA_EVENT, other);
      window.removeEventListener("pagehide", hide);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [key]);
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const update = () => {
      tick();
      frame = requestAnimationFrame(update);
    };
    frame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(frame);
  }, [playing]);
  useEffect(() => {
    if (!follow || !anchor || tab !== "passage") return;
    // Tabs mounts the passage through Radix Presence. Wait for that layout
    // before locating an anchor when seeking from the vocabulary tab.
    const frame = requestAnimationFrame(() => {
      centerReadingAnchor(
        `reading-${key}-${anchor.mode === "paragraph" ? "paragraph-" : ""}${anchor.targetId}`,
      );
    });
    return () => cancelAnimationFrame(frame);
  }, [anchor?.targetId, anchor?.mode, focusedMarker, follow, key, tab]);
  useEffect(() => {
    const manual = (e: Event) => {
      if (!(e.target instanceof Element && e.target.closest(".reading-dock")))
        setFollow(false);
    };
    const keyboardScroll = (e: globalThis.KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (
        !(
          e.target instanceof Element &&
          e.target.closest(
            'input, select, button, [role="slider"], [role="tab"], [role="menu"], [role="listbox"], [role="dialog"]',
          )
        ) &&
        ["PageDown", "PageUp", "Home", "End", "ArrowDown", "ArrowUp"].includes(
          e.code,
        )
      )
        setFollow(false);
    };
    window.addEventListener("wheel", manual, { passive: true });
    window.addEventListener("touchmove", manual, { passive: true });
    window.addEventListener("keydown", keyboardScroll);
    return () => {
      window.removeEventListener("wheel", manual);
      window.removeEventListener("touchmove", manual);
      window.removeEventListener("keydown", keyboardScroll);
    };
  }, []);
  const onEnded = () => {
    const media = audio.current;
    if (!media?.ended || !playIntent.current) return;
    if (
      source.current.kind === "full" &&
      loopRef.current === "lesson" &&
      loopRange &&
      !manualEnd.current
    ) {
      repeatLesson();
      return;
    }
    setPlaying(false);
    tick();
    if (manualEnd.current) {
      stop();
      return;
    }
    if (source.current.kind === "full") {
      fullPosition.current = lesson.duration;
      save({ completed: true });
      persist(true);
      playIntent.current = false;
      setRunning(false);
      return;
    }
    if (loopRef.current !== "selection") {
      playIntent.current = false;
      setRunning(false);
      return;
    }
    const token = generation.current;
    repeatTimer.current = setTimeout(() => {
      repeatTimer.current = null;
      if (
        token === generation.current &&
        playIntent.current &&
        loopRef.current === "selection" &&
        audio.current
      ) {
        audio.current.currentTime = 0;
        play();
      }
    }, 500);
  };
  const keyDown = (e: KeyboardEvent) => {
    if (e.defaultPrevented) return;
    if (
      e.target instanceof Element &&
      e.target.closest(
        'input, select, button, a, textarea, [role="slider"], [role="tab"], [role="menu"], [role="listbox"], [role="dialog"], [contenteditable="true"]',
      )
    )
      return;
    if (e.code === "Space") {
      e.preventDefault();
      toggle();
    }
    if (e.code === "ArrowLeft" || e.code === "ArrowRight") {
      e.preventDefault();
      move(e.code === "ArrowLeft" ? -1 : 1);
    }
  };
  const instruction =
    lesson.question && lesson.instruction.endsWith(lesson.question)
      ? lesson.instruction.slice(0, -lesson.question.length).trim()
      : lesson.instruction;
  const translated = sentences.filter((s) => s.translationZh);
  const expandedAll =
    translated.length > 0 && translated.every((s) => translations.has(s.id));
  const step = lesson.book === 1 ? 2 : 1;
  return (
    <section
      className={cn(
        "reading-room relative min-w-0 outline-none",
        embedded && "embedded-reading",
      )}
      aria-label="课文精听"
      data-reading-position={position}
      data-reading-sentence={current?.id || record.sentence}
      tabIndex={0}
      onKeyDown={keyDown}
    >
      <audio
        ref={audio}
        data-testid="textbook-audio"
        preload="metadata"
        onLoadedMetadata={() => {
          const media = audio.current!;
          switching.current = false;
          media.playbackRate = rateRef.current;
          media.preservesPitch = true;
          if (source.current.kind === "full") {
            media.currentTime = Math.min(
              fullPosition.current,
              media.duration || lesson.duration,
            );
            persist(true);
          }
          setError("");
        }}
        onPlay={() => {
          if (!playIntent.current) {
            audio.current?.pause();
            return;
          }
          claimMedia(audio.current!);
          setPlaying(true);
          setError("");
        }}
        onPause={() => {
          const media = audio.current!;
          if (!media.paused || switching.current) return;
          setPlaying(false);
          if (!media.ended) {
            playIntent.current = false;
            setRunning(false);
            clearRepeat();
          }
          if (
            source.current.kind === "full" &&
            media.readyState >= 1 &&
            media.currentSrc === new URL(source.current.url, location.href).href
          ) {
            fullPosition.current = media.currentTime;
            persist(true);
          }
        }}
        onTimeUpdate={tick}
        onSeeked={tick}
        onEnded={onEnded}
        onError={() => {
          switching.current = false;
          stop();
          setError("音频暂时无法播放，点击重试。");
        }}
      />
      <Tabs
        value={tab}
        onValueChange={setTab}
        className="reading-tabs gap-5 rounded-2xl border bg-card py-6 shadow-sm"
      >
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 sm:px-8">
          <TabsList aria-label="阅读内容" className="h-11">
            <TabsTrigger value="passage" className="min-w-24 gap-2">
              <BookOpen className="size-4" />
              课文
            </TabsTrigger>
            <TabsTrigger value="vocabulary" className="min-w-28 gap-2">
              <Languages className="size-4" />
              单词 · {lesson.vocabulary.length}
            </TabsTrigger>
          </TabsList>
          {tab === "passage" && translated.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                setTranslations(
                  expandedAll
                    ? new Set()
                    : new Set(translated.map((s) => s.id)),
                )
              }
            >
              <Languages className="mr-1 size-4" />
              {expandedAll ? "收起全部译文" : "展开全部译文"}
            </Button>
          )}
        </div>
        <TabsContent value="passage" className="reading-passage m-0">
          <Card className="gap-5 border-0 bg-transparent py-0 shadow-none">
            <CardContent className="space-y-7 px-4 sm:px-8">
              <div className="reading-question flex gap-3 rounded-xl border border-primary/10 bg-secondary/50 p-4 text-primary sm:p-5">
                <Headphones className="mt-1 size-5" />
                <div className="space-y-2">
                  <small className="text-xs leading-5 text-muted-foreground">
                    {instruction}
                  </small>
                  <p className="font-serif text-lg">{lesson.question}</p>
                  {lesson.instructionZh && (
                    <small className="block text-xs leading-5 text-muted-foreground">
                      {lesson.instructionZh}
                    </small>
                  )}
                </div>
              </div>
              <div className="reading-text space-y-6">
                {lesson.paragraphs.map((paragraph) => (
                  <div
                    key={paragraph.id}
                    id={`reading-${key}-paragraph-${paragraph.id}`}
                    aria-current={
                      anchor?.mode === "paragraph" &&
                      anchor.targetId === paragraph.id
                        ? "true"
                        : undefined
                    }
                    className={cn(
                      "reading-paragraph scroll-mt-8 scroll-mb-24 space-y-2 rounded-xl transition-colors",
                      anchor?.mode === "paragraph" &&
                        anchor.targetId === paragraph.id &&
                        "bg-secondary/60 ring-1 ring-primary/15",
                    )}
                  >
                    {paragraph.speaker && (
                      <p className="mb-3 text-xs font-semibold tracking-wide text-muted-foreground">
                        {paragraph.speaker}
                      </p>
                    )}
                    {paragraph.note && (
                      <p className="text-sm italic text-muted-foreground">
                        {paragraph.note}
                      </p>
                    )}
                    {paragraph.sentences.map((sentence) => (
                      <Collapsible
                        key={sentence.id}
                        open={translations.has(sentence.id)}
                        onOpenChange={(open) =>
                          setTranslations((previous) => {
                            const next = new Set(previous);
                            if (open) next.add(sentence.id);
                            else next.delete(sentence.id);
                            return next;
                          })
                        }
                        id={`reading-${key}-${sentence.id}`}
                        aria-current={
                          anchor?.mode === "sentence" &&
                          anchor.targetId === sentence.id
                            ? "true"
                            : undefined
                        }
                        className={cn(
                          "reading-sentence scroll-mt-8 scroll-mb-24 rounded-xl border border-transparent p-2 transition-colors sm:p-3",
                          (anchor?.mode === "sentence"
                            ? anchor.targetId === sentence.id
                            : current?.id === sentence.id) &&
                            "current-sentence border-primary/10 bg-secondary/60",
                          selected === sentence.id &&
                            "selected-sentence border-primary/20",
                        )}
                      >
                        <div className="flex items-start gap-1.5 sm:gap-2">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="sentence-play mt-0.5 size-8 shrink-0 rounded-full text-primary/65 hover:text-primary"
                            aria-label={`点读句子：${sentence.text}`}
                            disabled={
                              sentence.start === null || sentence.end === null
                            }
                            onClick={() => chooseSentence(sentence)}
                          >
                            <Play className="size-3.5 fill-current" />
                          </Button>
                          <div
                            data-english=""
                            data-sentence-id={sentence.id}
                            className="min-w-0 flex-1 pt-1 font-serif text-[19px] leading-9 sm:text-[21px]"
                          >
                            {sentence.words.length
                              ? sentence.words.map((word) => (
                                  <span key={word.id}>
                                    {word.before}
                                    <button
                                      className={cn(
                                        "reading-word rounded px-0.5 py-1 text-left transition-colors hover:bg-primary/10 disabled:cursor-default",
                                        currentWord?.id === word.id &&
                                          "current-word bg-primary text-white hover:bg-primary",
                                        selected === word.id &&
                                          "selected-word ring-1 ring-primary/35",
                                      )}
                                      data-word-id={word.id}
                                      aria-label={`点读单词：${word.text}`}
                                      aria-current={
                                        currentWord?.id === word.id
                                          ? "true"
                                          : undefined
                                      }
                                      aria-disabled={
                                        word.start === null || word.end === null
                                      }
                                      title={
                                        word.start === null
                                          ? "此词的原音定位正在准备"
                                          : "听这个词的课文原音"
                                      }
                                      onClick={() =>
                                        word.start !== null &&
                                        word.end !== null &&
                                        start({
                                          url: `${base}/clips/${word.id}`,
                                          kind: "word",
                                          offset: Math.max(
                                            0,
                                            word.start! - 0.015,
                                          ),
                                          id: word.id,
                                        })
                                      }
                                    >
                                      {word.text}
                                    </button>
                                  </span>
                                ))
                              : sentence.text}
                          </div>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="mt-1 size-8 shrink-0 text-primary/65"
                            aria-label={`AI 详解句子：${sentence.text}`}
                            onClick={() =>
                              onExplain({
                                kind: "sentence",
                                id: sentence.id,
                                text: sentence.text,
                              })
                            }
                          >
                            <Sparkles className="size-3.5" />
                          </Button>
                          {sentence.translationZh && (
                            <CollapsibleTrigger asChild>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="mt-1 h-8 shrink-0 gap-0.5 px-1.5 text-xs text-muted-foreground"
                                aria-label={`${translations.has(sentence.id) ? "收起" : "展开"}第 ${sentences.indexOf(sentence) + 1} 句译文`}
                              >
                                译
                                <ChevronDown
                                  className={cn(
                                    "size-3 transition-transform",
                                    translations.has(sentence.id) &&
                                      "rotate-180",
                                  )}
                                />
                              </Button>
                            </CollapsibleTrigger>
                          )}
                        </div>
                        {sentence.translationZh && (
                          <CollapsibleContent>
                            <p className="reading-translation ml-10 mt-2 border-l-2 border-chalk px-3 py-1 text-sm leading-7 text-muted-foreground">
                              {sentence.translationZh}
                            </p>
                          </CollapsibleContent>
                        )}
                      </Collapsible>
                    ))}
                  </div>
                ))}
              </div>
              {translated.length < sentences.length &&
                lesson.translation.length > 0 && (
                  <Collapsible>
                    <CollapsibleTrigger asChild>
                      <Button
                        variant="ghost"
                        className="gap-2 text-muted-foreground"
                      >
                        整课参考译文
                        <ChevronDown className="size-4" />
                      </Button>
                    </CollapsibleTrigger>
                    <CollapsibleContent className="reading-translation space-y-3 rounded-xl bg-muted/50 p-5 text-sm leading-7 text-muted-foreground">
                      {lesson.translation.map((p, i) => (
                        <p key={i}>{p}</p>
                      ))}
                    </CollapsibleContent>
                  </Collapsible>
                )}
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="vocabulary" className="reading-vocabulary m-0">
          <Card className="border-0 bg-transparent py-0 shadow-none">
            <CardContent>
              <div className="mb-4 flex items-center justify-between">
                <h2 className="font-medium">本课单词</h2>
                <span className="text-xs text-muted-foreground">
                  美音 · 单词与短语
                </span>
              </div>
              <p className="mb-2 text-xs leading-6 text-muted-foreground">
                英美音标 · 多义解释与例句 · 词形与扩展用法
              </p>
              <div className="vocabulary-list">
                {lesson.vocabulary.map((word) => (
                  <VocabularyEntry
                    key={`${lesson.book}:${lesson.lesson}:${word.id}`}
                    word={word}
                    book={lesson.book}
                    lesson={lesson.lesson}
                    selected={selected === word.id}
                    explain={() =>
                      onExplain({
                        kind: "vocabulary",
                        id: word.id,
                        text: word.word,
                      })
                    }
                    play={() =>
                      start({
                        url: `/api/pronunciations/${word.pronunciationId}`,
                        kind: "vocabulary",
                        offset: 0,
                        id: word.id,
                      })
                    }
                  />
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
      <div className="reading-dock sticky bottom-3 z-20 mt-6 rounded-xl border border-primary/15 bg-card/95 px-2 py-1 shadow-lg backdrop-blur-md">
        <div className="reading-controls flex items-center gap-1 sm:gap-2">
          <Button
            size="icon"
            className="reading-play-toggle size-10 shrink-0 rounded-full"
            aria-label={running ? "暂停精听" : "播放精听"}
            onClick={toggle}
          >
            {running ? (
              <Pause className="size-4 fill-current" />
            ) : (
              <Play className="ml-0.5 size-4 fill-current" />
            )}
          </Button>
          <TextbookTimeline
            markers={markers}
            duration={lesson.duration}
            position={position}
            seek={seek}
            seekMarker={(marker) => seek(marker.time, marker)}
          />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant={loopMode !== "off" ? "secondary" : "ghost"}
                size="sm"
                className="size-9 shrink-0 px-0"
                title={
                  loopMode === "lesson"
                    ? "整课循环"
                    : loopMode === "selection"
                      ? "选中内容循环"
                      : "关闭循环"
                }
                aria-label="循环模式"
              >
                {loopMode === "lesson" ? (
                  <Repeat className="size-4" />
                ) : loopMode === "selection" ? (
                  <Repeat1 className="size-4" />
                ) : (
                  <ArrowRight className="size-4 text-muted-foreground" />
                )}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="end">
              <DropdownMenuRadioGroup
                value={loopMode}
                onValueChange={(value) => {
                  const mode = value as LoopMode;
                  if (mode === "lesson" && source.current.kind !== "full")
                    start(
                      {
                        url: `${base}/audio`,
                        kind: "full",
                        offset: 0,
                        id: "full",
                      },
                      playIntent.current,
                    );
                  changeLoop(mode);
                }}
              >
                <DropdownMenuRadioItem value="off">
                  关闭循环
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="lesson" disabled={!loopRange}>
                  整课循环
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="selection">
                  选中内容循环
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <Select
            value={String(rate)}
            onValueChange={(value) => {
              const next = Number(value);
              rateRef.current = next;
              setRate(next);
              if (audio.current) audio.current.playbackRate = next;
              persist(true);
            }}
          >
            <SelectTrigger
              aria-label="精听倍速"
              showIcon={false}
              title="精听倍速"
              className={cn(
                buttonVariants({ variant: "ghost", size: "sm" }),
                "h-9 w-12 shrink-0 justify-center gap-0 border-0 bg-transparent px-1 text-xs tabular-nums shadow-none",
              )}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper" side="top">
              {RATES.map((value) => (
                <SelectItem value={String(value)} key={value}>
                  {value}×
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <TextbookPlayerSettings
            markers={markers}
            mode={record.markerMode}
            changeMode={(mode: MarkerMode) => {
              setFocusedMarker(null);
              save({ markerMode: mode });
            }}
            seekMarker={(marker) => seek(marker.time, marker)}
          >
            {(close) => (
              <>
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Headphones className="size-3.5" />
                  {kind === "full"
                    ? "整课音频"
                    : kind === "vocabulary"
                      ? "生词发音"
                      : kind === "word"
                        ? "单词原音"
                        : "句子原音"}
                  {record.completed && (
                    <Badge
                      variant="secondary"
                      className="ml-auto px-1.5 text-[10px]"
                    >
                      本课已学
                    </Badge>
                  )}
                </p>
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-10"
                    aria-label="上一句"
                    disabled={firstIndex <= 0}
                    onClick={() => {
                      move(-1);
                      close();
                    }}
                  >
                    <ChevronLeft className="size-4" />
                  </Button>
                  <Button
                    variant={kind === "full" ? "secondary" : "ghost"}
                    size="sm"
                    className="h-10 flex-1 gap-1.5"
                    aria-label="播放整课"
                    onClick={() => {
                      start({
                        url: `${base}/audio`,
                        kind: "full",
                        offset: 0,
                        id: "full",
                      });
                      close();
                    }}
                  >
                    <Headphones className="size-4" />
                    播放整课
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-10"
                    aria-label="下一句"
                    disabled={firstIndex === sentences.length - 1}
                    onClick={() => {
                      move(1);
                      close();
                    }}
                  >
                    <ChevronRight className="size-4" />
                  </Button>
                </div>
                {(!follow || tab !== "passage") && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full text-xs"
                    onClick={() => {
                      setTab("passage");
                      setFollow(true);
                      close();
                      setTimeout(
                        () =>
                          centerReadingAnchor(
                            `reading-${key}-${anchor?.mode === "paragraph" ? "paragraph-" : ""}${anchor?.targetId || currentRef.current}`,
                          ),
                        0,
                      );
                    }}
                  >
                    回到当前句
                  </Button>
                )}
              </>
            )}
          </TextbookPlayerSettings>
        </div>
        {error && (
          <div
            role="alert"
            className="reading-error mt-3 flex items-center justify-between gap-2 rounded-lg bg-destructive/5 px-3 text-xs text-destructive"
          >
            <p>{error}</p>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => start(source.current)}
            >
              <RotateCcw className="mr-1 size-3.5" />
              重试
            </Button>
          </div>
        )}
        {storageError && (
          <p role="status" className="mt-2 text-xs text-destructive">
            当前浏览器无法保存进度，本次学习仍可继续。
          </p>
        )}
      </div>
      {!embedded && (
        <nav
          aria-label="课文导航"
          className="reading-lesson-navigation mt-7 flex justify-between gap-4"
        >
          {lesson.lesson > 1 ? (
            <Link
              to={`/books/${lesson.book}/lessons/${lesson.lesson - step}`}
              className={cn(buttonVariants({ variant: "outline" }), "gap-2")}
            >
              <ArrowLeft className="size-4" />
              上一课
            </Link>
          ) : (
            <span />
          )}
          {lesson.lesson < [0, 143, 96, 60, 48][lesson.book] && (
            <Link
              to={`/books/${lesson.book}/lessons/${lesson.lesson + step}`}
              className={cn(buttonVariants({ variant: "outline" }), "gap-2")}
            >
              下一课
              <ChevronRight className="size-4" />
            </Link>
          )}
        </nav>
      )}
    </section>
  );
}
