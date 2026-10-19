import { useEffect, useRef, useState } from "react";
import { GraduationCap, Play, Check, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field } from "./AISettings";
import {
  api,
  DIMENSIONS,
  LEVELS,
  levelName,
  useAPI,
  useJob,
  type Dimension,
  type LearnerProfile as Profile,
  type ProfileData,
} from "./ai";
import { claimMedia } from "./mediaCoordinator";

type Question = {
  id: string;
  dimension: Dimension;
  difficulty: number;
  text: string;
  options: string[];
  unavailable: boolean;
  explanation?: string;
  audio?: { url: string };
};
type Answer = {
  question: Question;
  choice: number;
  correct: boolean;
  skipped: boolean;
};
type Session = {
  id: string;
  status: string;
  answers: Answer[];
  question: Question | null;
  report: string;
  total: number;
};
type AssessmentResponse = { session: Session; jobId: string };
function LevelSelect({
  value,
  change,
  label,
  "aria-label": ariaLabel,
}: {
  value: number;
  change: (level: number) => void;
  label?: string;
  "aria-label"?: string;
}) {
  return (
    <select
      aria-label={label || ariaLabel}
      value={value}
      onChange={(e) => change(Number(e.target.value))}
    >
      <option value={-1}>未评估</option>
      {LEVELS.map((name, index) => (
        <option value={index} key={name}>
          {name}
        </option>
      ))}
    </select>
  );
}
function ProfileForm({
  profile,
  refresh,
}: {
  profile: Profile;
  refresh: () => void;
}) {
  const [form, setForm] = useState<ProfileData>(profile),
    [status, setStatus] = useState(""),
    [busy, setBusy] = useState(false);
  const save = async (undoId?: string) => {
    setBusy(true);
    setStatus("");
    try {
      await api("/api/learner/profile", {
        method: "PUT",
        body: JSON.stringify({
          profile: {
            level: form.level,
            abilities: form.abilities,
            goals: form.goals,
            weaknesses: form.weaknesses,
            style: form.style,
          },
          revision: profile.revision,
          undoId: undoId || "",
        }),
      });
      setStatus("学习档案已保存，下一次生成会使用当前能力。");
      refresh();
      window.dispatchEvent(new Event("learner-profile-changed"));
    } catch (e) {
      setStatus((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const source = (name: string) =>
    ({
      unknown: "尚未评估",
      manual: "自评",
      assessment: "动态测评",
      feedback: "学习反馈",
    })[name] || name;
  return (
    <>
      <form
        className="ai-card ai-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="ai-section-heading">
          <h2>我的学习档案</h2>
          <span>当前建议：{levelName(profile.level)}</span>
        </div>
        <div className="ai-form-grid">
          <Field label="总体学习等级">
            <LevelSelect
              value={form.level}
              change={(level) => setForm((f) => ({ ...f, level }))}
            />
          </Field>
          <Field label="讲解方式">
            <select
              value={form.style}
              onChange={(e) =>
                setForm((f) => ({ ...f, style: e.target.value }))
              }
            >
              <option value="foundation">多讲基础，细致拆解</option>
              <option value="balanced">循序渐进</option>
              <option value="concise">简明讲解，侧重表达与迁移</option>
            </select>
          </Field>
          {(Object.keys(DIMENSIONS) as Dimension[]).map((dimension) => (
            <div key={dimension} className="ai-ability">
              <Field
                label={`${DIMENSIONS[dimension]}能力`}
                hint={`依据：${source(form.abilities[dimension].source)}`}
              >
                <LevelSelect
                  value={form.abilities[dimension].level}
                  change={(level) =>
                    setForm((f) => ({
                      ...f,
                      abilities: {
                        ...f.abilities,
                        [dimension]: {
                          ...f.abilities[dimension],
                          level,
                          source: "manual",
                        },
                      },
                    }))
                  }
                />
              </Field>
              <label className="ai-check">
                <input
                  type="checkbox"
                  checked={form.abilities[dimension].locked}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      abilities: {
                        ...f.abilities,
                        [dimension]: {
                          ...f.abilities[dimension],
                          locked: e.target.checked,
                        },
                      },
                    }))
                  }
                />
                固定此项，暂停 AI 自动更新
              </label>
            </div>
          ))}
        </div>
        <Field label="学习目标">
          <textarea
            rows={3}
            value={form.goals}
            onChange={(e) => setForm((f) => ({ ...f, goals: e.target.value }))}
            placeholder="例如：能听懂日常对话，掌握基础语法，读懂英文文章。"
          />
        </Field>
        <Field
          label="需要加强的内容"
          hint="每行一项，可以填写不熟悉的语法、表达或学习困难。"
        >
          <textarea
            rows={3}
            value={form.weaknesses.join("\n")}
            onChange={(e) =>
              setForm((f) => ({ ...f, weaknesses: e.target.value.split("\n") }))
            }
          />
        </Field>
        <div className="ai-save">
          <Button disabled={busy} type="submit">
            <Check size={15} />
            保存学习档案
          </Button>
          <p role="status">{status}</p>
        </div>
      </form>
      {profile.history.length > 0 && (
        <section className="ai-card">
          <h2>能力调整记录</h2>
          {profile.history.slice(0, 8).map((change) => (
            <div className="ai-profile-change" key={change.id}>
              <div>
                <small>{new Date(change.at).toLocaleString()}</small>
                <p>{change.reason}</p>
              </div>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => void save(change.id)}
              >
                <RotateCcw size={13} />
                恢复到此前
              </Button>
            </div>
          ))}
        </section>
      )}
    </>
  );
}
function Assessment({ refresh }: { refresh: () => void }) {
  const sessions =
    useAPI<{ id: string; status: string; answered: number }[]>(
      "/api/assessments",
    );
  const [session, setSession] = useState<Session | null>(null),
    [jobId, setJobId] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [choice, setChoice] = useState(-1),
    [audioError, setAudioError] = useState(false);
  const audio = useRef<HTMLAudioElement>(null);
  const accept = (data: AssessmentResponse) => {
    setSession(data.session);
    setJobId(data.jobId || "");
    setChoice(-1);
    setBusy(false);
  };
  const job = useJob(jobId, (state) => {
    setBusy(false);
    if (state.status === "done") {
      setSession(state.result as Session);
      setChoice(-1);
      refresh();
      sessions.reload();
    } else setError(state.error || "测评准备失败，请重试");
  });
  const running = busy || (!!jobId && job?.status === "running");
  const start = async (fresh = false) => {
    setBusy(true);
    setError("");
    try {
      accept(
        await api<AssessmentResponse>("/api/assessments", {
          method: "POST",
          body: JSON.stringify({ new: fresh }),
        }),
      );
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  const resume = async (id: string) => {
    setError("");
    try {
      accept(await api<AssessmentResponse>(`/api/assessments/${id}`));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const answer = async (selected: number) => {
    if (!session?.question) return;
    setBusy(true);
    setError("");
    audio.current?.pause();
    try {
      accept(
        await api<AssessmentResponse>(
          `/api/assessments/${session.id}/answers`,
          {
            method: "POST",
            body: JSON.stringify({
              questionId: session.question.id,
              choice: selected,
            }),
          },
        ),
      );
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  const retry = async () => {
    if (!session) return;
    setError("");
    try {
      const data = await api<{ jobId: string }>(
        `/api/assessments/${session.id}/continue`,
        { method: "POST", body: "{}" },
      );
      if (data.jobId) setJobId(data.jobId);
      else await resume(session.id);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    setAudioError(false);
  }, [session?.question?.id]);
  const q = session?.question,
    last = session?.answers.at(-1);
  return (
    <section className="ai-card assessment" aria-label="英语水平动态测评">
      <div className="ai-section-heading">
        <h2>英语水平动态测评</h2>
        <span>词汇 · 语法 · 阅读 · 听力</span>
      </div>
      <p>
        16 道题，AI
        会根据回答调整难度。结果帮助老师选择适合你的学习起点与讲解方式。口语和写作可在档案中自评。
      </p>
      {!session && (
        <div className="ai-assessment-start">
          <Button disabled={running} onClick={() => void start()}>
            <Play size={15} />
            开始或继续测评
          </Button>
          {sessions.value
            ?.filter((s) => s.status !== "done")
            .slice(0, 3)
            .map((s) => (
              <Button
                size="sm"
                variant="outline"
                key={s.id}
                onClick={() => void resume(s.id)}
              >
                继续未完成测评（{s.answered}/16）
              </Button>
            ))}
        </div>
      )}
      {session && (
        <>
          <div className="ai-test-progress">
            <progress max={session.total} value={session.answers.length} />
            <span>
              {session.answers.length} / {session.total}
            </span>
          </div>
          {last && (
            <details className="assessment-answer">
              <summary>
                {last.skipped
                  ? "上一题已跳过，不计为答错"
                  : last.correct
                    ? "上一题答对了"
                    : "上一题需要再练习"}
              </summary>
              <p>{last.question.explanation}</p>
              {last.question.audio && (
                <p>
                  原音：
                  {(last.question.audio as { transcript?: string }).transcript}
                </p>
              )}
            </details>
          )}
          {session.status === "done" ? (
            <div className="ai-assessment-result">
              <h3>测评已完成，学习档案已更新</h3>
              <p>{session.report}</p>
              <Button variant="outline" onClick={() => void start(true)}>
                重新测评
              </Button>
            </div>
          ) : q && !running ? (
            <div className="assessment-question">
              <span className="ai-eyebrow">
                第 {session.answers.length + 1} 题 · {DIMENSIONS[q.dimension]} ·{" "}
                {levelName(q.difficulty)}
              </span>
              <h3>{q.text}</h3>
              {q.audio && (
                <>
                  <audio
                    ref={audio}
                    controls
                    preload="metadata"
                    src={q.audio.url}
                    onPlay={() => {
                      if (audio.current) claimMedia(audio.current);
                    }}
                    onError={() => setAudioError(true)}
                    aria-label="测评原音"
                  />
                  <p className="ai-subtle">
                    请先听原音，再选择答案。可以重复播放。
                  </p>
                </>
              )}
              <fieldset className="assessment-options">
                <legend className="sr-only">请选择答案</legend>
                {q.options.map((text, index) => (
                  <label
                    key={index}
                    className={choice === index ? "selected" : ""}
                  >
                    <input
                      type="radio"
                      name="assessment-answer"
                      value={index}
                      checked={choice === index}
                      onChange={() => setChoice(index)}
                    />
                    <span>{String.fromCharCode(65 + index)}.</span>
                    {text}
                  </label>
                ))}
              </fieldset>
              {audioError && (
                <p role="alert">
                  原音暂时不可用，可以重试播放，或跳过此题，保留听力未完成状态。
                </p>
              )}
              {q.unavailable || audioError ? (
                <div className="ai-assessment-start">
                  {audioError && (
                    <Button
                      variant="outline"
                      onClick={() => {
                        setAudioError(false);
                        audio.current?.load();
                      }}
                    >
                      重试播放
                    </Button>
                  )}
                  <Button onClick={() => void answer(-1)}>
                    跳过此题，不计分
                  </Button>
                </div>
              ) : (
                <Button
                  disabled={choice < 0}
                  onClick={() => void answer(choice)}
                >
                  提交答案
                </Button>
              )}
            </div>
          ) : (
            <p role="status" className="ai-generating">
              {running
                ? "AI 正在根据回答准备下一步…"
                : "可继续准备题目或完成评估。"}
            </p>
          )}
          {!running && session.status !== "done" && !q && (
            <Button variant="outline" onClick={() => void retry()}>
              继续／重试测评
            </Button>
          )}
        </>
      )}
      {error && (
        <div className="ai-error" role="alert">
          {error}
          <a href="/settings">检查模型配置</a>
          {session && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void resume(session.id)}
            >
              重新读取测评
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
export function LearnerProfile() {
  const resource = useAPI<Profile>("/api/learner/profile");
  return (
    <main className="ai-page">
      <header className="ai-page-heading">
        <GraduationCap size={27} />
        <div>
          <h1>我的学习档案</h1>
          <p>让每一次讲解，都适合你现在的能力与进度。</p>
        </div>
      </header>
      <Assessment refresh={resource.reload} />
      {resource.value ? (
        <ProfileForm
          key={resource.value.revision}
          profile={resource.value}
          refresh={resource.reload}
        />
      ) : (
        <div className="ai-card" role="status">
          {resource.error || "正在加载学习档案…"}
          {resource.error && <Button onClick={resource.reload}>重试</Button>}
        </div>
      )}
    </main>
  );
}
