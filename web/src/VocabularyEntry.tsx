import { useEffect, useState } from "react";
import {
  ChevronDown,
  LoaderCircle,
  RotateCcw,
  Sparkles,
  Volume2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { api, watchJob } from "./ai";
import { acquireVocabularySlot } from "./vocabularyLoading";
import "./vocabulary.css";

export type DictionaryEntry = {
  word: string;
  phonetic: string;
  translations: string[];
  definitions: string[];
  forms: { label: string; values: string[] }[];
  source: { name: string; url: string; revision: string };
};

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
  model?: string;
};
export type TextVocabulary = {
  id: string;
  word: string;
  pos: string;
  meaning: string;
  pronunciationId: string;
  ready: boolean;
  dictionary?: DictionaryEntry;
  details?: VocabularyDetails;
};

const COUNTABILITY = {
  countable: "可数名词 [C]",
  uncountable: "不可数名词 [U]",
  both: "可数 / 不可数 [C/U]",
  "plural-only": "只用复数",
};

function phonetic(value: string) {
  return value.startsWith("/") || value.startsWith("[") ? value : `/${value}/`;
}

function BasicDefinition({ word }: { word: TextVocabulary }) {
  const dictionary = word.dictionary;
  const meanings = dictionary?.translations?.length
    ? dictionary.translations
    : dictionary?.definitions || [];
  return (
    <details className="vocabulary-basic" open>
      <summary>
        基础释义
        <ChevronDown className="size-4" />
      </summary>
      <div className="vocabulary-basic-content">
        <p className="vocabulary-course-meaning">
          <span>本课</span>
          {word.meaning}
        </p>
        {dictionary?.phonetic && (
          <p className="vocabulary-phonetics" aria-label="词典音标">
            <small>音标</small>
            <span lang="en">{phonetic(dictionary.phonetic)}</span>
          </p>
        )}
        {meanings.length > 0 && (
          <section aria-label="词典释义">
            <ul className="vocabulary-basic-meanings">
              {meanings.map((meaning, i) => (
                <li key={i}>{meaning}</li>
              ))}
            </ul>
          </section>
        )}
        {!!dictionary?.forms?.length && (
          <section aria-label="词典词形">
            <dl className="vocabulary-form-list">
              {dictionary.forms.map((form, i) => (
                <div key={i}>
                  <dt>{form.label}</dt>
                  <dd lang="en">{form.values.join(" / ")}</dd>
                </div>
              ))}
            </dl>
          </section>
        )}
        <p className="text-xs text-muted-foreground">
          {dictionary ? (
            <>
              词典来源：
              <a href={dictionary.source.url} target="_blank" rel="noreferrer">
                {dictionary.source.name}
              </a>{" "}
              · 音标以英式为主
            </>
          ) : (
            "来源：教材释义"
          )}
        </p>
      </div>
    </details>
  );
}

function VocabularyExpansion({
  details,
  explain,
}: {
  details: VocabularyDetails;
  explain: () => void;
}) {
  return (
    <>
      <div className="vocabulary-phonetics" aria-label="国际音标">
        <span>
          <small>英</small> <span lang="en-GB">{details.phoneticUK}</span>
        </span>
        <span>
          <small>美</small> <span lang="en-US">{details.phoneticUS}</span>
        </span>
      </div>
      <section aria-label="词义与例句" className="vocabulary-senses">
        {details.senses.map((sense, index) => (
          <div key={index} className="vocabulary-sense">
            <div className="vocabulary-sense-title">
              <span className="vocabulary-sense-number">{index + 1}</span>
              <span className="text-xs text-muted-foreground">{sense.pos}</span>
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
                <p className="text-xs text-muted-foreground">量词 / 可数表达</p>
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
                      (verb.pastParticiple || []).map((form) => `had ${form}`),
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
        AI 生成 · 已缓存，可跨设备复用
      </p>

      <Button type="button" variant="ghost" size="sm" onClick={explain}>
        按学习档案进一步讲解
      </Button>
    </>
  );
}

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
  const [details, setDetails] = useState(word.details);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const busy = attempt > 0 && !details && !error;

  useEffect(() => {
    if (!attempt || details) return;
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
        if (!data.jobId) throw new Error("AI 拓展暂时不可用，请重试");
        stop = watchJob(
          data.jobId,
          (state) => {
            if (!alive) return;
            if (state.status !== "running") release?.();
            if (state.status === "done")
              setDetails(state.result as VocabularyDetails);
            if (state.status === "error")
              setError(state.error || "AI 拓展失败，请重试");
          },
          () => {
            release?.();
            if (alive) setError("连接中断，重试可读取已完成的 AI 拓展");
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
  }, [attempt, details, book, lesson, word.id]);

  return (
    <article
      aria-label={`单词：${word.word}`}
      className={cn("vocabulary-entry", selected && "selected-vocabulary")}
    >
      <div className="vocabulary-heading">
        <div className="min-w-0 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h3 className="font-serif text-2xl font-normal">{word.word}</h3>
          <span className="text-xs text-muted-foreground">{word.pos}</span>
        </div>
        <Button
          variant="outline"
          size="icon"
          className="size-10 shrink-0 rounded-full text-primary"
          disabled={!word.ready}
          aria-label={`生词发音：${word.word}`}
          title={word.ready ? "播放美音词音" : "词音正在准备"}
          onClick={play}
        >
          <Volume2 className="size-4" />
        </Button>
      </div>
      <BasicDefinition word={word} />
      <Collapsible
        className="vocabulary-ai"
        open={expanded}
        onOpenChange={(open) => {
          setExpanded(open);
          if (open && !details && attempt === 0) setAttempt(1);
        }}
      >
        <CollapsibleTrigger asChild>
          <Button
            type="button"
            variant="outline"
            aria-label={`AI 拓展单词：${word.word}`}
          >
            {busy ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : (
              <Sparkles className="size-4" />
            )}
            AI 拓展
            {details && (
              <span className="text-xs text-muted-foreground">已缓存</span>
            )}
            <ChevronDown className={cn("size-4", expanded && "rotate-180")} />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="vocabulary-ai-content">
          {details ? (
            <VocabularyExpansion details={details} explain={explain} />
          ) : error ? (
            <div className="vocabulary-loading" role="status">
              <p>{error}</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setError("");
                  setAttempt((n) => n + 1);
                }}
              >
                <RotateCcw className="size-3" />
                重试 AI 拓展
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
              正在生成 AI 拓展，完成后会自动缓存…
            </p>
          )}
        </CollapsibleContent>
      </Collapsible>
    </article>
  );
}
