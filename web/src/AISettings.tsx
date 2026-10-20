import {
  useState,
  useMemo,
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
} from "lucide-react";
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
  type AIProviders,
} from "./ai";
import { claimMedia } from "./mediaCoordinator";

type ProviderResult = {
  models: string[];
  message: string;
  modelAvailable: boolean;
};

const PROVIDER_LABELS = { text: "文字", image: "生图", tts: "语音" };

function ProviderPicker({
  group,
  providers,
  selected,
  defaultId,
  disabled,
  select,
  makeDefault,
  rename,
  add,
  remove,
}: {
  group: ProviderGroup;
  providers: { id: string; name: string }[];
  selected: string;
  defaultId: string;
  disabled: boolean;
  select: (id: string) => void;
  makeDefault: (id: string) => void;
  rename: (name: string) => void;
  add: () => void;
  remove: () => void;
}) {
  const label = PROVIDER_LABELS[group];
  const current = providers.find((p) => p.id === selected)!;
  return (
    <div className="ai-provider-picker">
      <div className="ai-form-grid">
        <Field
          label={`默认${label} Provider`}
          hint="保存后，新任务使用此服务。"
        >
          <select
            value={defaultId}
            disabled={disabled}
            onChange={(e) => makeDefault(e.target.value)}
          >
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label={`编辑${label} Provider`}
          hint="切换编辑会保留草稿，默认服务单独选择。"
        >
          <select
            value={selected}
            disabled={disabled}
            onChange={(e) => select(e.target.value)}
          >
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.id === defaultId ? "（默认）" : ""}
              </option>
            ))}
          </select>
        </Field>
        <Field label={`${label} Provider 名称`}>
          <input
            value={current.name}
            maxLength={100}
            required
            disabled={disabled}
            onChange={(e) => rename(e.target.value)}
          />
        </Field>
      </div>
      <div className="ai-provider-actions">
        <Button
          type="button"
          variant="outline"
          disabled={disabled || providers.length >= 32}
          onClick={add}
          aria-label={`添加${label} Provider`}
        >
          <Plus />
          添加 Provider
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={disabled || selected === defaultId}
          onClick={remove}
          aria-label={`删除${label} Provider`}
        >
          <Trash2 />
          删除当前 Provider
        </Button>
      </div>
      <p className="ai-subtle">
        删除默认服务前，请先选择其他默认
        Provider。添加、删除和默认选择均在保存后生效。
      </p>
    </div>
  );
}

function ProviderConnection({
  group,
  providerId,
  value,
  change,
  disabled,
}: {
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
          hint="填写包含 API 前缀的地址，例如 https://example.com/v1"
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
              ? "填写模型名称；可选获取服务商模型列表。"
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
  children,
}: {
  providerId: string;
  children: ReactNode;
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
    <section className="ai-card ai-tts-settings" aria-label="语音合成配置">
      <h2>语音合成</h2>
      <p>
        把 AI
        详解改写成老师讲课的口语讲稿，自动生成并保存语音。已有语音保留原音色，重新生成时采用最新设置。
      </p>
      <label className="ai-check">
        <input
          type="checkbox"
          checked={value.enabled}
          onChange={(e) => change("enabled", e.target.checked)}
        />
        自动生成 AI 详解语音
      </label>
      {children}
      <ProviderConnection
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
            min={0.25}
            max={4}
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
        <Field
          label="语音讲课风格"
          hint="风格指令字段选择不发送时，此项不传给模型。"
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
          hint="可填写语言、参考音频等服务商扩展参数。参考音频地址／路径需由 TTS 服务识别；不能覆盖音色、语速等基础参数。"
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
          disabled={disabled || busy || !value.baseURL || !value.model}
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
    </section>
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

function SettingsForm({
  initial,
  defaults,
  tools,
}: {
  initial: SettingsData;
  defaults: SettingsData;
  tools: AIToolInfo[];
}) {
  const [form, setForm] = useState(initial),
    [status, setStatus] = useState(""),
    [busy, setBusy] = useState(false),
    [selected, setSelected] = useState(initial.providers.defaults),
    [extraDrafts, setExtraDrafts] = useState<Record<string, string>>({});
  const configs = {
    text: form.providers.text.find((p) => p.id === selected.text)!.config,
    image: form.providers.image.find((p) => p.id === selected.image)!.config,
    tts: form.providers.tts.find((p) => p.id === selected.tts)!.config,
  };
  const { text, image, tts } = configs;
  const ttsValue = useMemo(
    () => ({ ...tts, enabled: form.tts.enabled }),
    [tts, form.tts.enabled],
  );
  const extraText =
    extraDrafts[selected.tts] ?? JSON.stringify(tts.extra || {}, null, 2);
  const model = (group: ProviderGroup, key: string, value: unknown) =>
    setForm((f) =>
      key === "enabled"
        ? { ...f, [group]: { ...f[group], enabled: value } }
        : {
            ...f,
            providers: {
              ...f.providers,
              [group]: f.providers[group].map((p) =>
                p.id === selected[group]
                  ? { ...p, config: { ...p.config, [key]: value } }
                  : p,
              ),
            },
          },
    );
  const providerPicker = (group: ProviderGroup) => (
    <ProviderPicker
      group={group}
      providers={form.providers[group]}
      selected={selected[group]}
      defaultId={form.providers.defaults[group]}
      disabled={busy}
      select={(id) => setSelected((s) => ({ ...s, [group]: id }))}
      makeDefault={(id) =>
        setForm((f) => ({
          ...f,
          providers: {
            ...f.providers,
            defaults: { ...f.providers.defaults, [group]: id },
          },
        }))
      }
      rename={(name) =>
        setForm((f) => ({
          ...f,
          providers: {
            ...f.providers,
            [group]: f.providers[group].map((p) =>
              p.id === selected[group] ? { ...p, name } : p,
            ),
          },
        }))
      }
      add={() => {
        const id = crypto.randomUUID();
        setForm((f) => ({
          ...f,
          providers: {
            ...f.providers,
            [group]: [
              ...f.providers[group],
              {
                id,
                name: `新${PROVIDER_LABELS[group]}服务`,
                config: { ...defaults[group] },
              },
            ],
          },
        }));
        setSelected((s) => ({ ...s, [group]: id }));
        setStatus("");
      }}
      remove={() => {
        const remaining = form.providers[group].filter(
          (p) => p.id !== selected[group],
        );
        if (!remaining.length) return;
        setForm((f) => ({
          ...f,
          providers: {
            ...f.providers,
            [group]: remaining,
          },
        }));
        setSelected((s) => ({ ...s, [group]: remaining[0].id }));
        setStatus("");
      }}
    />
  );
  return (
    <form
      className="ai-form ai-settings-form"
      onSubmit={(event) => {
        event.preventDefault();
        let providers: AIProviders;
        try {
          providers = {
            ...form.providers,
            tts: form.providers.tts.map((p) => ({
              ...p,
              config: {
                ...p.config,
                extra:
                  extraDrafts[p.id] === undefined
                    ? p.config.extra
                    : parseTTSExtra(extraDrafts[p.id]),
              },
            })),
          };
        } catch (e) {
          setStatus((e as Error).message);
          return;
        }
        setBusy(true);
        setStatus("");
        void api("/api/settings/ai", {
          method: "PUT",
          body: JSON.stringify({ ...form, providers }),
        })
          .then(async () => {
            const saved = await api<{ settings: SettingsData }>(
              "/api/settings/ai",
            );
            setForm(saved.settings);
            setExtraDrafts({});
            setStatus(
              "配置已保存。已有详解与语音继续使用缓存，新任务使用当前配置。",
            );
          })
          .catch((e) => setStatus(e.message))
          .finally(() => setBusy(false));
      }}
    >
      <fieldset disabled={busy} className="ai-settings-fields">
        {(["text", "image"] as const).map((group) => (
          <section
            className="ai-card"
            key={group}
            aria-label={`${group === "text" ? "文字" : "生图"}模型配置`}
          >
            <h2>{group === "text" ? "文字模型" : "生图模型"}</h2>
            {group === "image" && (
              <label className="ai-check">
                <input
                  type="checkbox"
                  checked={form.image.enabled}
                  onChange={(e) => model(group, "enabled", e.target.checked)}
                />
                允许 AI 在详解时按需生成配图
              </label>
            )}
            {providerPicker(group)}
            <ProviderConnection
              key={selected[group]}
              group={group}
              providerId={selected[group]}
              value={configs[group]}
              change={(key, value) => model(group, key, value)}
              disabled={busy}
            />
            {group === "text" && (
              <div className="ai-form-grid mt-5">
                <Field label="文字接口协议">
                  <select
                    value={text.protocol}
                    onChange={(e) => model(group, "protocol", e.target.value)}
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
                        onChange={(e) =>
                          model(group, "maxTokens", Number(e.target.value))
                        }
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
                          model(
                            group,
                            "temperature",
                            e.target.value === ""
                              ? null
                              : Number(e.target.value),
                          )
                        }
                      />
                    </Field>
                    <Field label="Chat Completions tokens 字段">
                      <select
                        value={text.tokenField}
                        onChange={(e) =>
                          model(group, "tokenField", e.target.value)
                        }
                      >
                        <option>max_completion_tokens</option>
                        <option>max_tokens</option>
                      </select>
                    </Field>
                    <label className="ai-check">
                      <input
                        type="checkbox"
                        checked={text.stream}
                        onChange={(e) =>
                          model(group, "stream", e.target.checked)
                        }
                      />
                      流式显示文字
                    </label>
                  </>
                ) : (
                  <>
                    <Field label="图片尺寸">
                      <input
                        value={image.size}
                        onChange={(e) => model(group, "size", e.target.value)}
                        placeholder="1024x1024"
                      />
                    </Field>
                    <Field
                      label="图片质量"
                      hint="留空由服务商决定；支持的值取决于模型。"
                    >
                      <input
                        value={image.quality}
                        onChange={(e) =>
                          model(group, "quality", e.target.value)
                        }
                      />
                    </Field>
                    <Field label="每次详解最多调用生图次数">
                      <input
                        type="number"
                        min={0}
                        max={6}
                        value={image.maxCalls}
                        onChange={(e) =>
                          model(group, "maxCalls", Number(e.target.value))
                        }
                      />
                    </Field>
                  </>
                )}
                <Field label="单次请求超时（秒）">
                  <input
                    type="number"
                    min={5}
                    max={600}
                    value={configs[group].timeout}
                    onChange={(e) =>
                      model(group, "timeout", Number(e.target.value))
                    }
                  />
                </Field>
              </div>
            </details>
          </section>
        ))}
        <TTSSettings
          key={selected.tts}
          providerId={selected.tts}
          value={ttsValue}
          change={(key, value) => model("tts", key, value)}
          disabled={busy}
          extraText={extraText}
          setExtraText={(value) =>
            setExtraDrafts((drafts) => ({ ...drafts, [selected.tts]: value }))
          }
        >
          {providerPicker("tts")}
        </TTSSettings>
        <section className="ai-card ai-tools-settings" aria-label="AI 工具配置">
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
          <p>AI 按需通过已启用的工具读取材料，再依据实际获得的信息生成内容。</p>
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
  );
}
export function AISettings() {
  const resource = useAPI<{
    settings: SettingsData;
    defaults: SettingsData;
    tools: AIToolInfo[];
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
