import {
  useState,
  useEffect,
  useRef,
  cloneElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  Settings,
  Check,
  RotateCcw,
  RefreshCw,
  PlugZap,
  LoaderCircle,
  Plus,
  Trash2,
  Pencil,
  X,
} from "lucide-react";
import { Dialog } from "radix-ui";
import { Button } from "@/components/ui/button";
import {
  api,
  useAPI,
  AI_WORKFLOWS,
  type AIToolInfo,
  type AISettings as SettingsData,
  type ModelConfig,
  type TTSConfig,
  type ProviderGroup,
  type AIProvider,
  type TextConfig,
  type ImageConfig,
  type SpeechAdapter,
} from "./ai";
import { claimMedia } from "./mediaCoordinator";

type ProviderResult = {
  models: string[];
  message: string;
  modelAvailable: boolean;
};

const PROVIDER_LABELS = { text: "文字", image: "生图", tts: "语音" };

function ProviderConnection({
  group,
  providerId,
  value,
  change,
  disabled,
  speech,
}: {
  speech?: SpeechAdapter;
  group: ProviderGroup;
  providerId: string;
  value: ModelConfig;
  change: (key: string, value: unknown) => void;
  disabled: boolean;
}) {
  const label = group === "text" ? "文字" : group === "image" ? "生图" : "语音";
  const [models, setModels] = useState<string[] | null>(null);
  const [pending, setPending] = useState("");
  const [notice, setNotice] = useState({ text: "", error: false });
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    request.current?.abort();
    request.current = null;
    setModels(null);
    setPending("");
    setNotice({ text: "", error: false });
    return () => request.current?.abort();
  }, [value.baseURL, value.apiKey, value.clearKey, value.keySet]);
  useEffect(() => setNotice({ text: "", error: false }), [value.model]);
  const check = async (action: "models" | "test") => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setPending(action);
    setNotice({ text: "", error: false });
    try {
      const result = await api<ProviderResult>(`/api/settings/ai/${action}`, {
        method: "POST",
        signal: controller.signal,
        body: JSON.stringify({
          group,
          providerId,
          apiType: speech?.id,
          config: {
            baseURL: value.baseURL,
            apiKey: value.apiKey || "",
            clearKey: !!value.clearKey,
            model: value.model,
          },
        }),
      });
      if (controller.signal.aborted) return;
      setModels(result.models);
      setNotice({ text: result.message, error: !result.modelAvailable });
    } catch (error) {
      if (!controller.signal.aborted)
        setNotice({ text: (error as Error).message, error: true });
    } finally {
      if (request.current === controller) setPending("");
    }
  };
  return (
    <div className="ai-provider-connection">
      <div className="ai-form-grid">
        <Field
          label={`${label} Base URL`}
          hint={
            speech && !speech.modelListing
              ? "豆包原生 API 前缀，例如 https://openspeech.bytedance.com/api/v3"
              : "填写包含 API 前缀的地址，例如 https://example.com/v1"
          }
        >
          <input
            type="url"
            value={value.baseURL}
            onChange={(e) => change("baseURL", e.target.value)}
            placeholder="https://example.com/v1"
          />
        </Field>
        <Field
          label={`${label} API Key`}
          hint={
            value.keySet
              ? "已配置；留空保留现有 Key。"
              : speech && !speech.modelListing
                ? "新版填写 API Key，旧版鉴权填写 Access Token。"
                : "支持无需 Key 的本地兼容服务。"
          }
        >
          <input
            type="password"
            autoComplete="new-password"
            value={value.apiKey || ""}
            onChange={(e) => change("apiKey", e.target.value)}
            placeholder={value.keySet ? "已配置" : "填写 API Key"}
          />
        </Field>
        <Field
          label={`${label} Model`}
          hint={
            group === "tts"
              ? speech?.id === "doubao-tts"
                ? "普通语音合成留空；使用复刻音色时可指定原生模型版本。"
                : "填写模型名称；可选获取服务商模型列表。"
              : "填写地址与 Key 后，获取模型列表，再从服务商模型中选择。"
          }
        >
          {group === "tts" ? (
            <input
              value={value.model}
              list="tts-models"
              onChange={(e) => change("model", e.target.value)}
              placeholder="填写 TTS 模型名称"
            />
          ) : (
            <select
              value={value.model}
              onChange={(e) => change("model", e.target.value)}
              disabled={
                disabled || !!pending || (!models?.length && !value.model)
              }
            >
              <option value="" disabled>
                {models ? "请选择服务商模型" : "请先获取模型列表"}
              </option>
              {value.model && !models?.includes(value.model) && (
                <option value={value.model}>
                  {value.model}
                  {models ? "（本次列表未返回）" : "（当前配置）"}
                </option>
              )}
              {models?.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          )}
        </Field>
        {group === "tts" && (
          <datalist id="tts-models">
            {models?.map((id) => (
              <option key={id} value={id} />
            ))}
          </datalist>
        )}
        <label className="ai-check">
          <input
            type="checkbox"
            checked={!!value.clearKey}
            onChange={(e) => change("clearKey", e.target.checked)}
          />
          清除已保存的 {label} Key
        </label>
      </div>
      {(!speech || speech.modelListing) && (
        <>
          <div className="ai-provider-actions">
            <Button
              type="button"
              variant="outline"
              disabled={disabled || !!pending || !value.baseURL.trim()}
              aria-label={`获取${label}模型列表`}
              onClick={() => void check("models")}
            >
              {pending === "models" ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <RefreshCw />
              )}
              {pending === "models" ? "正在获取…" : "获取模型列表"}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={disabled || !!pending || !value.baseURL.trim()}
              aria-label={`测试${label}连接`}
              onClick={() => void check("test")}
            >
              {pending === "test" ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <PlugZap />
              )}
              {pending === "test" ? "正在测试…" : "测试连接"}
            </Button>
          </div>
          <p className="ai-subtle ai-provider-hint">
            使用当前填写的配置，无需先保存。测试连接检查地址、认证和模型列表，不生成内容。
          </p>
        </>
      )}
      {notice.text && (
        <p
          className={`ai-provider-status ${notice.error ? "ai-provider-error" : ""}`}
          role={notice.error ? "alert" : "status"}
        >
          {notice.text}
        </p>
      )}
    </div>
  );
}

export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="ai-field">
      <span>{label}</span>
      {isValidElement(children)
        ? cloneElement(children as ReactElement<{ "aria-label"?: string }>, {
            "aria-label": label,
          })
        : children}
      {hint && <small aria-hidden="true">{hint}</small>}
    </label>
  );
}

function TTSSettings({
  value,
  change,
  disabled,
  extraText,
  setExtraText,
  providerId,
  speech,
  adapters,
  replace,
}: {
  providerId: string;
  speech: SpeechAdapter;
  replace: (value: TTSConfig) => void;
  adapters: SpeechAdapter[];
  value: TTSConfig;
  change: (key: string, value: unknown) => void;
  disabled: boolean;
  extraText: string;
  setExtraText: (text: string) => void;
}) {
  const [preview, setPreview] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    controller.current?.abort();
    setBusy(false);
    setError("");
    setPreview("");
    return () => controller.current?.abort();
  }, [value, extraText]);
  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview);
    },
    [preview],
  );
  const listen = async () => {
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true);
    setError("");
    setPreview("");
    try {
      const extra = parseTTSExtra(extraText);
      const response = await fetch("/api/settings/ai/tts/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: abort.signal,
        body: JSON.stringify({ providerId, config: { ...value, extra } }),
      });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "试听失败");
      }
      const blob = await response.blob();
      if (!abort.signal.aborted) setPreview(URL.createObjectURL(blob));
    } catch (e) {
      if (!abort.signal.aborted) setError((e as Error).message);
    } finally {
      if (!abort.signal.aborted) setBusy(false);
    }
  };
  return (
    <div className="ai-speech-editor">
      <Field label="语音接口类型">
        <select
          value={speech.id}
          onChange={(e) =>
            replace(
              structuredClone(
                adapters.find((a) => a.id === e.target.value)!.defaults,
              ),
            )
          }
        >
          {adapters.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
            </option>
          ))}
        </select>
      </Field>
      {!speech.modelListing && (
        <div className="ai-form-grid mt-5">
          <Field label="豆包鉴权方式">
            <select
              value={value.authMode || "api-key"}
              onChange={(e) => change("authMode", e.target.value)}
            >
              <option value="api-key">API Key（新版控制台）</option>
              <option value="app-token">App ID + Access Token（旧版）</option>
            </select>
          </Field>
          {value.authMode === "app-token" && (
            <Field label="豆包 App ID">
              <input
                value={value.appId || ""}
                onChange={(e) => change("appId", e.target.value)}
              />
            </Field>
          )}
          {speech.id === "doubao-tts" && (
            <Field
              label="豆包资源 ID"
              hint="语音合成通常为 seed-tts-2.0；使用复刻音色时按服务商资源填写。"
            >
              <input
                value={value.resourceId || ""}
                onChange={(e) => change("resourceId", e.target.value)}
              />
            </Field>
          )}
        </div>
      )}
      <ProviderConnection
        speech={speech}
        providerId={providerId}
        group="tts"
        value={value}
        change={change}
        disabled={disabled}
      />
      <div className="ai-form-grid mt-5">
        <Field
          label="语音音色 Voice"
          hint="填写服务商的音色标识；使用参考音频的服务可按需留空。"
        >
          <input
            value={value.voice}
            onChange={(e) => change("voice", e.target.value)}
            placeholder="例如 Serena、alloy"
          />
        </Field>
        <Field
          label="合成语速"
          hint="决定生成的音频速度；播放器可另外调整收听倍速。"
        >
          <input
            type="number"
            min={speech.minSpeed}
            max={speech.maxSpeed}
            step={0.05}
            value={value.speed}
            onChange={(e) => change("speed", Number(e.target.value))}
          />
        </Field>
        <Field label="语音格式">
          <select
            value={value.format}
            onChange={(e) => change("format", e.target.value)}
          >
            <option value="mp3">MP3</option>
            <option value="wav">WAV</option>
          </select>
        </Field>
        <Field label="语音单段超时（秒）">
          <input
            type="number"
            min={30}
            max={1800}
            value={value.timeout}
            onChange={(e) => change("timeout", Number(e.target.value))}
          />
        </Field>
      </div>
      <details>
        <summary>讲课风格与兼容参数</summary>
        {speech.id === "openai" && (
          <Field
            label="语音风格指令字段"
            hint="以服务商文档为准；不支持风格指令的模型选择不发送。"
          >
            <select
              value={value.instructionField}
              onChange={(e) => change("instructionField", e.target.value)}
            >
              <option value="none">不发送</option>
              <option value="instructions">instructions（OpenAI）</option>
              <option value="instruct">instruct（MLX）</option>
            </select>
          </Field>
        )}
        <Field
          label="语音讲课风格"
          hint={
            speech.id === "openai"
              ? "风格指令字段选择不发送时，此项不传给模型。"
              : "按所选原生接口发送讲课风格指令。"
          }
        >
          <textarea
            rows={3}
            value={value.instructions}
            onChange={(e) => change("instructions", e.target.value)}
            placeholder="像耐心的英语老师一样讲解，语气自然，英文例句清晰，重点处适当停顿。"
          />
        </Field>
        <Field
          label="语音高级参数 JSON"
          hint={
            speech.id === "doubao-tts"
              ? '参数合并到 req_params；additions 填写 JSON 对象。例如 {"additions":{"explicit_language":"zh-cn"}}。不能覆盖讲稿、音色、语速和格式。'
              : speech.id === "doubao-audio"
                ? '参数合并到请求顶层，例如 {"audio_config":{"sample_rate":48000}}。不能覆盖讲稿、音色、语速和格式。'
                : "可填写语言、参考音频等服务商扩展参数。参考音频地址／路径需由 TTS 服务识别；不能覆盖音色、语速等基础参数。"
          }
        >
          <textarea
            rows={5}
            value={extraText}
            onChange={(e) => setExtraText(e.target.value)}
            spellCheck={false}
          />
        </Field>
      </details>
      <div className="ai-provider-actions">
        <Button
          type="button"
          variant="outline"
          disabled={
            disabled ||
            busy ||
            !value.baseURL ||
            (speech.id === "doubao-tts"
              ? !value.resourceId || !value.voice
              : !value.model)
          }
          onClick={() => void listen()}
        >
          {busy ? "正在生成试听…" : "生成短句试听"}
        </Button>
      </div>
      <p className="ai-subtle ai-provider-hint">
        试听使用当前草稿，会调用一次语音模型，无需先保存。
      </p>
      {preview && (
        <audio
          aria-label="语音试听"
          controls
          src={preview}
          onPlay={(e) => claimMedia(e.currentTarget)}
        />
      )}
      {error && (
        <p role="alert" className="ai-provider-status ai-provider-error">
          {error}
        </p>
      )}
    </div>
  );
}

function parseTTSExtra(text: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text || "{}");
  } catch {
    throw new Error("语音高级参数必须是有效 JSON 对象");
  }
  if (value == null || typeof value !== "object" || Array.isArray(value))
    throw new Error("语音高级参数必须是 JSON 对象");
  return value as Record<string, unknown>;
}

type ProviderConfig = TextConfig | ImageConfig | TTSConfig;
type EditorDraft = AIProvider<ProviderConfig> & {
  group: ProviderGroup;
  isNew: boolean;
};

function ModelParameters({
  group,
  value,
  change,
}: {
  group: "text" | "image";
  value: ProviderConfig;
  change: (key: string, value: unknown) => void;
}) {
  const text = value as TextConfig,
    image = value as ImageConfig;
  return (
    <>
      {group === "text" && (
        <div className="ai-form-grid mt-5">
          <Field label="文字接口协议">
            <select
              value={text.protocol}
              onChange={(e) => change("protocol", e.target.value)}
            >
              <option value="chat">Chat Completions</option>
              <option value="responses">Responses</option>
            </select>
          </Field>
        </div>
      )}
      <details>
        <summary>生成参数</summary>
        <div className="ai-form-grid mt-5">
          {group === "text" ? (
            <>
              <Field label="输出 tokens 上限">
                <input
                  type="number"
                  min={64}
                  max={131072}
                  value={text.maxTokens}
                  onChange={(e) => change("maxTokens", Number(e.target.value))}
                />
              </Field>
              <Field
                label="Temperature"
                hint="留空时使用服务商默认值，适用于不接受此参数的模型。"
              >
                <input
                  type="number"
                  step="0.1"
                  min="0"
                  max="2"
                  value={text.temperature ?? ""}
                  onChange={(e) =>
                    change(
                      "temperature",
                      e.target.value === "" ? null : Number(e.target.value),
                    )
                  }
                />
              </Field>
              <Field label="Chat Completions tokens 字段">
                <select
                  value={text.tokenField}
                  onChange={(e) => change("tokenField", e.target.value)}
                >
                  <option>max_completion_tokens</option>
                  <option>max_tokens</option>
                </select>
              </Field>
              <label className="ai-check">
                <input
                  type="checkbox"
                  checked={text.stream}
                  onChange={(e) => change("stream", e.target.checked)}
                />
                流式显示文字
              </label>
            </>
          ) : (
            <>
              <Field label="图片尺寸">
                <input
                  value={image.size}
                  onChange={(e) => change("size", e.target.value)}
                  placeholder="1024x1024"
                />
              </Field>
              <Field
                label="图片质量"
                hint="留空由服务商决定；支持的值取决于模型。"
              >
                <input
                  value={image.quality}
                  onChange={(e) => change("quality", e.target.value)}
                />
              </Field>
              <Field label="每次详解最多调用生图次数">
                <input
                  type="number"
                  min={0}
                  max={6}
                  value={image.maxCalls}
                  onChange={(e) => change("maxCalls", Number(e.target.value))}
                />
              </Field>
            </>
          )}
          <Field label="单次请求超时（秒）">
            <input
              type="number"
              min={5}
              max={600}
              value={value.timeout}
              onChange={(e) => change("timeout", Number(e.target.value))}
            />
          </Field>
        </div>
      </details>
    </>
  );
}

function ProviderEditor({
  draft,
  adapters,
  busy,
  save,
  close,
  opener,
}: {
  draft: EditorDraft;
  adapters: SpeechAdapter[];
  busy: boolean;
  save: (value: EditorDraft) => Promise<void>;
  close: () => void;
  opener: HTMLElement | null;
}) {
  const [value, setValue] = useState(() => structuredClone(draft));
  const [extra, setExtra] = useState(() =>
    JSON.stringify((draft.config as TTSConfig).extra || {}, null, 2),
  );
  const [error, setError] = useState("");
  const label = PROVIDER_LABELS[draft.group];
  const change = (key: string, next: unknown) =>
    setValue((v) => ({ ...v, config: { ...v.config, [key]: next } }));
  const speech = adapters.find(
    (a) => a.id === ((value.config as TTSConfig).apiType || "openai"),
  )!;
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !busy) close();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="ai-dialog-overlay" />
        <Dialog.Content
          className="ai-provider-dialog ai-form"
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            opener?.focus();
          }}
          onPointerDownOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => {
            if (busy) e.preventDefault();
          }}
        >
          <div className="ai-dialog-heading">
            <Dialog.Title>
              {draft.isNew ? "新增" : "编辑"}
              {label} Provider
            </Dialog.Title>
            <Dialog.Close asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                disabled={busy}
                aria-label="关闭编辑"
              >
                <X />
              </Button>
            </Dialog.Close>
          </div>
          <Dialog.Description>
            保存后立即生效。留空的已配置密钥会保留；取消会丢弃本次修改。
          </Dialog.Description>
          <form
            autoComplete="off"
            onSubmit={(e) => {
              e.preventDefault();
              setError("");
              let next = value;
              try {
                if (value.group === "tts")
                  next = {
                    ...value,
                    config: {
                      ...value.config,
                      extra: parseTTSExtra(extra),
                    } as TTSConfig,
                  };
              } catch (e) {
                setError((e as Error).message);
                return;
              }
              void save(next).catch((e: Error) => setError(e.message));
            }}
          >
            <fieldset disabled={busy} className="ai-provider-editor-fields">
              <Field label={`${label} Provider 名称`}>
                <input
                  autoFocus
                  required
                  maxLength={100}
                  value={value.name}
                  onChange={(e) =>
                    setValue((v) => ({ ...v, name: e.target.value }))
                  }
                />
              </Field>
              {value.group === "tts" ? (
                <TTSSettings
                  key={(value.config as TTSConfig).apiType || "openai"}
                  providerId={value.id}
                  value={value.config as TTSConfig}
                  change={change}
                  disabled={busy}
                  extraText={extra}
                  setExtraText={setExtra}
                  speech={speech}
                  adapters={adapters}
                  replace={(config) => {
                    setValue((v) => ({
                      ...v,
                      config: {
                        ...config,
                        keySet: false,
                        apiKey: "",
                        clearKey: false,
                      },
                    }));
                    setExtra("{}");
                  }}
                />
              ) : (
                <>
                  <ProviderConnection
                    group={value.group}
                    providerId={value.id}
                    value={value.config}
                    change={change}
                    disabled={busy}
                  />
                  <ModelParameters
                    group={value.group}
                    value={value.config}
                    change={change}
                  />
                </>
              )}
              {error && (
                <p role="alert" className="ai-provider-error">
                  {error}
                </p>
              )}
              <div className="ai-dialog-footer">
                <Button type="button" variant="outline" onClick={close}>
                  取消
                </Button>
                <Button type="submit">
                  {busy ? "正在保存…" : "保存 Provider"}
                </Button>
              </div>
            </fieldset>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function SettingsForm({
  initial,
  defaults,
  tools,
  adapters,
}: {
  initial: SettingsData;
  defaults: SettingsData;
  tools: AIToolInfo[];
  adapters: SpeechAdapter[];
}) {
  const [form, setForm] = useState(initial),
    [status, setStatus] = useState(""),
    [busy, setBusy] = useState(false);
  const [editor, setEditor] = useState<EditorDraft | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const mergeProviders = (saved: SettingsData) =>
    setForm((f) => ({
      ...f,
      providers: saved.providers,
      text: saved.text,
      image: { ...saved.image, enabled: f.image.enabled },
      tts: { ...saved.tts, enabled: f.tts.enabled },
    }));
  const mutate = async (url: string, method: string, data?: unknown) => {
    setBusy(true);
    setStatus("");
    try {
      const result = await api<{ settings: SettingsData }>(url, {
        method,
        body: data === undefined ? undefined : JSON.stringify(data),
      });
      mergeProviders(result.settings);
      setStatus("Provider 已保存。新任务使用当前配置。");
    } finally {
      setBusy(false);
    }
  };
  const open = (
    group: ProviderGroup,
    provider?: AIProvider<ProviderConfig>,
  ) => {
    opener.current = document.activeElement as HTMLElement;
    setEditor(
      provider
        ? { ...structuredClone(provider), group, isNew: false }
        : {
            id: crypto.randomUUID(),
            name: "",
            group,
            isNew: true,
            config: {
              ...structuredClone(defaults[group]),
              baseURL: "",
              model: "",
              apiKey: "",
              keySet: false,
              clearKey: false,
            },
          },
    );
  };
  const action = (run: () => Promise<void>) =>
    void run().catch((e: Error) => setStatus(e.message));
  return (
    <>
      <form
        className="ai-form ai-settings-form"
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          setStatus("");
          void api<{ settings: SettingsData }>("/api/settings/ai", {
            method: "PATCH",
            body: JSON.stringify({
              enabledTools: form.enabledTools,
              prompts: form.prompts,
              imageEnabled: form.image.enabled,
              speechEnabled: form.tts.enabled,
            }),
          })
            .then(({ settings }) => {
              setForm(settings);
              setStatus(
                "配置已保存。已有详解与语音继续使用缓存，新任务使用当前配置。",
              );
            })
            .catch((e: Error) => setStatus(e.message))
            .finally(() => setBusy(false));
        }}
      >
        <fieldset disabled={busy} className="ai-settings-fields">
          {(["text", "image", "tts"] as const).map((group) => {
            const label = PROVIDER_LABELS[group];
            return (
              <section
                className={`ai-card ${group === "tts" ? "ai-tts-settings" : ""}`}
                key={group}
                aria-label={
                  group === "tts" ? "语音合成配置" : `${label}模型配置`
                }
              >
                <div className="ai-provider-list-heading">
                  <h2>{group === "tts" ? "语音合成" : `${label}模型`}</h2>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy || form.providers[group].length >= 32}
                    onClick={() => open(group)}
                    aria-label={`添加${label} Provider`}
                  >
                    <Plus />
                    添加 Provider
                  </Button>
                </div>
                {group !== "text" && (
                  <label className="ai-check">
                    <input
                      type="checkbox"
                      checked={
                        group === "image"
                          ? form.image.enabled
                          : form.tts.enabled
                      }
                      onChange={(e) =>
                        setForm((f) => ({
                          ...f,
                          [group]: { ...f[group], enabled: e.target.checked },
                        }))
                      }
                    />
                    {group === "image"
                      ? "允许 AI 在详解时按需生成配图"
                      : "自动生成 AI 详解语音"}
                  </label>
                )}
                <ul
                  className="ai-provider-list"
                  aria-label={`${label} Provider 列表`}
                >
                  {form.providers[group].map((p) => {
                    const isDefault = p.id === form.providers.defaults[group];
                    const kind =
                      group === "tts"
                        ? adapters.find(
                            (a) =>
                              a.id ===
                              ((p.config as TTSConfig).apiType || "openai"),
                          )?.label
                        : group === "text"
                          ? (p.config as TextConfig).protocol === "responses"
                            ? "Responses"
                            : "Chat Completions"
                          : "OpenAI 兼容";
                    return (
                      <li
                        key={p.id}
                        className="ai-provider-row"
                        aria-label={p.name}
                      >
                        <div className="ai-provider-summary">
                          <div>
                            <strong>{p.name}</strong>
                            {isDefault && (
                              <span className="ai-provider-default">默认</span>
                            )}
                          </div>
                          <p>
                            {kind} ·{" "}
                            {p.config.model ||
                              (p.config as TTSConfig).resourceId ||
                              "未配置模型"}{" "}
                            · {p.config.keySet ? "密钥已配置" : "未配置密钥"}
                          </p>
                          <p className="ai-provider-address">
                            {p.config.baseURL || "未配置服务地址"}
                          </p>
                        </div>
                        <div className="ai-provider-row-actions">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => open(group, p)}
                          >
                            <Pencil />
                            编辑
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={isDefault}
                            onClick={() =>
                              action(() =>
                                mutate(
                                  `/api/settings/ai/providers/${group}/default`,
                                  "PUT",
                                  { providerId: p.id },
                                ),
                              )
                            }
                          >
                            设为默认
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={
                              isDefault || form.providers[group].length <= 1
                            }
                            onClick={() => {
                              if (
                                window.confirm(
                                  `确定删除 Provider「${p.name}」？`,
                                )
                              )
                                action(() =>
                                  mutate(
                                    `/api/settings/ai/providers/${group}/${p.id}`,
                                    "DELETE",
                                  ),
                                );
                            }}
                          >
                            <Trash2 />
                            删除
                          </Button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
          <section
            className="ai-card ai-tools-settings"
            aria-label="AI 工具配置"
          >
            <h2>AI 工具</h2>
            <p>
              勾选允许 AI
              按需调用的工具，默认全部启用。每次请求只提供当前流程适用的工具，档案、进度和教学材料通过工具读取。
            </p>
            <div className="ai-provider-actions">
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  setForm((f) => ({
                    ...f,
                    enabledTools: tools.map((tool) => tool.id),
                  }))
                }
              >
                全选工具
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => setForm((f) => ({ ...f, enabledTools: [] }))}
              >
                取消全选工具
              </Button>
            </div>
            <div className="ai-tool-list">
              {tools.map((tool) => (
                <div className="ai-tool-item" key={tool.id}>
                  <label className="ai-check">
                    <input
                      type="checkbox"
                      checked={form.enabledTools.includes(tool.id)}
                      disabled={busy}
                      aria-label={`启用${tool.label}工具`}
                      onChange={(event) =>
                        setForm((f) => ({
                          ...f,
                          enabledTools: event.target.checked
                            ? [...f.enabledTools, tool.id]
                            : f.enabledTools.filter((id) => id !== tool.id),
                        }))
                      }
                    />
                    <strong>{tool.label}</strong>
                  </label>
                  <code>{tool.id}</code>
                  <p>{tool.description}</p>
                  <small>
                    适用于：
                    {tool.workflows
                      .map((workflow) => AI_WORKFLOWS[workflow] || workflow)
                      .join("、")}
                    {tool.requiredFor.length > 0 &&
                      `；${tool.requiredFor.join("、")}必需`}
                  </small>
                </div>
              ))}
            </div>
            <p className="ai-subtle">
              关闭必要工具会暂停对应生成操作，重新启用后可继续。已有答案、反馈和历史结果仍会保留。
            </p>
          </section>
          <section className="ai-card ai-prompts-settings">
            <h2>系统提示词</h2>
            <p>
              AI 按需通过已启用的工具读取材料，再依据实际获得的信息生成内容。
            </p>
            {(
              Object.entries({
                system: "通用系统提示词",
                lesson: "整课详解",
                sentence: "句段详解",
                word: "单词详解",
                image: "生图风格",
                assessment: "动态测评出题",
                evaluation: "能力评估",
                speech: "语音讲课稿",
              }) as [keyof SettingsData["prompts"], string][]
            ).map(([key, label]) => (
              <details key={key} open={key === "system"}>
                <summary>{label}</summary>
                <Field label={label}>
                  <textarea
                    rows={5}
                    value={form.prompts[key]}
                    onChange={(e) =>
                      setForm((f) => ({
                        ...f,
                        prompts: { ...f.prompts, [key]: e.target.value },
                      }))
                    }
                  />
                </Field>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    setForm((f) => ({
                      ...f,
                      prompts: { ...f.prompts, [key]: defaults.prompts[key] },
                    }))
                  }
                >
                  <RotateCcw size={14} />
                  恢复此项默认值
                </Button>
              </details>
            ))}
          </section>

          <div className="ai-save">
            <Button disabled={busy} type="submit">
              <Check size={16} />
              {busy ? "正在保存…" : "保存系统配置"}
            </Button>
            <p role="status">{status}</p>
          </div>
        </fieldset>
      </form>
      {editor && (
        <ProviderEditor
          key={editor.id}
          draft={editor}
          adapters={adapters}
          busy={busy}
          opener={opener.current}
          close={() => setEditor(null)}
          save={async (value) => {
            const base = `/api/settings/ai/providers/${value.group}`;
            await mutate(
              value.isNew ? base : `${base}/${value.id}`,
              value.isNew ? "POST" : "PUT",
              { id: value.id, name: value.name, config: value.config },
            );
            setEditor(null);
          }}
        />
      )}
    </>
  );
}
export function AISettings() {
  const resource = useAPI<{
    settings: SettingsData;
    defaults: SettingsData;
    tools: AIToolInfo[];
    speechAdapters: SpeechAdapter[];
  }>("/api/settings/ai");
  return (
    <main className="ai-page page-shell">
      <header className="ai-page-heading">
        <Settings size={24} />
        <div>
          <h1>系统配置</h1>
          <p>配置文字、生图、语音模型、AI 工具与教学提示词。</p>
        </div>
      </header>
      {resource.value ? (
        <SettingsForm
          initial={resource.value.settings}
          defaults={resource.value.defaults}
          tools={resource.value.tools}
          adapters={resource.value.speechAdapters}
        />
      ) : (
        <div className="ai-card" role="status">
          {resource.error || "正在加载配置…"}
          {resource.error && <Button onClick={resource.reload}>重试</Button>}
        </div>
      )}
    </main>
  );
}
