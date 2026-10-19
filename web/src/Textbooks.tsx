import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  ArrowLeft,
  BookOpen,
  ChevronLeft,
  ChevronRight,
  Download,
  Headphones,
  Pause,
  Play,
  Repeat,
  Volume2,
} from "lucide-react";
import { claimMedia, MEDIA_EVENT } from "./mediaCoordinator";
import { RATES, readPosition, writePosition } from "./textbookProgress";
import "./textbooks.css";

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
  start: number | null;
  end: number | null;
  words: TextWord[];
};
type TextLesson = {
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
  vocabulary: {
    id: string;
    word: string;
    pos: string;
    meaning: string;
    pronunciationId: string;
    ready: boolean;
  }[];
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
const bookNames = ["", "英语初阶", "实践与进步", "培养技能", "流利英语"];
const clock = (s: number) =>
  `${Math.floor(Math.max(0, s) / 60)}:${String(Math.floor(Math.max(0, s) % 60)).padStart(2, "0")}`;
export function navigateBook(path: string) {
  history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
  window.scrollTo({ top: 0 });
}
function Link({
  to,
  children,
  className,
}: {
  to: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <a
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
    <div className="textbook-state" role="status">
      <BookOpen size={32} />
      <p>{error || "正在打开课本…"}</p>
      {error && (
        <button className="button outlined" onClick={retry}>
          重新加载
        </button>
      )}
    </div>
  );
}

export function Textbooks({ pathname }: { pathname: string }) {
  const parts = pathname.split("/").filter(Boolean);
  const book = Number(parts[1]);
  const lesson = Number(parts[3]);
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
      <main className="page">
        <Loading
          error="没有找到这本教材或课文"
          retry={() => navigateBook("/books")}
        />
      </main>
    );
  return (
    <main className="page textbook-page">
      <div className="breadcrumb">
        <Link to="/books">
          <BookOpen size={15} />
          电子书
        </Link>
        {book > 0 && (
          <>
            <ChevronRight size={14} />
            <Link to={`/books/${book}`}>
              第{["", "一", "二", "三", "四"][book]}册 · {bookNames[book]}
            </Link>
          </>
        )}
        {lesson > 0 && (
          <>
            <ChevronRight size={14} />
            <span>
              {book === 1
                ? `Lesson ${lesson} & ${lesson + 1}`
                : `Lesson ${lesson}`}
            </span>
          </>
        )}
      </div>
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
  if (!books) return <Loading error={error} retry={retry} />;
  return (
    <>
      <div className="textbook-intro">
        <span className="eyebrow">READ. LISTEN. UNDERSTAND.</span>
        <h1>让每一个词，都听得清楚。</h1>
        <p>从第一句问候开始，点读、精听，在熟悉的课文里积累表达。</p>
      </div>
      <div className="bookshelf">
        {books.map((b) => (
          <Link
            key={b.book}
            to={`/books/${b.book}`}
            className={`textbook-cover cover-${b.book}`}
          >
            <span>NEW CONCEPT ENGLISH</span>
            <strong>0{b.book}</strong>
            <h2>{bookNames[b.book]}</h2>
            <p>{b.subtitleEn || "New Concept English"}</p>
            <div>
              <Headphones size={17} />
              {b.available
                ? `${b.lessonCount} 课 · 课文与美音精听`
                : "教材正在准备"}
              <ChevronRight size={18} />
            </div>
          </Link>
        ))}
      </div>
      <p className="textbook-footnote">
        学习记录保存在当前浏览器。第一册按课文合并展示相邻两课。
      </p>
    </>
  );
}
function BookContents({ book }: { book: number }) {
  const { value, error, retry } = useResource<Book>(`/api/books/${book}`);
  const [query, setQuery] = useState("");
  if (!value) return <Loading error={error} retry={retry} />;
  const lessons = value.lessons.filter((l) =>
    `${l.label} ${l.titleEn} ${l.titleZh}`
      .toLowerCase()
      .includes(query.toLowerCase().trim()),
  );
  return (
    <>
      <div className="textbook-intro">
        <span className="eyebrow">{value.subtitleEn}</span>
        <h1>{value.name}</h1>
        <p>{value.lessonCount} 课 · 原音点读 · 逐词跟随</p>
      </div>
      <div className="book-actions">
        <input
          aria-label="搜索课文"
          placeholder="搜索课号或课文标题"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="book-downloads">
          <Download size={16} />
          {value.downloads.map((format) => (
            <a key={format} href={`/api/books/${book}/downloads/${format}`}>
              {format.toUpperCase()}
            </a>
          ))}
        </div>
      </div>
      <div className="textbook-contents">
        {lessons.map((l) => {
          const progress = readPosition(`${book}:${l.lesson}`);
          return (
            <Link
              key={l.lesson}
              to={`/books/${book}/lessons/${l.lesson}`}
              className="textbook-lesson-card"
            >
              <span>{l.label}</span>
              <div>
                <h2>{l.titleEn}</h2>
                <p>{l.titleZh}</p>
              </div>
              <small>
                {progress.completed
                  ? "已听完"
                  : progress.position > 0
                    ? `继续 · ${clock(progress.position)}`
                    : clock(l.duration)}
              </small>
              <ChevronRight size={18} />
            </Link>
          );
        })}
      </div>
      {lessons.length === 0 && (
        <p className="textbook-footnote">没有找到课文，换个关键词试试。</p>
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
    <ReadingRoom
      key={`${book}:${lesson}:${value.revision}`}
      lesson={value}
      embedded={embedded}
    />
  );
}

function ReadingRoom({
  lesson,
  embedded,
}: {
  lesson: TextLesson;
  embedded: boolean;
}) {
  const base = `/api/books/${lesson.book}/lessons/${lesson.lesson}`;
  const key = `${lesson.book}:${lesson.lesson}`;
  const [initialPosition] = useState(() => readPosition(key));
  const saved = useRef(initialPosition);
  const audio = useRef<HTMLAudioElement>(null);
  const source = useRef<Source>({
    url: `${base}/audio`,
    kind: "full",
    offset: 0,
    id: "full",
  });
  const generation = useRef(0);
  // The user's play intent stays active during the gap between repeats.
  const playIntent = useRef(false);
  const repeatTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loopRef = useRef(false);
  const rateRef = useRef(saved.current.rate);
  const fullPosition = useRef(
    saved.current.position >= lesson.duration - 0.2
      ? 0
      : saved.current.position,
  );
  const lastSave = useRef(0);
  const [position, setPosition] = useState(fullPosition.current);
  const [playing, setPlaying] = useState(false);
  const [running, setRunning] = useState(false);
  const [loop, setLoop] = useState(false);
  const [rate, setRate] = useState(rateRef.current);
  const [selected, setSelected] = useState("");
  const [kind, setKind] = useState<Source["kind"]>("full");
  const [error, setError] = useState("");
  const [storageError, setStorageError] = useState(false);
  const [tab, setTab] = useState("passage");
  const [follow, setFollow] = useState(true);
  const [showTranslation, setShowTranslation] = useState(false);
  const sentences = lesson.paragraphs.flatMap((p) => p.sentences);
  const instruction =
    lesson.question && lesson.instruction.endsWith(lesson.question)
      ? lesson.instruction.slice(0, -lesson.question.length).trim()
      : lesson.instruction;
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
  const currentRef = useRef(current?.id || saved.current.sentence);
  currentRef.current = current?.id || currentRef.current;
  const firstIndex = sentences.findIndex(
    (s) =>
      s.id ===
      (current?.id ||
        (position >= (sentences[0]?.start ?? 0) ? currentRef.current : "")),
  );
  const persist = () => {
    saved.current = {
      ...saved.current,
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
        )?.id || saved.current.sentence,
    };
    if (!writePosition(key, saved.current)) setStorageError(true);
  };
  const clearRepeat = () => {
    if (repeatTimer.current !== null) clearTimeout(repeatTimer.current);
    repeatTimer.current = null;
  };
  const stop = () => {
    playIntent.current = false;
    setRunning(false);
    generation.current++;
    clearRepeat();
    audio.current?.pause();
    setPlaying(false);
  };
  const play = () => {
    const media = audio.current;
    if (!media) return;
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
        setError("播放未能开始，点击重试继续。");
        setPlaying(false);
      }
    });
  };
  const start = (next: Source, autoplay = true, seek?: number) => {
    if (
      source.current.kind === "full" &&
      audio.current &&
      audio.current.readyState >= 1
    ) {
      fullPosition.current = audio.current.currentTime;
      persist();
    }
    if (seek !== undefined) fullPosition.current = seek;
    else if (
      next.kind === "full" &&
      fullPosition.current >= lesson.duration - 0.2
    )
      fullPosition.current = 0;
    stop();
    setError("");
    source.current = next;
    if (next.kind !== "vocabulary") setTab("passage");
    setKind(next.kind);
    setSelected(next.id === "full" ? "" : next.id);
    const media = audio.current;
    if (!media) return;
    media.src = next.url;
    media.load();
    media.playbackRate = rateRef.current;
    media.preservesPitch = true;
    if (next.kind !== "vocabulary")
      setPosition(next.kind === "full" ? fullPosition.current : next.offset);
    if (autoplay) play();
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
    const absolute = source.current.offset + media.currentTime;
    setPosition(absolute);
    if (source.current.kind === "full") {
      fullPosition.current = media.currentTime;
      if (Date.now() - lastSave.current > 2000) {
        persist();
        lastSave.current = Date.now();
      }
    }
  };
  const chooseSentence = (sentence: TextSentence) => {
    if (sentence.start === null || sentence.end === null) return;
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
    if (next) chooseSentence(next);
  };
  const toggle = () => {
    if (playIntent.current) stop();
    else {
      if (error) start(source.current);
      else play();
    }
  };
  useEffect(() => {
    const media = audio.current!;
    media.src = source.current.url;
    media.load();
    const onOtherMedia = (event: Event) => {
      if ((event as CustomEvent).detail !== media) stop();
    };
    const onHide = () => persist();
    window.addEventListener(MEDIA_EVENT, onOtherMedia);
    window.addEventListener("pagehide", onHide);
    return () => {
      playIntent.current = false;
      generation.current++;
      if (repeatTimer.current !== null) clearTimeout(repeatTimer.current);
      persist();
      media.pause();
      media.removeAttribute("src");
      media.load();
      window.removeEventListener(MEDIA_EVENT, onOtherMedia);
      window.removeEventListener("pagehide", onHide);
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
    if (!follow || !playing || !current) return;
    document
      .getElementById(`reading-${key}-${current.id}`)
      ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [current?.id, follow, playing, key]);
  useEffect(() => {
    const manual = (event: Event) => {
      if (
        event.type === "touchmove" &&
        event.target instanceof Element &&
        event.target.closest(".reading-dock")
      )
        return;
      setFollow(false);
    };
    const keyboardScroll = (event: globalThis.KeyboardEvent) => {
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLSelectElement
      )
        return;
      if (
        ["PageDown", "PageUp", "Home", "End", "ArrowDown", "ArrowUp"].includes(
          event.code,
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
    if (!audio.current?.ended || !playIntent.current) return;
    setPlaying(false);
    tick();
    if (source.current.kind === "full") {
      playIntent.current = false;
      setRunning(false);
      fullPosition.current = lesson.duration;
      saved.current.completed = true;
      persist();
      return;
    }
    if (!loopRef.current) {
      playIntent.current = false;
      setRunning(false);
      return;
    }
    const token = generation.current;
    repeatTimer.current = setTimeout(() => {
      repeatTimer.current = null;
      if (
        token !== generation.current ||
        !playIntent.current ||
        !loopRef.current ||
        !audio.current
      )
        return;
      audio.current.currentTime = 0;
      play();
    }, 500);
  };
  const keyDown = (e: KeyboardEvent) => {
    if (
      e.target instanceof HTMLInputElement ||
      e.target instanceof HTMLSelectElement ||
      e.target instanceof HTMLButtonElement ||
      e.target instanceof HTMLAnchorElement
    )
      return;
    if (e.code === "Space") {
      e.preventDefault();
      toggle();
    }
    if (e.code === "ArrowLeft") {
      e.preventDefault();
      move(-1);
    }
    if (e.code === "ArrowRight") {
      e.preventDefault();
      move(1);
    }
  };
  const maxLesson = [0, 143, 96, 60, 48][lesson.book];
  const step = lesson.book === 1 ? 2 : 1;
  return (
    <section
      className={`reading-room ${embedded ? "embedded-reading" : ""}`}
      aria-label="课文精听"
      tabIndex={0}
      onKeyDown={keyDown}
    >
      <audio
        ref={audio}
        data-testid="textbook-audio"
        preload="metadata"
        onLoadedMetadata={() => {
          const media = audio.current!;
          media.playbackRate = rateRef.current;
          media.preservesPitch = true;
          if (source.current.kind === "full")
            media.currentTime = Math.min(
              fullPosition.current,
              media.duration || lesson.duration,
            );
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
          if (!media.paused) return;
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
            persist();
          }
        }}
        onTimeUpdate={tick}
        onSeeked={tick}
        onEnded={onEnded}
        onError={() => {
          stop();
          setError("音频暂时无法播放，点击重试。");
        }}
      />
      <header className="reading-heading">
        <div>
          <span className="eyebrow">{lesson.label} · 课文精听</span>
          <h1>{lesson.titleEn}</h1>
          <p>{lesson.titleZh}</p>
        </div>
        <div className="reading-heading-links">
          {lesson.lectureLessonId && (
            <a href={`/learn/${lesson.lectureLessonId}`}>
              观看讲解 <ChevronRight size={15} />
            </a>
          )}
          {embedded && (
            <Link to={`/books/${lesson.book}/lessons/${lesson.lesson}`}>
              打开电子书 <BookOpen size={15} />
            </Link>
          )}
        </div>
      </header>
      <div className="reading-tabs" role="tablist" aria-label="阅读内容">
        <button
          role="tab"
          aria-selected={tab === "passage"}
          onClick={() => setTab("passage")}
        >
          课文
        </button>
        <button
          role="tab"
          aria-selected={tab === "vocabulary"}
          onClick={() => setTab("vocabulary")}
        >
          生词 · {lesson.vocabulary.length}
        </button>
      </div>
      <div className={`reading-columns tab-${tab}`}>
        <div className="reading-passage">
          <div className="reading-question">
            <Headphones size={20} />
            <div>
              <small>{instruction}</small>
              <p>{lesson.question}</p>
              {lesson.instructionZh && <small>{lesson.instructionZh}</small>}
            </div>
          </div>
          <div className="reading-text">
            {lesson.paragraphs.map((paragraph) => (
              <div className="reading-paragraph" key={paragraph.id}>
                {paragraph.speaker && (
                  <span className="reading-speaker">{paragraph.speaker}</span>
                )}
                {paragraph.note && (
                  <p className="reading-note">{paragraph.note}</p>
                )}
                {paragraph.sentences.map((sentence) => (
                  <span
                    key={sentence.id}
                    id={`reading-${key}-${sentence.id}`}
                    className={`reading-sentence ${current?.id === sentence.id ? "current-sentence" : ""} ${selected === sentence.id ? "selected-sentence" : ""}`}
                  >
                    <button
                      className="sentence-play"
                      aria-label={`点读句子：${sentence.text}`}
                      disabled={sentence.start === null}
                      onClick={() => chooseSentence(sentence)}
                    >
                      <Play size={14} fill="currentColor" />
                    </button>
                    {sentence.words.map((word) => (
                      <span key={word.id}>
                        {word.before}
                        <button
                          className={`reading-word ${currentWord?.id === word.id ? "current-word" : ""} ${selected === word.id ? "selected-word" : ""}`}
                          aria-label={`点读单词：${word.text}`}
                          aria-current={
                            currentWord?.id === word.id ? "true" : undefined
                          }
                          disabled={word.start === null || word.end === null}
                          title={
                            word.start === null
                              ? "此词的原音定位正在准备"
                              : "听这个词的课文原音"
                          }
                          onClick={() =>
                            start({
                              url: `${base}/clips/${word.id}`,
                              kind: "word",
                              offset: Math.max(0, word.start! - 0.015),
                              id: word.id,
                            })
                          }
                        >
                          {word.text}
                        </button>
                      </span>
                    ))}{" "}
                  </span>
                ))}
              </div>
            ))}
          </div>
          <button
            className="translation-toggle"
            aria-expanded={showTranslation}
            onClick={() => setShowTranslation((v) => !v)}
          >
            {showTranslation ? "收起中文译文" : "展开中文译文"}
          </button>
          {showTranslation && (
            <div className="reading-translation">
              {lesson.translation.map((p, i) => (
                <p key={i}>{p}</p>
              ))}
            </div>
          )}
        </div>
        <aside className="reading-vocabulary">
          <h2>
            本课生词 <span>{lesson.vocabulary.length}</span>
          </h2>
          <p className="vocabulary-caption">美音 · 单词与短语</p>
          {lesson.vocabulary.map((word) => (
            <div
              className={`vocabulary-entry ${selected === word.id ? "selected-vocabulary" : ""}`}
              key={word.id}
            >
              <div>
                <strong>{word.word}</strong>
                <small>{word.pos}</small>
                <p>{word.meaning}</p>
              </div>
              <button
                disabled={!word.ready}
                aria-label={`生词发音：${word.word}`}
                title={word.ready ? "播放美音词音" : "词音正在准备"}
                onClick={() =>
                  start({
                    url: `/api/pronunciations/${word.pronunciationId}`,
                    kind: "vocabulary",
                    offset: 0,
                    id: word.id,
                  })
                }
              >
                <Volume2 size={18} />
              </button>
            </div>
          ))}
        </aside>
      </div>
      <div className="reading-dock">
        <div className="reading-status">
          <span>
            {kind === "full"
              ? current
                ? "正在听课文"
                : "整课音频"
              : kind === "vocabulary"
                ? "生词发音"
                : kind === "word"
                  ? "单词原音"
                  : "句子原音"}
          </span>
          <span>
            {clock(position)} / {clock(lesson.duration)}
          </span>
          {!follow && (
            <button
              onClick={() => {
                setTab("passage");
                setFollow(true);
                document
                  .getElementById(`reading-${key}-${currentRef.current}`)
                  ?.scrollIntoView({ block: "center", behavior: "smooth" });
              }}
            >
              回到当前句
            </button>
          )}
        </div>
        <input
          type="range"
          aria-label="课文音频进度"
          min={0}
          max={lesson.duration}
          step={0.05}
          value={Math.min(position, lesson.duration)}
          onChange={(e) => {
            const resume = running;
            setLoop(false);
            loopRef.current = false;
            start(
              { url: `${base}/audio`, kind: "full", offset: 0, id: "full" },
              resume,
              Number(e.target.value),
            );
          }}
        />
        <div className="reading-controls">
          <button
            className="reading-play-toggle"
            aria-label={running ? "暂停精听" : "播放精听"}
            onClick={toggle}
          >
            {running ? <Pause size={20} /> : <Play size={20} />}
          </button>
          <button
            aria-label="上一句"
            disabled={firstIndex <= 0}
            onClick={() => move(-1)}
          >
            <ChevronLeft size={19} />
            <span>上一句</span>
          </button>
          <button
            aria-label="下一句"
            disabled={firstIndex === sentences.length - 1}
            onClick={() => move(1)}
          >
            <ChevronRight size={19} />
            <span>下一句</span>
          </button>
          <button
            aria-label="播放整课"
            onClick={() => {
              setLoop(false);
              loopRef.current = false;
              start({
                url: `${base}/audio`,
                kind: "full",
                offset: 0,
                id: "full",
              });
            }}
          >
            <Headphones size={18} />
            <span>播放整课</span>
          </button>
          <button
            role="switch"
            aria-checked={loop}
            aria-label="循环选中内容"
            className={loop ? "loop-active" : ""}
            onClick={() => {
              loopRef.current = !loop;
              setLoop(!loop);
              if (loop && repeatTimer.current !== null) stop();
            }}
          >
            <Repeat size={18} />
            <span>循环选中</span>
          </button>
          <label className="reading-rate">
            <span>倍速</span>
            <select
              aria-label="精听倍速"
              value={rate}
              onChange={(e) => {
                const value = Number(e.target.value);
                rateRef.current = value;
                setRate(value);
                if (audio.current) audio.current.playbackRate = value;
                persist();
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
        {error && (
          <p className="reading-error" role="alert">
            {error}
            <button onClick={() => start(source.current)}>重试</button>
          </p>
        )}
        {storageError && (
          <p role="status">当前浏览器无法保存进度，本次学习仍可继续。</p>
        )}
      </div>
      {!embedded && (
        <div className="reading-lesson-navigation">
          {lesson.lesson > 1 ? (
            <Link to={`/books/${lesson.book}/lessons/${lesson.lesson - step}`}>
              <ArrowLeft size={16} />
              上一课
            </Link>
          ) : (
            <span />
          )}
          {lesson.lesson < maxLesson && (
            <Link to={`/books/${lesson.book}/lessons/${lesson.lesson + step}`}>
              下一课
              <ChevronRight size={16} />
            </Link>
          )}
        </div>
      )}
    </section>
  );
}
