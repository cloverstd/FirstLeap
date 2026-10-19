import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  LoaderCircle,
  RotateCcw,
  Sparkles,
  Volume2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { api, watchJob } from "./ai";
import { acquireVocabularySlot } from "./vocabularyLoading";
import "./vocabulary.css";

type Expression = { expression: string; meaning: string };
export type VocabularyDetails = {
  phoneticUK: string;
  phoneticUS: string;
  senses: {
    pos: string;
    meaning: string;
    explanation: string;
    examples: { english: string; chinese: string }[];
    countability?: "countable" | "uncountable" | "both" | "plural-only";
    plural?: string[];
    countableExpressions?: Expression[];
  }[];
  verbs: {
    base: string;
    thirdPerson: string[];
    presentParticiple: string[];
    past: string[];
    pastParticiple: string[];
    note?: string;
  }[];
  extensions: Expression[];
  notes: string;
};
export type TextVocabulary = {
  id: string;
  word: string;
  pos: string;
  meaning: string;
  pronunciationId: string;
  ready: boolean;
  details?: VocabularyDetails;
};

const COUNTABILITY = {
  countable: "可数名词 [C]",
  uncountable: "不可数名词 [U]",
  both: "可数 / 不可数 [C/U]",
  "plural-only": "只用复数",
};

export function VocabularyEntry({
  word,
  book,
  lesson,
  selected,
  play,
  explain,
}: {
  word: TextVocabulary;
  book: number;
  lesson: number;
  selected: boolean;
  play: () => void;
  explain: () => void;
}) {
  const root = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(false);
  const [details, setDetails] = useState(word.details);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (details || !root.current) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "240px" },
    );
    observer.observe(root.current);
    return () => observer.disconnect();
  }, [details]);

  useEffect(() => {
    if (!visible || details) return;
    let alive = true;
    let stop: (() => void) | undefined;
    let release: (() => void) | undefined;
    const controller = new AbortController();
    setError("");
    void acquireVocabularySlot(controller.signal)
      .then((free) => {
        release = free;
        if (!alive) {
          free();
          return;
        }
        return api<{
          cached?: boolean;
          result?: VocabularyDetails;
          jobId?: string;
        }>(
          `/api/books/${book}/lessons/${lesson}/vocabulary/${encodeURIComponent(word.id)}/details`,
          { method: "POST", body: "{}", signal: controller.signal },
        );
      })
      .then((data) => {
        if (!alive || !data) return;
        if (data.result) {
          release?.();
          setDetails(data.result);
          return;
        }
        if (!data.jobId) throw new Error("词条暂时不可用，请重试");
        stop = watchJob(
          data.jobId,
          (state) => {
            if (!alive) return;
            if (state.status !== "running") release?.();
            if (state.status === "done")
              setDetails(state.result as VocabularyDetails);
            if (state.status === "error")
              setError(state.error || "词条补全失败，请重试");
          },
          () => {
            release?.();
            if (alive) setError("连接中断，重新加载可恢复词条");
          },
        );
      })
      .catch((e: Error) => {
        release?.();
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
      controller.abort();
      stop?.();
      release?.();
    };
  }, [visible, details, book, lesson, word.id, attempt]);

  return (
    <article
      ref={root}
      aria-label={`单词：${word.word}`}
      className={cn("vocabulary-entry", selected && "selected-vocabulary")}
    >
      <div className="vocabulary-heading">
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h3 className="font-serif text-2xl font-normal">{word.word}</h3>
            <span className="text-xs text-muted-foreground">{word.pos}</span>
          </div>
          {details && (
            <div className="vocabulary-phonetics" aria-label="国际音标">
              <span>
                <small>英</small> <span lang="en-GB">{details.phoneticUK}</span>
              </span>
              <span>
                <small>美</small> <span lang="en-US">{details.phoneticUS}</span>
              </span>
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="size-9"
            aria-label={`AI 详解单词：${word.word}`}
            onClick={explain}
          >
            <Sparkles className="size-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="size-10 rounded-full text-primary"
            disabled={!word.ready}
            aria-label={`生词发音：${word.word}`}
            title={word.ready ? "播放美音词音" : "词音正在准备"}
            onClick={play}
          >
            <Volume2 className="size-4" />
          </Button>
        </div>
      </div>
      <p className="vocabulary-course-meaning">
        <span>本课</span>
        {word.meaning}
      </p>
      {details ? (
        <>
          <section aria-label="词义与例句" className="vocabulary-senses">
            {details.senses.map((sense, index) => (
              <div key={index} className="vocabulary-sense">
                <div className="vocabulary-sense-title">
                  <span className="vocabulary-sense-number">{index + 1}</span>
                  <span className="text-xs text-muted-foreground">
                    {sense.pos}
                  </span>
                  <strong>{sense.meaning}</strong>
                  {sense.countability && (
                    <Badge variant="secondary">
                      {COUNTABILITY[sense.countability]}
                    </Badge>
                  )}
                </div>
                <p className="text-muted-foreground">{sense.explanation}</p>
                {!!sense.plural?.length && (
                  <p>
                    <span className="text-muted-foreground">复数：</span>
                    <span lang="en">{sense.plural.join(" / ")}</span>
                  </p>
                )}
                {!!sense.countableExpressions?.length && (
                  <div>
                    <p className="text-xs text-muted-foreground">
                      量词 / 可数表达
                    </p>
                    {sense.countableExpressions.map((item, i) => (
                      <p key={i}>
                        <span lang="en" className="font-medium">
                          {item.expression}
                        </span>{" "}
                        · {item.meaning}
                      </p>
                    ))}
                  </div>
                )}
                {sense.examples.map((example, i) => (
                  <blockquote key={i} className="vocabulary-example">
                    <p lang="en">{example.english}</p>
                    <p className="text-muted-foreground">{example.chinese}</p>
                  </blockquote>
                ))}
              </div>
            ))}
          </section>
          {!!details.verbs?.length && (
            <section aria-label="动词变形" className="vocabulary-forms">
              <h4 className="mb-3 text-sm font-medium">动词变形</h4>
              {details.verbs.map((verb, i) => (
                <div key={i}>
                  <dl className="vocabulary-form-list">
                    {(
                      [
                        ["原形", [verb.base]],
                        ["第三人称单数", verb.thirdPerson || []],
                        ["现在分词", verb.presentParticiple || []],
                        ["过去式", verb.past || []],
                        ["过去分词", verb.pastParticiple || []],
                        [
                          "过去完成时",
                          (verb.pastParticiple || []).map(
                            (form) => `had ${form}`,
                          ),
                        ],
                      ] as [string, string[]][]
                    )
                      .filter(([, forms]) => forms.length > 0)
                      .map(([label, forms]) => (
                        <div key={label}>
                          <dt>{label}</dt>
                          <dd lang="en">{forms.join(" / ")}</dd>
                        </div>
                      ))}
                  </dl>
                  {verb.pastParticiple?.length > 0 && (
                    <p className="mt-2 text-xs text-muted-foreground">
                      过去完成时由 had + 过去分词构成。
                    </p>
                  )}
                  {verb.note && <p className="mt-2">{verb.note}</p>}
                </div>
              ))}
            </section>
          )}
          {(details.extensions?.length > 0 || details.notes) && (
            <details className="vocabulary-extensions" open>
              <summary>
                扩展用法与搭配
                <ChevronDown className="size-4" />
              </summary>
              <div className="space-y-2 pt-3">
                {details.extensions?.map((item, i) => (
                  <p key={i}>
                    <strong lang="en" className="font-medium">
                      {item.expression}
                    </strong>{" "}
                    · {item.meaning}
                  </p>
                ))}
                {details.notes && (
                  <p className="text-muted-foreground">{details.notes}</p>
                )}
              </div>
            </details>
          )}
          <p className="mt-4 text-xs text-muted-foreground">
            AI 整理 · 词条已缓存
          </p>
        </>
      ) : error ? (
        <div className="vocabulary-loading" role="status">
          <p>{error}</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setAttempt((n) => n + 1)}
          >
            <RotateCcw className="size-3" />
            重新加载词条
          </Button>
          {error.includes("系统配置") && (
            <a className="text-primary underline" href="/settings">
              前往系统配置
            </a>
          )}
        </div>
      ) : (
        <p className="vocabulary-loading" role="status">
          <LoaderCircle className="size-4 shrink-0 animate-spin" />
          正在补全音标、词义、例句与词形…
        </p>
      )}
    </article>
  );
}
