import { useEffect, useState } from "react";

export const LEVELS = ["入门", "初级", "中级", "中高级", "高级"];
export const DIMENSIONS = {
  vocabulary: "词汇",
  grammar: "语法",
  reading: "阅读",
  listening: "听力",
  speaking: "口语",
  writing: "写作",
};
export type Dimension = keyof typeof DIMENSIONS;
export type Ability = { level: number; source: string; locked: boolean };
export type ProfileData = {
  level: number;
  abilities: Record<Dimension, Ability>;
  goals: string;
  weaknesses: string[];
  style: string;
};
export type LearnerProfile = ProfileData & {
  revision: number;
  updatedAt: string;
  history: { id: string; at: string; reason: string; before: ProfileData }[];
};
export type AITarget = {
  kind: "lesson" | "sentence" | "word" | "vocabulary" | "selection";
  id?: string;
  endId?: string;
  text?: string;
};
export type AIImage = {
  id: string;
  prompt: string;
  caption: string;
  version: string;
  url: string;
  model: string;
};
export type Explanation = {
  id: string;
  book: number;
  lesson: number;
  target: AITarget;
  content: string;
  contentVersion: string;
  images: AIImage[];
  warnings: string[];
  context: { profile: ProfileData; stage: string };
  model: string;
  createdAt: string;
  usage: Record<string, unknown>[];
  toolsUsed?: string[] | null;
};
export type AIToolInfo = {
  id: string;
  label: string;
  description: string;
  workflows: string[];
  requiredFor: string[];
};
export const AI_WORKFLOWS: Record<string, string> = {
  explanation: "课文详解",
  assessment: "动态测评出题",
  evaluation: "能力评估",
};
export function explanationBasis(result: Explanation) {
  const legacy = result.toolsUsed == null;
  const hasProfile =
    legacy || result.toolsUsed!.includes("get_learner_profile");
  const hasState =
    legacy || result.toolsUsed!.includes("get_current_learning_state");
  return [
    hasProfile
      ? `按${levelName(result.context.profile.level)}水平`
      : "未读取学习档案",
    hasState ? result.context.stage : "",
  ]
    .filter(Boolean)
    .join(" · ");
}
export type JobState = {
  id: string;
  status: "running" | "done" | "error";
  text: string;
  images: AIImage[];
  warnings: string[];
  error?: string;
  result?: unknown;
  speech?: SpeechView;
};
export type ModelConfig = {
  baseURL: string;
  apiKey?: string;
  keySet: boolean;
  clearKey?: boolean;
  model: string;
};
export type TTSConfig = ModelConfig & {
  enabled: boolean;
  voice: string;
  speed: number;
  format: "mp3" | "wav";
  instructions: string;
  instructionField: "none" | "instructions" | "instruct";
  timeout: number;
  extra: Record<string, unknown>;
};
export type SpeechAudio = {
  id: string;
  script: string;
  status:
    "queued" | "preparing" | "generating" | "ready" | "error" | "interrupted";
  error?: string;
  segments: { text: string; url?: string; duration: number }[];
};
export type SpeechView = {
  enabled: boolean;
  audio?: SpeechAudio;
  pending?: SpeechAudio;
  jobId?: string;
};
export type AISettings = {
  enabledTools: string[];
  text: ModelConfig & {
    protocol: "chat" | "responses";
    stream: boolean;
    maxTokens: number;
    tokenField: string;
    temperature: number | null;
    timeout: number;
  };
  image: ModelConfig & {
    enabled: boolean;
    size: string;
    quality: string;
    timeout: number;
    maxCalls: number;
  };
  tts: TTSConfig;
  prompts: Record<
    | "system"
    | "lesson"
    | "sentence"
    | "word"
    | "image"
    | "assessment"
    | "evaluation"
    | "speech",
    string
  >;
};
export function levelName(level: number) {
  return LEVELS[level] || "未评估";
}
export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error("暂时无法连接服务，请稍后重试");
  }
  if (!response.ok)
    throw new Error(
      (body as { error?: string }).error ||
        (response.status === 409
          ? "数据已在另一设备更新，请刷新后重试"
          : "请求失败，请重试"),
    );
  return body as T;
}
export function useAPI<T>(url: string) {
  const [value, setValue] = useState<T | null>(null),
    [error, setError] = useState(""),
    [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    setError("");
    void api<T>(url)
      .then((v) => {
        if (alive) setValue(v);
      })
      .catch((e) => {
        if (alive) setError(String(e.message));
      });
    return () => {
      alive = false;
    };
  }, [url, attempt]);
  return { value, setValue, error, reload: () => setAttempt((a) => a + 1) };
}
export function watchJob(
  id: string,
  update: (state: JobState) => void,
  lost: () => void,
) {
  const stream = new EventSource(
    `/api/ai/jobs/${encodeURIComponent(id)}/events`,
  );
  stream.addEventListener("snapshot", (event) => {
    try {
      const state = JSON.parse((event as MessageEvent).data) as JobState;
      update(state);
      if (state.status !== "running") stream.close();
    } catch {
      stream.close();
      lost();
    }
  });
  stream.onerror = () => {
    stream.close();
    lost();
  };
  return () => stream.close();
}
export function useJob(id: string, completed: (state: JobState) => void) {
  const [state, setState] = useState<JobState | null>(null);
  useEffect(() => {
    if (!id) {
      setState(null);
      return;
    }
    setState({ id, status: "running", text: "", images: [], warnings: [] });
    return watchJob(
      id,
      (v) => {
        setState(v);
        if (v.status !== "running") completed(v);
      },
      () => {
        const failed: JobState = {
          id,
          status: "error",
          text: "",
          images: [],
          warnings: [],
          error: "连接中断。任务仍可能在生成，重新读取即可恢复。",
        };
        setState(failed);
        completed(failed);
      },
    );
  }, [id]); // Job identity owns the subscription.
  return state;
}
