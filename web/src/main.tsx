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
  RotateCcw,
  Search,
  Sparkles,
  Volume2,
  WifiOff,
} from "lucide-react";
import {
  loadProgress,
  resumePosition,
  saveProgress,
  type LessonProgress,
  type Progress,
} from "./progress";
import "./styles.css";

type Lesson = {
  id: string;
  order: number;
  label: string;
  title: string;
  duration: number;
  thumbnail: boolean;
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
    <div className="book-scene" aria-hidden="true">
      <span className="scene-orbit orbit-one" />
      <span className="scene-orbit orbit-two" />
      <div className="scene-caption">
        <span /> A LITTLE EVERY DAY.
      </div>
      <div className="book-stack stack-bottom" />
      <div className="book-stack stack-top" />
      <div className="course-book">
        <div className="book-spine" />
        <div className="book-cover">
          <div className="book-edition">
            THE FIRSTLEAP CLASSROOM <span>01</span>
          </div>
          <div className="book-rule" />
          <p>
            New
            <br />
            Concept
            <br />
            <i>English.</i>
          </p>
          <div className="book-window">
            <svg viewBox="0 0 150 132">
              <path d="M20 130V68a55 55 0 0 1 110 0v62M75 13v117M20 71h110" />
              <path d="M32 130v-21h86v21M45 109V91h60v18M58 91V76h34v15" />
              <circle cx="102" cy="43" r="10" />
            </svg>
          </div>
          <div className="book-bottom">
            <span>FIRST THINGS FIRST</span>
            <span>第一册</span>
          </div>
        </div>
      </div>
      <div className="scene-note">
        <Sparkles size={15} />
        <span>
          Great things begin
          <br />
          with a first step.
        </span>
      </div>
      <div className="scene-leaf">
        <Leaf size={46} strokeWidth={1} />
      </div>
    </div>
  );
}

function Header({ learning, home }: { learning: boolean; home: () => void }) {
  return (
    <header className="site-header">
      <div className="header-inner">
        <a
          className="brand"
          href="/"
          onClick={(e) => {
            e.preventDefault();
            home();
          }}
          aria-label="FirstLeap 首页"
        >
          <span className="brand-mark">
            <BookOpen size={23} strokeWidth={1.7} />
          </span>
          <span>
            FirstLeap<span className="brand-dot">.</span>
          </span>
        </a>
        <nav aria-label="主导航">
          <a
            className={!learning ? "nav-active" : ""}
            href="/"
            onClick={(e) => {
              e.preventDefault();
              home();
            }}
          >
            我的课堂
          </a>
          <span className="header-divider" />
          <span className="header-note">每一步，都算数。</span>
        </nav>
        <div className="learner-badge">
          <span className="learner-avatar">
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
    if (compact) activeRow.current?.scrollIntoView({ block: "nearest" });
  }, [current, compact]);
  return (
    <section
      className={`curriculum ${compact ? "compact" : ""}`}
      id="curriculum"
      aria-label="课程目录"
    >
      <div className="curriculum-heading">
        <div>
          <span className="eyebrow">THE CURRICULUM</span>
          <h2>
            一步一步，学好英语<span>{course.lessons.length} 节视频</span>
          </h2>
        </div>
        {!compact && <p>循序渐进，也可以从你感兴趣的一课开始。</p>}
      </div>
      <div className="curriculum-toolbar">
        <div className="filter-tabs" role="group" aria-label="课程筛选">
          {(
            [
              ["all", "全部课程"],
              ["unlearned", "未完成"],
              ["completed", "已完成"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              aria-pressed={filter === key}
              className={filter === key ? "active" : ""}
              onClick={() => setFilter(key)}
            >
              {label}
            </button>
          ))}
        </div>
        <label className="search-box">
          <Search size={16} />
          <input
            aria-label="搜索课号或标题"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索课号或标题"
          />
          <kbd>/</kbd>
        </label>
      </div>
      <div className="lesson-list">
        {lessons.map((l) => {
          const saved = progress.lessons[l.id];
          const selected = current === l.id;
          const percentage = saved?.duration
            ? Math.min(100, (saved.position / saved.duration) * 100)
            : 0;
          return (
            <button
              key={l.id}
              ref={selected ? activeRow : undefined}
              className={`lesson-row ${selected ? "selected" : ""} ${saved?.completed ? "completed" : ""}`}
              onClick={() => select(l.id)}
              aria-current={selected ? "true" : undefined}
            >
              <span className="lesson-number">
                {selected ? (
                  <Volume2 size={18} />
                ) : saved?.completed ? (
                  <Check size={17} />
                ) : (
                  String(l.order).padStart(2, "0")
                )}
              </span>
              {!compact && (
                <span className="lesson-thumb">
                  {l.thumbnail ? (
                    <img
                      src={`/api/lessons/${l.id}/thumbnail`}
                      loading="lazy"
                      alt=""
                    />
                  ) : (
                    <BookOpen size={24} strokeWidth={1.2} />
                  )}
                  <span className="thumb-play">
                    <Play size={14} fill="currentColor" />
                  </span>
                </span>
              )}
              <span className="lesson-copy">
                <span className="lesson-label">
                  {l.label}
                  {l.label === "导学课" && <em>从这里开始</em>}
                </span>
                <span className="lesson-title">{l.title}</span>
                {percentage > 0 && !saved.completed && (
                  <span className="mini-progress">
                    <span style={{ width: `${percentage}%` }} />
                  </span>
                )}
              </span>
              <span className="lesson-meta">
                {saved?.completed ? (
                  <span className="done-label">已完成</span>
                ) : selected ? (
                  <span className="playing-label">正在学习</span>
                ) : saved?.position > 0 ? (
                  <span className="learning-label">继续学习</span>
                ) : null}
                <span className="lesson-duration">
                  {l.duration ? time(l.duration) : "—"}
                </span>
              </span>
              {!compact && (
                <span className="row-arrow">
                  <ArrowUpRightIcon />
                </span>
              )}
            </button>
          );
        })}
      </div>
      {lessons.length === 0 && (
        <div className="empty-list">
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
            <button
              onClick={() => {
                setQuery("");
                setFilter("all");
              }}
            >
              查看全部课程
            </button>
          )}
        </div>
      )}
      {!compact && (
        <div className="curriculum-foot">
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
    <main className="page overview">
      <div className="page-kicker">
        <span>
          <span className="status-dot" /> YOUR PERSONAL CLASSROOM
        </span>
        <span>保持好奇，慢慢来。</span>
      </div>
      <section className="hero">
        <div className="hero-copy">
          <div className="course-tags">
            <span>经典课程</span>
            <span>入门 · A1–A2</span>
          </div>
          <h1>
            每一段新旅程，
            <br />
            始于
            <span className="hero-emphasis">
              第一步。
              <svg viewBox="0 0 265 12" preserveAspectRatio="none">
                <path d="M3 8Q130 0 262 6" />
              </svg>
            </span>
          </h1>
          <p className="hero-description">
            从一句问候，到自信表达。
            <br />
            在你的专属课堂，让英语学习成为日常。
          </p>
          <div className="hero-course">
            <span className="small-book">
              <BookOpen size={20} />
            </span>
            <div>
              <h2>{course.title}</h2>
              <p>
                新东方 · 霍娜老师 <span>系统精讲</span>
              </p>
            </div>
          </div>
          <div className="hero-actions">
            <button
              className="button primary"
              disabled={!resume || !course.sourceAvailable}
              onClick={() => resume && select(resume.id)}
            >
              <Play size={17} fill="currentColor" />
              {started ? "继续我的学习" : "开始第一课"}
              <ArrowRight size={18} />
            </button>
            <a href="#curriculum" className="text-link">
              浏览课程目录
              <ArrowDown size={15} />
            </a>
          </div>
          <div className="hero-trust">
            <span className="tiny-avatars">
              <i>H</i>
              <i>A</i>
              <i>你</i>
            </span>
            <span>不必很快，只要一直向前。</span>
          </div>
        </div>
        <BookIllustration />
      </section>
      <section className="course-facts" aria-label="课程概览">
        <div>
          <span className="fact-icon">
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
          <span className="fact-icon">
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
          <span className="fact-icon">
            <GraduationCap size={23} />
          </span>
          <span>
            <strong>循序渐进</strong>
            <span>听懂 · 理解 · 开口表达</span>
          </span>
        </div>
        <div>
          <span className="fact-icon">
            <Bookmark size={20} />
          </span>
          <span>
            <strong>按你的节奏</strong>
            <span>随时暂停，下次接着学</span>
          </span>
        </div>
      </section>
      <div className="content-grid">
        <div className="main-column">
          <div className="section-intro">
            <div>
              <span className="eyebrow">A FOUNDATION FOR YOUR FUTURE</span>
              <h2>打好基础，让表达自然发生。</h2>
            </div>
            <p>{course.description}</p>
          </div>
          <CourseList course={course} progress={progress} select={select} />
        </div>
        <aside className="study-aside">
          <section className="progress-card">
            <div className="card-topline">
              <span>我的学习旅程</span>
              <Leaf size={18} />
            </div>
            <div
              className="progress-ring"
              style={
                { "--progress": `${percent * 3.6}deg` } as React.CSSProperties
              }
            >
              <div>
                <strong>
                  {percent}
                  <small>%</small>
                </strong>
                <span>课程完成度</span>
              </div>
            </div>
            <div className="progress-count">
              <strong>
                {completed}
                <span> / {course.lessons.length}</span>
              </strong>
              <span>已完成课节</span>
            </div>
            <div className="aside-divider" />
            <p>
              {completed === course.lessons.length && completed > 0
                ? "全课完成！每一次坚持，都让你离目标更近。"
                : started
                  ? "欢迎回来。今天，也向前一步。"
                  : "不需要准备好一切，\n开始，就是最好的准备。"}
            </p>
            {resume && (
              <button
                className="button outlined"
                disabled={!course.sourceAvailable}
                onClick={() => select(resume.id)}
              >
                {started ? "接着上次学" : "开启学习旅程"}
                <ArrowRight size={16} />
              </button>
            )}
            <span className="local-note">学习进度保存在当前浏览器</span>
          </section>
          <section className="quote-card">
            <span className="quote-mark">“</span>
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
            <span className="quote-signature">
              THE FIRSTLEAP WAY <span>✳</span>
            </span>
          </section>
        </aside>
      </div>
    </main>
  );
}

function Player({
  lesson,
  progress,
  update,
  onEnded,
  autoplay,
}: {
  lesson: Lesson;
  progress?: LessonProgress;
  update: UpdateProgress;
  onEnded: () => void;
  autoplay: boolean;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const saved = useRef(progress);
  const updateRef = useRef(update);
  updateRef.current = update;
  const lastSave = useRef(0);
  const [rate, setRate] = useState(1);
  const [error, setError] = useState(false);
  const [waiting, setWaiting] = useState(false);
  useEffect(() => {
    const el = video.current;
    const persist = () => {
      if (el && Number.isFinite(el.duration) && el.currentTime > 0)
        updateRef.current(
          lesson.id,
          { position: el.currentTime, duration: el.duration },
          true,
        );
    };
    const visibility = () => {
      if (document.visibilityState === "hidden") persist();
    };
    window.addEventListener("pagehide", persist);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      persist();
      window.removeEventListener("pagehide", persist);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [lesson.id]);
  const persist = () => {
    const el = video.current;
    if (el && Number.isFinite(el.duration))
      update(
        lesson.id,
        { position: el.currentTime, duration: el.duration },
        true,
      );
  };
  return (
    <>
      <div className="video-shell">
        <video
          ref={video}
          controls
          playsInline
          preload="metadata"
          autoPlay={autoplay}
          poster={
            lesson.thumbnail ? `/api/lessons/${lesson.id}/thumbnail` : undefined
          }
          src={`/api/lessons/${lesson.id}/video`}
          aria-label={lesson.title}
          onLoadedMetadata={() => {
            const el = video.current;
            if (el) {
              el.currentTime = resumePosition(saved.current, el.duration);
              el.playbackRate = rate;
            }
            setError(false);
          }}
          onTimeUpdate={() => {
            if (Date.now() - lastSave.current >= 5000) {
              persist();
              lastSave.current = Date.now();
            }
          }}
          onSeeked={persist}
          onPause={persist}
          onWaiting={() => setWaiting(true)}
          onPlaying={() => {
            setWaiting(false);
            setError(false);
          }}
          onCanPlay={() => setWaiting(false)}
          onError={() => {
            setError(true);
            setWaiting(false);
          }}
          onEnded={() => {
            const el = video.current;
            update(
              lesson.id,
              {
                completed: true,
                position: el?.duration || lesson.duration,
                duration: el?.duration || lesson.duration,
              },
              true,
            );
            onEnded();
          }}
        />
        {waiting && !error && (
          <div className="video-loading" role="status">
            <LoaderCircle className="spin" size={26} />
            <span>正在缓冲…</span>
          </div>
        )}
        {error && (
          <div className="video-error" role="alert">
            <WifiOff size={30} />
            <h3>视频暂时无法播放</h3>
            <p>请检查连接后重试，学习进度已为你保留。</p>
            <button
              className="button"
              onClick={() => {
                setError(false);
                video.current?.load();
              }}
            >
              <RotateCcw size={16} />
              重新加载
            </button>
          </div>
        )}
      </div>
      <div className="player-tools">
        <span>
          <Volume2 size={15} />
          跟随自己的节奏
        </span>
        <label>
          播放速度
          <select
            aria-label="播放速度"
            value={rate}
            onChange={(e) => {
              const speed = Number(e.target.value);
              setRate(speed);
              if (video.current) video.current.playbackRate = speed;
            }}
          >
            {[0.75, 1, 1.25, 1.5, 1.75, 2].map((speed) => (
              <option key={speed} value={speed}>
                {speed}×
              </option>
            ))}
          </select>
        </label>
      </div>
    </>
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
  const completed = progress.lessons[lesson.id]?.completed;
  return (
    <main className="page classroom">
      <div className="breadcrumb">
        <button onClick={home}>
          <ArrowLeft size={15} />
          我的课堂
        </button>
        <ChevronRight size={14} />
        <span>{course.title}</span>
        <ChevronRight size={14} />
        <span>{lesson.label}</span>
      </div>
      <div className="classroom-grid">
        <section className="watch-column">
          <Player
            key={lesson.id}
            lesson={lesson}
            progress={progress.lessons[lesson.id]}
            update={update}
            autoplay={autoplay}
            onEnded={() => {
              if (continuous && course.lessons[index + 1])
                select(course.lessons[index + 1].id);
            }}
          />
          <div className="watch-heading">
            <div>
              <span className="eyebrow">{lesson.label.toUpperCase()}</span>
              <h1>{lesson.title}</h1>
              <p>
                <span className="teacher-avatar">霍</span>霍娜老师
                <span className="dot-separator">·</span>新东方
                <span className="dot-separator">·</span>
                {lesson.duration ? time(lesson.duration) : "课程视频"}
              </p>
            </div>
            <button
              className={`complete-button ${completed ? "is-complete" : ""}`}
              aria-pressed={Boolean(completed)}
              onClick={() =>
                update(lesson.id, {
                  completed: !completed,
                  position: progress.lessons[lesson.id]?.position || 0,
                })
              }
            >
              <CheckCircle2 size={18} />
              {completed ? "已完成" : "标记完成"}
            </button>
          </div>
          <div className="lesson-navigation">
            <button
              disabled={index <= 0}
              onClick={() => select(course.lessons[index - 1].id)}
            >
              <ChevronLeft size={18} />
              <span>
                <small>上一节</small>
                {course.lessons[index - 1]?.label || "这是第一节课"}
              </span>
            </button>
            <label className="continuous-label">
              <input
                type="checkbox"
                checked={continuous}
                onChange={(e) => setContinuous(e.target.checked)}
              />
              <span className="toggle" />
              连续播放
            </label>
            <button
              disabled={index === course.lessons.length - 1}
              onClick={() => select(course.lessons[index + 1].id)}
            >
              <span>
                <small>下一节</small>
                {course.lessons[index + 1]?.label || "已到最后一节"}
              </span>
              <ChevronRight size={18} />
            </button>
          </div>
          <div className="learning-note">
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
        <aside className="classroom-aside">
          <div className="playlist-heading">
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
    setId(next);
    window.scrollTo({ top: 0 });
  };
  const lesson = course?.lessons.find((l) => l.id === id);
  useEffect(() => {
    document.title = lesson
      ? `${lesson.label} · ${lesson.title} | FirstLeap`
      : "FirstLeap · 一课一步，学有所获";
  }, [lesson]);
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
        <div className="notice" role="status">
          浏览器暂时无法保存进度；本次学习仍可正常进行。
        </div>
      )}
      {(failed || (course && !course.sourceAvailable && !course.indexing)) && (
        <div className="notice" role="alert">
          <WifiOff size={17} />
          <span>
            {failed
              ? "暂时无法连接课堂，请检查网络。"
              : "课程视频源暂时不可用，学习进度仍然保留。"}
          </span>
          <button onClick={() => void refresh()}>重试</button>
        </div>
      )}
      {loading ? (
        <div className="page-state">
          <LoaderCircle className="spin" size={30} />
          <h1>正在打开你的课堂…</h1>
        </div>
      ) : !course ? (
        <div className="page-state">
          <BookOpen size={36} />
          <h1>课堂暂时无法加载</h1>
          <p>请稍后重试。</p>
          <button className="button primary" onClick={() => void refresh()}>
            重新加载
          </button>
        </div>
      ) : id && !lesson ? (
        <div className="page-state">
          <BookOpen size={36} />
          <h1>{course.indexing ? "正在整理这节课程…" : "没有找到这节课"}</h1>
          <p>你可以回到课程目录，重新选择一节课。</p>
          <button className="button primary" onClick={() => navigate("")}>
            返回课程目录
          </button>
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
      <footer className="site-footer">
        <a
          className="footer-brand"
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
        <span className="footer-end">
          MADE FOR YOUR NEXT CHAPTER <span>↗</span>
        </span>
      </footer>
    </>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
