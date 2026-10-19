import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Sparkles,
  RotateCcw,
  Image as ImageIcon,
  BookOpen,
  ThumbsUp,
  ArrowLeft,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  api,
  explanationBasis,
  useJob,
  type AITarget,
  type AIImage,
  type Explanation,
  type JobState,
} from "./ai";
import type { TextLesson } from "./Textbooks";

const AIMarkdown = lazy(() => import("./AIMarkdown"));
const AISpeechPlayer = lazy(() => import("./AISpeechPlayer"));

type Lookup = {
  cached: boolean;
  result: Explanation;
  history: Explanation[];
  jobId: string;
};
function ImageControl({
  image,
  onUpdate,
}: {
  image: AIImage;
  onUpdate: (image: AIImage) => void;
}) {
  const [jobId, setJobId] = useState(""),
    [error, setError] = useState("");
  const job = useJob(jobId, (state) => {
    if (state.status === "done") onUpdate(state.result as AIImage);
    else setError(state.error || "图片生成失败");
    setJobId("");
  });
  return (
    <div className="ai-image-control">
      <span>
        <ImageIcon size={14} />
        {image.caption || "教学配图"}
      </span>
      <Button
        size="sm"
        variant="ghost"
        disabled={!!jobId}
        onClick={() => {
          setError("");
          void api<{ jobId: string }>(`/api/ai/images/${image.id}/regenerate`, {
            method: "POST",
            body: "{}",
          })
            .then((v) => setJobId(v.jobId))
            .catch((e) => setError(e.message));
        }}
      >
        <RotateCcw size={13} />
        {job?.status === "running"
          ? "正在生图…"
          : image.version
            ? "重新生成图片"
            : "重试图片"}
      </Button>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
function ExplanationPanel({
  lesson,
  target,
  back,
  active,
}: {
  lesson: TextLesson;
  target: AITarget;
  back: () => void;
  active: () => Record<string, unknown>;
}) {
  const [feedbackJob, setFeedbackJob] = useState("");
  const [result, setResult] = useState<Explanation | null>(null),
    [history, setHistory] = useState<Explanation[]>([]),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [jobId, setJobId] = useState(""),
    [feedback, setFeedback] = useState(""),
    [dimension, setDimension] = useState("");
  useJob(feedbackJob, (state) => {
    setFeedback(
      state.status === "done"
        ? "能力档案已根据反馈更新，下一次生成会使用新档案。"
        : state.error || "反馈已保存，能力评估失败；再次提交反馈可以重试。",
    );
  });
  const identity = `${lesson.book}:${lesson.lesson}:${JSON.stringify(target)}`;
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const lookup = async (autoGenerate = false) => {
    const current = identity;
    setLoading(true);
    setError("");
    try {
      const data = await api<Lookup>(
        `/api/ai/explanations?book=${lesson.book}&lesson=${lesson.lesson}&target=${encodeURIComponent(JSON.stringify(target))}`,
      );
      if (identityRef.current !== current) return;
      setResult(data.cached ? data.result : null);
      setHistory(data.history);
      setJobId(data.jobId || "");
      if (autoGenerate && !data.cached && !data.jobId) void generate(false);
    } catch (e) {
      if (identityRef.current === current) setError((e as Error).message);
    } finally {
      if (identityRef.current === current) setLoading(false);
    }
  };
  useEffect(() => {
    setResult(null);
    setJobId("");
    setFeedback("");
    void lookup(target.kind !== "lesson");
  }, [identity]);
  const job = useJob(jobId, (state) => {
    if (state.status === "done") {
      setResult(state.result as Explanation);
      setFeedback("");
    } else setError(state.error || "生成失败，旧详解已保留");
    setBusy(false);
  });
  const generating = busy || (!!jobId && job?.status === "running");
  const generate = async (regenerate: boolean) => {
    const current = identity;
    setBusy(true);
    setError("");
    try {
      const data = await api<{ jobId?: string; result?: Explanation }>(
        "/api/ai/explanations",
        {
          method: "POST",
          body: JSON.stringify({
            book: lesson.book,
            lesson: lesson.lesson,
            target,
            regenerate,
            active: active(),
          }),
        },
      );
      if (identityRef.current !== current) return;
      if (data.result) {
        setResult(data.result);
        setJobId("");
        setBusy(false);
      } else setJobId(data.jobId || "");
    } catch (e) {
      if (identityRef.current === current) {
        setError((e as Error).message);
        setBusy(false);
      }
    }
  };
  const streamed = job?.status === "running";
  const content = streamed ? job.text : result?.content || "";
  const images = streamed ? job.images : result?.images || [];
  const warnings = streamed ? job.warnings : result?.warnings || [];
  const updateImage = (image: AIImage) =>
    setResult((r) =>
      r
        ? { ...r, images: r.images.map((v) => (v.id === image.id ? image : v)) }
        : r,
    );
  return (
    <aside className="ai-panel" aria-label="AI 详解">
      <header className="ai-panel-header">
        <div>
          <span className="ai-eyebrow">
            <Sparkles size={15} />
            你的私人英语老师
          </span>
          <h2>AI 详解</h2>
        </div>
        {target.kind !== "lesson" && (
          <Button size="sm" variant="ghost" onClick={back}>
            <ArrowLeft size={14} />
            整课
          </Button>
        )}
      </header>
      <p className="ai-target">
        {target.kind === "lesson"
          ? `${lesson.label} · 整课详解`
          : target.text ||
            (target.kind === "sentence" ? "选中句子" : "选中单词")}
      </p>
      {result && (
        <div className="ai-context">
          {explanationBasis(result)}生成
          {(result.toolsUsed == null ||
            result.toolsUsed.includes("get_learner_profile")) &&
            result.context.profile.weaknesses.length > 0 && (
              <span>关注：{result.context.profile.weaknesses.join("、")}</span>
            )}
          <small>
            {new Date(result.createdAt).toLocaleString()} · {result.model}
          </small>
        </div>
      )}
      {loading ? (
        <p className="ai-empty" role="status">
          正在查找已有详解…
        </p>
      ) : (
        !content &&
        !generating && (
          <div className="ai-empty">
            <BookOpen size={32} />
            <p>根据你的水平、薄弱项和学习进度，解释这段内容。</p>
            <a href="/learning-profile">查看学习档案与水平测评 ↗</a>
            <Button onClick={() => void generate(false)}>
              <Sparkles size={16} />
              {target.kind === "lesson" ? "生成整课详解" : "生成词句详解"}
            </Button>
          </div>
        )
      )}
      {generating && (
        <p role="status" className="ai-generating">
          <Sparkles size={14} />
          {content
            ? "正在解释，AI 会按需配图…"
            : "正在结合你的学习档案准备详解…"}
        </p>
      )}
      {result && !generating && (
        <Suspense fallback={null}>
          <AISpeechPlayer
            key={`${result.id}:${result.contentVersion}`}
            explanation={result}
          />
        </Suspense>
      )}
      {content && (
        <div className="ai-markdown">
          <Suspense
            fallback={<div style={{ whiteSpace: "pre-wrap" }}>{content}</div>}
          >
            <AIMarkdown content={content} images={images} />
          </Suspense>
        </div>
      )}
      {images.map((image) => (
        <div className="ai-illustration" key={image.id}>
          {image.version && !content.includes(`/api/ai/images/${image.id}`) && (
            <img src={image.url} alt={image.caption} loading="lazy" />
          )}
          <ImageControl image={image} onUpdate={updateImage} />
        </div>
      ))}
      {warnings.map((warning, index) => (
        <p className="ai-warning" role="status" key={index}>
          {warning}
        </p>
      ))}
      {error && (
        <div className="ai-error" role="alert">
          <p>{error}</p>
          <a href="/settings">检查系统配置</a>
          <Button size="sm" variant="outline" onClick={() => void lookup()}>
            重新读取缓存
          </Button>
        </div>
      )}
      {result && !generating && (
        <div className="ai-feedback">
          <p>这个讲解对你来说：</p>
          <div className="ai-feedback-buttons">
            {(
              [
                ["hard", "太难"],
                ["okay", "合适"],
                ["easy", "太简单"],
              ] as const
            ).map(([rating, label]) => (
              <Button
                key={rating}
                size="sm"
                variant="outline"
                onClick={() => {
                  setFeedback("正在保存…");
                  void api<{ jobId: string }>("/api/learner/feedback", {
                    method: "POST",
                    body: JSON.stringify({
                      explanationId: result.id,
                      rating,
                      dimension,
                    }),
                  })
                    .then((v) => {
                      setFeedbackJob(v.jobId || "");
                      setFeedback(
                        v.jobId
                          ? "反馈已保存，AI 正在更新能力档案。"
                          : "反馈已保存，下次生成会调整讲解方式。",
                      );
                      window.dispatchEvent(
                        new Event("learner-profile-changed"),
                      );
                    })
                    .catch((e) => setFeedback(e.message));
                }}
              >
                <ThumbsUp size={12} />
                {label}
              </Button>
            ))}
          </div>
          <label className="ai-feedback-dimension">
            具体方面（可选）
            <select
              aria-label="反馈能力维度"
              value={dimension}
              onChange={(e) => setDimension(e.target.value)}
            >
              <option value="">整体讲解</option>
              <option value="vocabulary">词汇</option>
              <option value="grammar">语法</option>
              <option value="reading">阅读理解</option>
              <option value="listening">听力</option>
            </select>
          </label>
          <p role="status">{feedback}</p>
          <Button variant="ghost" size="sm" onClick={() => void generate(true)}>
            <RotateCcw size={14} />
            按当前水平重新生成详解
          </Button>
        </div>
      )}
      {history.length > 0 && (
        <details className="ai-history">
          <summary>历史个性化版本（{history.length}）</summary>
          {history.map((old) => (
            <Button
              variant="ghost"
              size="sm"
              key={old.id}
              onClick={() => {
                setResult(old);
                setJobId("");
              }}
            >
              {explanationBasis(old)} ·{" "}
              {new Date(old.createdAt).toLocaleDateString()}
            </Button>
          ))}
          <Button
            size="sm"
            variant="outline"
            disabled={generating}
            onClick={() => void generate(false)}
          >
            按当前水平生成
          </Button>
        </details>
      )}
    </aside>
  );
}
export function AIWorkspace({
  lesson,
  heading,
  children,
}: {
  lesson: TextLesson;
  heading: ReactNode;
  children: (explain: (target: AITarget) => void) => ReactNode;
}) {
  const [target, setTarget] = useState<AITarget>({ kind: "lesson" }),
    [tab, setTab] = useState("course"),
    [selection, setSelection] = useState<{
      target: AITarget;
      top: number;
      left: number;
    } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const explain = (value: AITarget) => {
    setTarget(value);
    setTab("ai");
    setSelection(null);
    window.getSelection()?.removeAllRanges();
  };
  useEffect(() => {
    const selected = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) {
        setSelection(null);
        return;
      }
      const range = sel.getRangeAt(0),
        element = (node: Node) =>
          node instanceof Element ? node : node.parentElement;
      const start = element(range.startContainer)?.closest<HTMLElement>(
          "[data-english]",
        ),
        end = element(range.endContainer)?.closest<HTMLElement>(
          "[data-english]",
        );
      if (
        !start ||
        !end ||
        !root.current?.contains(start) ||
        !root.current.contains(end)
      ) {
        setSelection(null);
        return;
      }
      const text = sel.toString().trim();
      if (!text || text.length > 4000) {
        setSelection(null);
        return;
      }
      const rect = range.getBoundingClientRect();
      const startWord = element(range.startContainer)?.closest<HTMLElement>(
          "[data-word-id]",
        ),
        endWord = element(range.endContainer)?.closest<HTMLElement>(
          "[data-word-id]",
        );
      const selectedTarget: AITarget =
        startWord && startWord === endWord
          ? { kind: "word", id: startWord.dataset.wordId, text }
          : {
              kind: "selection",
              id: start.dataset.sentenceId,
              endId: end.dataset.sentenceId,
              text,
            };
      setSelection({
        target: selectedTarget,
        top: Math.max(8, Math.min(window.innerHeight - 56, rect.bottom + 6)),
        left: Math.max(8, Math.min(window.innerWidth - 140, rect.left)),
      });
    };
    document.addEventListener("selectionchange", selected);
    window.addEventListener("resize", selected);
    return () => {
      document.removeEventListener("selectionchange", selected);
      window.removeEventListener("resize", selected);
    };
  }, []);
  const active = () => {
    const reader = root.current?.querySelector<HTMLElement>(".reading-room");
    const completed =
      root.current
        ?.querySelector(".reading-heading button[aria-pressed]")
        ?.getAttribute("aria-pressed") === "true";
    return {
      position: Number(reader?.dataset.readingPosition) || 0,
      sentence: reader?.dataset.readingSentence || "",
      completed,
      mode: "text",
    };
  };
  return (
    <div className="ai-workspace" ref={root}>
      <div className="ai-lesson-heading">{heading}</div>
      <div className="ai-mobile-tabs" role="group" aria-label="课程与 AI 面板">
        <Button
          variant={tab === "course" ? "secondary" : "ghost"}
          aria-pressed={tab === "course"}
          onClick={() => setTab("course")}
        >
          <BookOpen size={16} />
          课程内容
        </Button>
        <Button
          variant={tab === "ai" ? "secondary" : "ghost"}
          aria-pressed={tab === "ai"}
          onClick={() => setTab("ai")}
        >
          <Sparkles size={16} />
          AI 详解
        </Button>
      </div>
      <div
        className={`ai-course-column ${tab !== "course" ? "ai-mobile-hidden" : ""}`}
        onClickCapture={(event) => {
          if (
            (event.target as Element).closest("[data-english]") &&
            window.getSelection()?.toString().trim()
          ) {
            event.preventDefault();
            event.stopPropagation();
          }
        }}
      >
        {children(explain)}
      </div>
      <div
        className={`ai-explanation-column ${tab !== "ai" ? "ai-mobile-hidden" : ""}`}
      >
        <ExplanationPanel
          key={`${lesson.book}:${lesson.lesson}:${JSON.stringify(target)}`}
          lesson={lesson}
          target={target}
          back={() => setTarget({ kind: "lesson" })}
          active={active}
        />
      </div>
      {selection && (
        <Button
          className="ai-selection-button"
          style={{ top: selection.top, left: selection.left }}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => explain(selection.target)}
        >
          <Sparkles size={15} />
          AI 详解
        </Button>
      )}
    </div>
  );
}
