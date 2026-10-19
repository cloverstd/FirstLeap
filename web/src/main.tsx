import { startProgressSync } from "./progressSync";
import "./ai.css";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Bookmark,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  GraduationCap,
  Leaf,
  ListVideo,
  LoaderCircle,
  Play,
  Search,
  Sparkles,
  Volume2,
  WifiOff,
} from "lucide-react";
import {
  loadProgress,
  saveProgress,
  type LessonProgress,
  type Progress,
} from "./progress";
import "./styles.css";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress as ProgressBar } from "@/components/ui/progress";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { LearningPlayer } from "./LearningPlayer";
import { Textbooks, TextbookLesson } from "./Textbooks";

const AISettings = React.lazy(() =>
  import("./AISettings").then((module) => ({ default: module.AISettings })),
);
const LearnerProfile = React.lazy(() =>
  import("./LearnerProfile").then((module) => ({
    default: module.LearnerProfile,
  })),
);

type Lesson = {
  id: string;
  order: number;
  label: string;
  title: string;
  duration: number;
  thumbnail: boolean;
  textbook?: { book: number; lesson: number };
};
type Course = {
  id: string;
  title: string;
  teacher: string;
  description: string;
  lessons: Lesson[];
  duration: number;
  sourceAvailable: boolean;
  indexing: boolean;
};
type UpdateProgress = (
  id: string,
  patch: Partial<LessonProgress>,
  markLast?: boolean,
) => void;

function time(seconds: number) {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
function lessonFromPath() {
  return window.location.pathname.startsWith("/learn/")
    ? decodeURIComponent(window.location.pathname.slice(7))
    : "";
}

function BookIllustration() {
  return (
    <div
      className="relative mx-auto hidden h-96 w-full max-w-sm items-center justify-center lg:flex         "
      aria-hidden="true"
    >
      <div className="absolute inset-8 rounded-full border border-primary/10 bg-secondary/50      " />
      <div className="absolute bottom-6 left-12 right-4 h-64 rotate-8 rounded-xl border border-primary/15 bg-[#c8d6c2] shadow-lg           " />
      <div className="relative flex h-80 w-60 -rotate-6 flex-col rounded-r-2xl rounded-l-md border-l-8 border-black/15 bg-primary p-7 text-white shadow-xl              ">
        <span className="text-[9px] tracking-[.2em] text-white/65   ">
          THE FIRSTLEAP CLASSROOM
        </span>
        <span className="mt-7 font-serif text-4xl leading-tight    ">
          New
          <br />
          Concept
          <br />
          <i className="text-chalk">English.</i>
        </span>
        <BookOpen className="mt-6 size-12 text-white/55   " strokeWidth={1} />
        <span className="mt-auto flex justify-between border-t border-white/20 pt-4 text-[9px] tracking-wide        ">
          <span>FIRST THINGS FIRST</span>
          <span>01</span>
        </span>
      </div>
      <div className="absolute -right-4 bottom-3 flex rotate-3 items-center gap-2 rounded-xl border border-chalk/40 bg-[#fff9e9] px-4 py-3 text-xs text-primary shadow-sm                ">
        <Sparkles className="size-4" />
        每天一点，每一步都算数。
      </div>
    </div>
  );
}

function Header({ learning, home }: { learning: boolean; home: () => void }) {
  return (
    <header className="site-header border-b bg-card/80">
      <div className="header-inner page-shell flex min-h-20 flex-wrap items-center gap-x-8 gap-y-3 py-4">
        <a
          className="brand flex items-center gap-2.5 font-serif text-2xl font-bold tracking-tight text-primary"
          href="/"
          onClick={(e) => {
            e.preventDefault();
            home();
          }}
          aria-label="FirstLeap 首页"
        >
          <span className="brand-mark grid size-9 place-items-center rounded-xl bg-primary text-white">
            <BookOpen size={23} strokeWidth={1.7} />
          </span>
          <span>
            FirstLeap<span className="brand-dot text-primary/40">.</span>
          </span>
        </a>
        <nav
          aria-label="主导航"
          className="flex items-center gap-2 [&>a]:rounded-lg [&>a]:px-3 [&>a]:py-2 [&>a]:text-xs"
        >
          <a
            className={
              !learning && window.location.pathname === "/"
                ? "nav-active bg-secondary text-primary font-medium"
                : "text-muted-foreground"
            }
            href="/"
            onClick={(e) => {
              e.preventDefault();
              home();
            }}
          >
            我的课堂
          </a>
          <a
            href="/books"
            className={
              window.location.pathname.startsWith("/books")
                ? "nav-active bg-secondary text-primary font-medium"
                : "text-muted-foreground"
            }
          >
            课程
          </a>
          <a
            href="/learning-profile"
            className={
              window.location.pathname === "/learning-profile"
                ? "nav-active bg-secondary text-primary font-medium"
                : "text-muted-foreground"
            }
          >
            学习档案
          </a>
          <a
            href="/settings"
            className={
              window.location.pathname === "/settings"
                ? "nav-active bg-secondary text-primary font-medium"
                : "text-muted-foreground"
            }
          >
            系统配置
          </a>
          <span className="header-divider hidden h-3 w-px bg-border sm:block" />
          <span className="header-note hidden text-xs text-muted-foreground md:block">
            每一步，都算数。
          </span>
        </nav>
        <div className="learner-badge ml-auto hidden items-center gap-2 text-xs text-muted-foreground sm:flex">
          <span className="learner-avatar grid size-8 place-items-center rounded-full border bg-secondary text-primary">
            <GraduationCap size={19} />
          </span>
          <span>终身学习者</span>
        </div>
      </div>
    </header>
  );
}

function CourseList({
  course,
  progress,
  current,
  select,
  compact = false,
}: {
  course: Course;
  progress: Progress;
  current?: string;
  select: (id: string) => void;
  compact?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "unlearned" | "completed">(
    "all",
  );
  const normalized = query
    .toLowerCase()
    .replace(/\s/g, "")
    .replace(/\b0+(\d)/g, "$1");
  const lessons = course.lessons.filter((l) => {
    const done = progress.lessons[l.id]?.completed;
    return (
      (filter === "all" || (filter === "completed" ? done : !done)) &&
      `${l.label} ${l.title} ${l.order}`
        .toLowerCase()
        .replace(/\s/g, "")
        .includes(normalized)
    );
  });
  const activeRow = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const row = activeRow.current;
    const list = row?.closest<HTMLElement>(".lesson-list");
    if (compact && row && list) {
      // Scroll only the playlist. scrollIntoView also moves the mobile page away from the player.
      list.scrollTop +=
        row.getBoundingClientRect().top -
        list.getBoundingClientRect().top -
        (list.clientHeight - row.clientHeight) / 2;
    }
  }, [current, compact]);
  return (
    <section
      className={cn(
        "curriculum scroll-mt-8",
        compact
          ? "compact [&_.curriculum-heading]:hidden [&_.lesson-list]:max-h-[65vh] [&_.lesson-list]:overflow-y-auto"
          : "overflow-hidden rounded-2xl border bg-card",
      )}
      id="curriculum"
      aria-label="课程目录"
    >
      <div className="curriculum-heading flex flex-wrap items-end justify-between gap-2 p-5 [&_h2]:mt-2 [&_h2]:text-lg [&_h2]:font-medium [&_h2_span]:ml-3 [&_h2_span]:text-xs [&_h2_span]:font-normal [&_h2_span]:text-muted-foreground [&>p]:text-xs [&>p]:text-muted-foreground">
        <div>
          <span className="eyebrow text-[10px] tracking-[.15em] text-muted-foreground">
            THE CURRICULUM
          </span>
          <h2>
            一步一步，学好英语<span>{course.lessons.length} 节视频</span>
          </h2>
        </div>
        {!compact && <p>循序渐进，也可以从你感兴趣的一课开始。</p>}
      </div>
      <div className="curriculum-toolbar flex flex-wrap items-center gap-3 border-y bg-muted/30 px-4 py-3">
        <div
          className="filter-tabs flex shrink-0 items-center gap-1 rounded-lg bg-muted p-1 [&>button]:h-8 [&>button]:px-2 [&>button]:text-xs"
          role="group"
          aria-label="课程筛选"
        >
          {(
            [
              ["all", "全部课程"],
              ["unlearned", "未完成"],
              ["completed", "已完成"],
            ] as const
          ).map(([key, label]) => (
            <Button
              variant="ghost"
              key={key}
              aria-pressed={filter === key}
              className={cn(
                "rounded-md",
                filter === key && "active bg-card text-primary shadow-sm",
              )}
              onClick={() => setFilter(key)}
            >
              {label}
            </Button>
          ))}
        </div>
        <label className="search-box flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded-lg border bg-card px-3 text-muted-foreground [&>input]:h-9 [&>input]:min-w-0 [&>input]:w-full [&>input]:border-0 [&>input]:bg-transparent [&>input]:p-0 [&>input]:text-xs [&>input]:shadow-none [&>input]:outline-none [&>kbd]:text-[10px]">
          <Search size={16} />
          <Input
            aria-label="搜索课号或标题"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索课号或标题"
          />
          <kbd>/</kbd>
        </label>
      </div>
      <div className="lesson-list divide-y divide-border">
        {lessons.map((l) => {
          const saved = progress.lessons[l.id];
          const selected = current === l.id;
          const percentage = saved?.duration
            ? Math.min(100, (saved.position / saved.duration) * 100)
            : 0;
          return (
            <Button
              variant="ghost"
              key={l.id}
              ref={selected ? activeRow : undefined}
              className={cn(
                "lesson-row group flex h-auto min-h-20 w-full items-center justify-start gap-3 rounded-none px-4 py-4 text-left transition-colors hover:bg-secondary/40",
                selected && "selected bg-secondary/65",
                saved?.completed && "completed",
              )}
              onClick={() => select(l.id)}
              aria-current={selected ? "true" : undefined}
            >
              <span className="lesson-number grid size-8 shrink-0 place-items-center rounded-lg bg-secondary/70 text-xs font-medium text-primary group-aria-current:bg-primary group-aria-current:text-white">
                {selected ? (
                  <Volume2 size={18} />
                ) : saved?.completed ? (
                  <Check size={17} />
                ) : (
                  String(l.order).padStart(2, "0")
                )}
              </span>
              {!compact && (
                <span className="lesson-thumb relative hidden h-12 w-20 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-secondary/50 text-primary/60 sm:flex [&>img]:size-full [&>img]:object-cover">
                  {l.thumbnail ? (
                    <img
                      src={`/api/lessons/${l.id}/thumbnail`}
                      loading="lazy"
                      alt=""
                    />
                  ) : (
                    <BookOpen size={24} strokeWidth={1.2} />
                  )}
                  <span className="thumb-play absolute inset-0 flex items-center justify-center bg-black/10 text-white opacity-0 transition-opacity group-hover:opacity-100">
                    <Play size={14} fill="currentColor" />
                  </span>
                </span>
              )}
              <span className="lesson-copy flex min-w-0 flex-1 flex-col items-start gap-1 text-left">
                <span className="lesson-label text-[11px] font-medium text-primary [&>em]:ml-2 [&>em]:rounded [&>em]:bg-chalk/30 [&>em]:px-1.5 [&>em]:py-0.5 [&>em]:text-[10px] [&>em]:not-italic">
                  {l.label}
                  {l.label === "导学课" && <em>从这里开始</em>}
                </span>
                <span className="lesson-title max-w-full truncate text-xs font-normal text-muted-foreground">
                  {l.title}
                </span>
                {percentage > 0 && !saved.completed && (
                  <ProgressBar
                    className="mt-1 h-1 w-24"
                    value={percentage}
                    aria-label="本课进度"
                  />
                )}
              </span>
              <span className="lesson-meta ml-auto flex shrink-0 flex-col items-end gap-1 text-[10px] font-normal">
                {saved?.completed ? (
                  <span className="done-label text-primary">已完成</span>
                ) : selected ? (
                  <span className="playing-label text-primary">正在学习</span>
                ) : saved?.position > 0 ? (
                  <span className="learning-label text-primary">继续学习</span>
                ) : null}
                <span className="lesson-duration tabular-nums text-muted-foreground">
                  {l.duration ? time(l.duration) : "—"}
                </span>
              </span>
              {!compact && (
                <span className="row-arrow hidden text-muted-foreground sm:block">
                  <ArrowUpRightIcon />
                </span>
              )}
            </Button>
          );
        })}
      </div>
      {lessons.length === 0 && (
        <div className="empty-list flex flex-col items-center gap-3 px-5 py-12 text-center text-sm text-muted-foreground">
          <Search size={24} />
          <p>
            {query
              ? "没有找到这节课，换个关键词试试。"
              : filter === "completed"
                ? "还没有完成的课程。从第一课开始吧。"
                : course.indexing
                  ? "正在整理课程，请稍候…"
                  : "这里暂时没有课程。"}
          </p>
          {(query || filter !== "all") && (
            <Button
              variant="ghost"
              onClick={() => {
                setQuery("");
                setFilter("all");
              }}
            >
              查看全部课程
            </Button>
          )}
        </div>
      )}
      {!compact && (
        <div className="curriculum-foot flex items-center gap-2 border-t p-4 text-xs text-muted-foreground [&>span:last-child]:ml-auto">
          <BookOpen size={15} />
          <span>一点一滴积累，一课一课进步。</span>
          <span>
            {lessons.length} / {course.lessons.length} 节
          </span>
        </div>
      )}
    </section>
  );
}
function ArrowUpRightIcon() {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <path d="M6 18 18 6M6 6h12v12" />
    </svg>
  );
}

function Overview({
  course,
  progress,
  select,
}: {
  course: Course;
  progress: Progress;
  select: (id: string) => void;
}) {
  const completed = course.lessons.filter(
    (l) => progress.lessons[l.id]?.completed,
  ).length;
  const resume =
    course.lessons.find(
      (l) => l.id === progress.lastLesson && !progress.lessons[l.id]?.completed,
    ) ||
    course.lessons.find((l) => !progress.lessons[l.id]?.completed) ||
    course.lessons[0];
  const started = Object.keys(progress.lessons).some(
    (id) =>
      course.lessons.some((l) => l.id === id) &&
      progress.lessons[id].position > 0,
  );
  const percent = course.lessons.length
    ? Math.round((completed / course.lessons.length) * 100)
    : 0;
  return (
    <main className="page overview page-shell pb-12">
      <div className="page-kicker my-7 flex justify-between gap-3 text-[10px] tracking-wider text-muted-foreground [&>span:first-child]:flex [&>span:first-child]:items-center [&>span:first-child]:gap-2">
        <span>
          <span className="status-dot inline-block size-1.5 rounded-full bg-primary" />{" "}
          YOUR PERSONAL CLASSROOM
        </span>
        <span>保持好奇，慢慢来。</span>
      </div>
      <section className="hero grid items-center gap-10 rounded-3xl border border-primary/10 bg-[#edf1e7] p-6 sm:p-10 lg:grid-cols-[1.2fr_1fr] lg:p-12">
        <div className="hero-copy space-y-6 [&>h1]:font-serif [&>h1]:text-4xl [&>h1]:leading-tight [&>h1]:tracking-tight sm:[&>h1]:text-5xl lg:[&>h1]:text-6xl">
          <div className="course-tags flex items-center gap-2 text-[11px] [&>span]:rounded-full [&>span]:border [&>span]:border-primary/15 [&>span]:bg-white/50 [&>span]:px-2.5 [&>span]:py-1 [&>span]:text-primary">
            <span>经典课程</span>
            <span>入门 · A1–A2</span>
          </div>
          <h1>
            每一段新旅程，
            <br />
            始于
            <span className="hero-emphasis relative inline-block text-primary [&>svg]:absolute [&>svg]:-bottom-1 [&>svg]:left-0 [&>svg]:h-2 [&>svg]:w-full [&_path]:fill-none [&_path]:stroke-chalk [&_path]:stroke-5">
              第一步。
              <svg viewBox="0 0 265 12" preserveAspectRatio="none">
                <path d="M3 8Q130 0 262 6" />
              </svg>
            </span>
          </h1>
          <p className="hero-description text-sm leading-7 text-muted-foreground sm:text-base">
            从一句问候，到自信表达。
            <br />
            在你的专属课堂，让英语学习成为日常。
          </p>
          <div className="hero-course flex items-center gap-3 [&_h2]:font-semibold [&_p]:mt-1 [&_p]:text-xs [&_p]:text-muted-foreground [&_p_span]:ml-2">
            <span className="small-book grid size-11 place-items-center rounded-xl border border-primary/10 bg-white/60 text-primary">
              <BookOpen size={20} />
            </span>
            <div>
              <h2>{course.title}</h2>
              <p>
                新东方 · 霍娜老师 <span>系统精讲</span>
              </p>
            </div>
          </div>
          <div className="hero-actions flex flex-wrap items-center gap-5">
            <Button
              variant="default"
              className="button primary inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50 bg-primary text-white hover:bg-primary/90"
              disabled={!resume || !course.sourceAvailable}
              onClick={() => resume && select(resume.id)}
            >
              <Play size={17} fill="currentColor" />
              {started ? "继续我的学习" : "开始第一课"}
              <ArrowRight size={18} />
            </Button>
            <a
              href="#curriculum"
              className="text-link inline-flex items-center gap-2 text-sm text-primary hover:underline"
            >
              浏览课程目录
              <ArrowDown size={15} />
            </a>
          </div>
          <div className="hero-trust flex items-center gap-3 text-xs text-muted-foreground">
            <span className="tiny-avatars hidden">
              <i>H</i>
              <i>A</i>
              <i>你</i>
            </span>
            <span>不必很快，只要一直向前。</span>
          </div>
        </div>
        <BookIllustration />
      </section>
      <section
        className="course-facts my-8 grid grid-cols-2 gap-5 rounded-2xl border bg-card px-5 py-6 sm:px-7 lg:grid-cols-4 [&>div]:flex [&>div]:items-center [&>div]:gap-3 [&_strong]:block [&_strong]:font-semibold [&_strong_small]:text-xs [&_strong_small]:font-normal [&>div>span:last-child>span]:mt-1 [&>div>span:last-child>span]:block [&>div>span:last-child>span]:text-[11px] [&>div>span:last-child>span]:text-muted-foreground"
        aria-label="课程概览"
      >
        <div>
          <span className="fact-icon hidden size-10 shrink-0 place-items-center rounded-xl bg-secondary text-primary sm:grid">
            <ListVideo size={21} />
          </span>
          <span>
            <strong>
              {course.lessons.length || "—"} <small>节视频</small>
            </strong>
            <span>从导学到完整课程</span>
          </span>
        </div>
        <div>
          <span className="fact-icon hidden size-10 shrink-0 place-items-center rounded-xl bg-secondary text-primary sm:grid">
            <Clock3 size={21} />
          </span>
          <span>
            <strong>
              {course.duration && course.lessons.every((l) => l.duration > 0)
                ? (course.duration / 3600).toFixed(1)
                : "—"}{" "}
              <small>小时</small>
            </strong>
            <span>把知识讲透，把基础打牢</span>
          </span>
        </div>
        <div>
          <span className="fact-icon hidden size-10 shrink-0 place-items-center rounded-xl bg-secondary text-primary sm:grid">
            <GraduationCap size={23} />
          </span>
          <span>
            <strong>循序渐进</strong>
            <span>听懂 · 理解 · 开口表达</span>
          </span>
        </div>
        <div>
          <span className="fact-icon hidden size-10 shrink-0 place-items-center rounded-xl bg-secondary text-primary sm:grid">
            <Bookmark size={20} />
          </span>
          <span>
            <strong>按你的节奏</strong>
            <span>随时暂停，下次接着学</span>
          </span>
        </div>
      </section>
      <div className="content-grid grid items-start gap-7 lg:grid-cols-[minmax(0,1fr)_270px]">
        <div className="main-column min-w-0">
          <div className="section-intro mb-6 space-y-3 [&_h2]:mt-2 [&_h2]:text-xl [&_h2]:font-medium [&>p]:text-sm [&>p]:leading-6 [&>p]:text-muted-foreground">
            <div>
              <span className="eyebrow text-[10px] tracking-[.15em] text-muted-foreground">
                A FOUNDATION FOR YOUR FUTURE
              </span>
              <h2>打好基础，让表达自然发生。</h2>
            </div>
            <p>{course.description}</p>
          </div>
          <CourseList course={course} progress={progress} select={select} />
        </div>
        <aside className="study-aside grid gap-5 sm:grid-cols-2 lg:sticky lg:top-6 lg:grid-cols-1">
          <section className="progress-card rounded-2xl border bg-card p-6 shadow-sm [&>p]:my-4 [&>p]:whitespace-pre-line [&>p]:text-xs [&>p]:leading-6 [&>p]:text-muted-foreground">
            <div className="card-topline mb-5 flex items-center justify-between text-sm font-medium">
              <span>我的学习旅程</span>
              <Leaf size={18} />
            </div>
            <div className="space-y-3">
              <span className="text-4xl font-semibold text-primary">
                {percent}
                <small className="ml-1 text-lg font-normal">%</small>
              </span>
              <ProgressBar value={percent} aria-label="课程完成度" />
              <p className="text-xs text-muted-foreground">课程完成度</p>
            </div>
            <div className="progress-count my-4 flex items-center justify-between text-xs text-muted-foreground [&>strong]:text-2xl [&>strong]:font-medium [&>strong]:text-primary [&>strong>span]:text-sm [&>strong>span]:text-muted-foreground">
              <strong>
                {completed}
                <span> / {course.lessons.length}</span>
              </strong>
              <span>已完成课节</span>
            </div>
            <div className="aside-divider my-4 h-px bg-border" />
            <p>
              {completed === course.lessons.length && completed > 0
                ? "全课完成！每一次坚持，都让你离目标更近。"
                : started
                  ? "欢迎回来。今天，也向前一步。"
                  : "不需要准备好一切，\n开始，就是最好的准备。"}
            </p>
            {resume && (
              <Button
                variant="outline"
                className="button outlined inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50 border bg-card hover:bg-secondary"
                disabled={!course.sourceAvailable}
                onClick={() => select(resume.id)}
              >
                {started ? "接着上次学" : "开启学习旅程"}
                <ArrowRight size={16} />
              </Button>
            )}
            <span className="local-note mt-3 block text-center text-[10px] text-muted-foreground">
              学习进度保存在当前浏览器
            </span>
          </section>
          <section className="quote-card rounded-2xl border border-chalk/30 bg-[#fbf5e4] p-6 [&>p]:font-serif [&>p]:text-xl [&>p]:leading-8 [&>small]:mt-3 [&>small]:block [&>small]:text-xs [&>small]:text-muted-foreground">
            <span className="quote-mark font-serif text-5xl leading-none text-primary/30">
              “
            </span>
            <blockquote>
              A little progress
              <br />
              each day adds up
              <br />
              to <i>big results.</i>
            </blockquote>
            <p>
              每天进步一点点，
              <br />
              时间会给你答案。
            </p>
            <span className="quote-signature mt-5 block text-[10px] tracking-wider text-muted-foreground">
              THE FIRSTLEAP WAY <span>✳</span>
            </span>
          </section>
        </aside>
      </div>
    </main>
  );
}

function Classroom({
  course,
  lesson,
  progress,
  update,
  select,
  home,
  autoplay,
}: {
  course: Course;
  lesson: Lesson;
  progress: Progress;
  update: UpdateProgress;
  select: (id: string) => void;
  home: () => void;
  autoplay: boolean;
}) {
  const [continuous, setContinuous] = useState(false);
  const index = course.lessons.findIndex((l) => l.id === lesson.id);
  const [mode, setMode] = useState(() => {
    try {
      if (
        lesson.textbook &&
        localStorage.getItem("firstleap.player-mode.v1") === "text"
      )
        return "text";
      return "lecture";
    } catch {
      return "lecture";
    }
  });
  const isText = mode === "text" && Boolean(lesson.textbook);
  const activeProgress = progress.lessons[lesson.id];
  const completed = activeProgress?.completed;
  return (
    <main className="page classroom page-shell pb-12">
      <div className="breadcrumb my-6 flex flex-wrap items-center gap-2 text-xs text-muted-foreground [&>button]:h-auto [&>button]:gap-1 [&>button]:px-0 [&>button]:text-xs">
        <Button variant="ghost" onClick={home}>
          <ArrowLeft size={15} />
          我的课堂
        </Button>
        <ChevronRight size={14} />
        <span>{course.title}</span>
        <ChevronRight size={14} />
        <span>{lesson.label}</span>
      </div>
      <div
        className={cn(
          "classroom-grid grid items-start gap-7",
          isText ? "classroom-text-mode" : "xl:grid-cols-[minmax(0,1fr)_310px]",
        )}
      >
        <section className="watch-column min-w-0">
          {lesson.textbook && (
            <div
              className="player-modes mb-4 flex flex-wrap items-center gap-1 rounded-xl border bg-card p-1.5 [&>button]:px-3 [&>button]:text-xs [&>span]:ml-auto [&>span]:hidden [&>span]:px-2 [&>span]:text-[10px] [&>span]:text-muted-foreground sm:[&>span]:block"
              role="group"
              aria-label="学习模式"
            >
              <Button
                variant="ghost"
                className={cn(
                  "min-h-10",
                  !isText && "selected bg-secondary text-primary",
                )}
                aria-pressed={!isText}
                onClick={() => {
                  setMode("lecture");
                  try {
                    localStorage.setItem("firstleap.player-mode.v1", "lecture");
                  } catch {
                    /* Playback remains available. */
                  }
                }}
              >
                课程讲解
              </Button>
              {lesson.textbook && (
                <Button
                  variant="ghost"
                  className={cn(
                    "min-h-10",
                    isText && "selected bg-secondary text-primary",
                  )}
                  aria-pressed={isText}
                  onClick={() => {
                    setMode("text");
                    try {
                      localStorage.setItem("firstleap.player-mode.v1", "text");
                    } catch {
                      /* Optional preference. */
                    }
                  }}
                >
                  课文精听
                </Button>
              )}
            </div>
          )}
          {isText && lesson.textbook ? (
            <TextbookLesson
              key={`${lesson.textbook.book}:${lesson.textbook.lesson}`}
              book={lesson.textbook.book}
              lesson={lesson.textbook.lesson}
              embedded
            />
          ) : (
            <LearningPlayer
              key={lesson.id}
              progressID={lesson.id}
              source={`/api/lessons/${lesson.id}/video`}
              poster={
                lesson.thumbnail
                  ? `/api/lessons/${lesson.id}/thumbnail`
                  : undefined
              }
              title={lesson.title}
              continuous={continuous}
              onContinuousChange={setContinuous}
              progress={activeProgress}
              update={update}
              autoplay={autoplay}
              onEnded={() => {
                if (continuous && course.lessons[index + 1])
                  select(course.lessons[index + 1].id);
              }}
            />
          )}
          {!isText && (
            <div className="watch-heading my-7 flex flex-wrap items-start justify-between gap-4 [&_h1]:mt-2 [&_h1]:text-2xl [&_h1]:font-medium [&_p]:mt-3 [&_p]:flex [&_p]:items-center [&_p]:text-xs [&_p]:text-muted-foreground">
              <div>
                <span className="eyebrow text-[10px] tracking-[.15em] text-muted-foreground">
                  {lesson.label.toUpperCase()}
                </span>
                <h1>{lesson.title}</h1>
                <p>
                  <span className="teacher-avatar mr-2 grid size-6 place-items-center rounded-full bg-secondary text-[10px] text-primary">
                    霍
                  </span>
                  霍娜老师
                  <span className="dot-separator mx-2 text-border">·</span>
                  新东方
                  <span className="dot-separator mx-2 text-border">·</span>
                  {lesson.duration ? time(lesson.duration) : "课程视频"}
                </p>
              </div>
              <Button
                variant="ghost"
                className={cn(
                  "complete-button min-h-11 gap-2 border",
                  completed
                    ? "is-complete bg-secondary text-primary"
                    : "bg-card",
                )}
                aria-pressed={Boolean(completed)}
                onClick={() =>
                  update(lesson.id, {
                    completed: !completed,
                    position: activeProgress?.position || 0,
                  })
                }
              >
                <CheckCircle2 size={18} />
                {completed ? "已完成" : "标记完成"}
              </Button>
            </div>
          )}
          <div className="lesson-navigation mt-6 grid grid-cols-2 gap-3 [&>button]:h-auto [&>button]:min-h-16 [&>button]:justify-start [&>button]:gap-2 [&>button]:border [&>button]:bg-card [&>button]:px-3 [&>button]:text-left [&>button:last-child]:justify-end [&>button:last-child]:text-right [&_span]:flex [&_span]:flex-col [&_span]:gap-1 [&_span]:text-xs [&_small]:font-normal [&_small]:text-muted-foreground">
            <Button
              variant="ghost"
              disabled={index <= 0}
              onClick={() => select(course.lessons[index - 1].id)}
            >
              <ChevronLeft size={18} />
              <span>
                <small>上一节</small>
                {course.lessons[index - 1]?.label || "这是第一节课"}
              </span>
            </Button>
            <Button
              variant="ghost"
              disabled={index === course.lessons.length - 1}
              onClick={() => select(course.lessons[index + 1].id)}
            >
              <span>
                <small>下一节</small>
                {course.lessons[index + 1]?.label || "已到最后一节"}
              </span>
              <ChevronRight size={18} />
            </Button>
          </div>
          <div className="learning-note mt-6 flex items-start gap-3 rounded-xl bg-secondary/50 p-5 text-primary [&_strong]:text-sm [&_strong]:font-medium [&_p]:mt-2 [&_p]:text-xs [&_p]:leading-6 [&_p]:text-muted-foreground">
            <span>
              <Leaf size={19} />
            </span>
            <div>
              <strong>给学习留一点回味的时间。</strong>
              <p>
                听懂之后，不妨暂停一下，试着跟读、复述，让新知识真正成为自己的。
              </p>
            </div>
          </div>
        </section>
        <aside className="classroom-aside overflow-hidden rounded-2xl border bg-card xl:sticky xl:top-6">
          <div className="playlist-heading flex items-center gap-2 border-b bg-secondary/40 p-4 text-xs font-medium [&>strong]:ml-auto [&>strong]:font-medium [&_small]:font-normal [&_small]:text-muted-foreground">
            <BookOpen size={18} />
            <span>{course.title}</span>
            <strong>
              {index + 1}
              <small> / {course.lessons.length}</small>
            </strong>
          </div>
          <CourseList
            course={course}
            progress={progress}
            current={lesson.id}
            select={select}
            compact
          />
        </aside>
      </div>
    </main>
  );
}

function App() {
  const [pathname, setPathname] = useState(window.location.pathname);
  const utilityPage =
    pathname === "/settings" || pathname === "/learning-profile";
  const [syncStatus, setSyncStatus] = useState("");
  useEffect(() => {
    const stop = startProgressSync();
    const listener = (event: Event) =>
      setSyncStatus((event as CustomEvent<string>).detail);
    window.addEventListener("progress-sync-status", listener);
    return () => {
      stop();
      window.removeEventListener("progress-sync-status", listener);
    };
  }, []);
  const [course, setCourse] = useState<Course | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [id, setId] = useState(lessonFromPath);
  const [progress, setProgress] = useState(loadProgress);
  const [storageError, setStorageError] = useState(false);
  const [autoplay, setAutoplay] = useState(false);
  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/courses/ncese01", {
        signal: AbortSignal.timeout(12000),
      });
      if (!res.ok) throw new Error();
      const value = (await res.json()) as Course;
      setCourse(value);
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 15000);
    return () => clearInterval(timer);
  }, [refresh]);
  useEffect(() => {
    const listener = () => {
      setPathname(window.location.pathname);
      setId(lessonFromPath());
      setAutoplay(false);
    };
    window.addEventListener("popstate", listener);
    return () => window.removeEventListener("popstate", listener);
  }, []);
  useEffect(() => {
    const listener = (e: StorageEvent) => {
      if (e.key === "firstleap.progress.v1") setProgress(loadProgress());
    };
    window.addEventListener("storage", listener);
    return () => window.removeEventListener("storage", listener);
  }, []);
  const update = useCallback<UpdateProgress>(
    (lessonId, patch, markLast = false) => {
      setProgress((previous) => {
        const next: Progress = {
          ...previous,
          lastLesson: markLast ? lessonId : previous.lastLesson,
          lessons: {
            ...previous.lessons,
            [lessonId]: {
              ...(previous.lessons[lessonId] ?? {
                position: 0,
                duration: 0,
                completed: false,
              }),
              ...patch,
              updatedAt: Date.now(),
            },
          },
        };
        if (!saveProgress(next)) queueMicrotask(() => setStorageError(true));
        return next;
      });
    },
    [],
  );
  const navigate = (next: string) => {
    window.history.pushState(
      {},
      "",
      next ? `/learn/${encodeURIComponent(next)}` : "/",
    );
    setAutoplay(Boolean(next));
    setPathname(window.location.pathname);
    setId(next);
    window.scrollTo({ top: 0 });
  };
  const lesson = course?.lessons.find((l) => l.id === id);
  useEffect(() => {
    if (pathname === "/settings" || pathname === "/learning-profile") {
      document.title = `${pathname === "/settings" ? "系统配置" : "学习档案"} | FirstLeap`;
      return;
    }
    if (pathname.startsWith("/books")) {
      document.title = "课程与精听 | FirstLeap";
      return;
    }
    document.title = lesson
      ? `${lesson.label} · ${lesson.title} | FirstLeap`
      : "FirstLeap · 一课一步，学有所获";
  }, [lesson, pathname]);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (
        e.key === "/" &&
        !(e.target instanceof HTMLInputElement) &&
        !(e.target instanceof HTMLTextAreaElement)
      ) {
        e.preventDefault();
        document.querySelector<HTMLInputElement>(".search-box input")?.focus();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
  return (
    <>
      <Header learning={Boolean(id)} home={() => navigate("")} />
      {storageError && (
        <div
          className="notice my-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-secondary p-4 text-xs text-primary"
          role="status"
        >
          浏览器暂时无法保存进度；本次学习仍可正常进行。
        </div>
      )}
      {!utilityPage &&
        !pathname.startsWith("/books") &&
        (failed || (course && !course.sourceAvailable && !course.indexing)) && (
          <div
            className="notice my-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-secondary p-4 text-xs text-primary"
            role="alert"
          >
            <WifiOff size={17} />
            <span>
              {failed
                ? "暂时无法连接课堂，请检查网络。"
                : "课程视频源暂时不可用，学习进度仍然保留。"}
            </span>
            <Button variant="ghost" onClick={() => void refresh()}>
              重试
            </Button>
          </div>
        )}
      {pathname === "/settings" ? (
        <React.Suspense
          fallback={
            <main className="ai-page page-shell">正在打开系统配置…</main>
          }
        >
          <AISettings />
        </React.Suspense>
      ) : pathname === "/learning-profile" ? (
        <React.Suspense
          fallback={
            <main className="ai-page page-shell">正在打开学习档案…</main>
          }
        >
          <LearnerProfile />
        </React.Suspense>
      ) : pathname.startsWith("/books") ? (
        <Textbooks pathname={pathname} />
      ) : loading ? (
        <div className="page-state page-shell flex min-h-[60vh] flex-col items-center justify-center gap-4 text-center text-muted-foreground [&_h1]:text-xl [&_p]:text-sm">
          <LoaderCircle className="spin animate-spin" size={30} />
          <h1>正在打开你的课堂…</h1>
        </div>
      ) : !course ? (
        <div className="page-state page-shell flex min-h-[60vh] flex-col items-center justify-center gap-4 text-center text-muted-foreground [&_h1]:text-xl [&_p]:text-sm">
          <BookOpen size={36} />
          <h1>课堂暂时无法加载</h1>
          <p>请稍后重试。</p>
          <Button
            variant="default"
            className="button primary inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50 bg-primary text-white hover:bg-primary/90"
            onClick={() => void refresh()}
          >
            重新加载
          </Button>
        </div>
      ) : id && !lesson ? (
        <div className="page-state page-shell flex min-h-[60vh] flex-col items-center justify-center gap-4 text-center text-muted-foreground [&_h1]:text-xl [&_p]:text-sm">
          <BookOpen size={36} />
          <h1>{course.indexing ? "正在整理这节课程…" : "没有找到这节课"}</h1>
          <p>你可以回到课程目录，重新选择一节课。</p>
          <Button
            variant="default"
            className="button primary inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50 bg-primary text-white hover:bg-primary/90"
            onClick={() => navigate("")}
          >
            返回课程目录
          </Button>
        </div>
      ) : lesson ? (
        <Classroom
          course={course}
          lesson={lesson}
          progress={progress}
          update={update}
          select={navigate}
          home={() => navigate("")}
          autoplay={autoplay}
        />
      ) : (
        <Overview course={course} progress={progress} select={navigate} />
      )}
      <footer className="site-footer page-shell mt-8 flex flex-wrap items-center gap-4 border-t py-7 text-[11px] text-muted-foreground [&>span:nth-child(2)]:hidden sm:[&>span:nth-child(2)]:block">
        <a
          className="footer-brand flex items-center gap-2 font-serif text-lg font-semibold text-primary"
          href="/"
          onClick={(e) => {
            e.preventDefault();
            navigate("");
          }}
        >
          <BookOpen size={18} />
          FirstLeap.
        </a>
        <span>一课一步，学有所获。</span>
        {syncStatus && (
          <span className="sync-status" aria-label="学习进度同步状态">
            {syncStatus}
          </span>
        )}
        <span className="footer-end ml-auto flex items-center gap-2">
          MADE FOR YOUR NEXT CHAPTER <span>↗</span>
        </span>
      </footer>
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    <App />
  </TooltipProvider>,
);
