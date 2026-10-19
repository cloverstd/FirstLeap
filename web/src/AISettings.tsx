import {
  useState,
  cloneElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { Settings, Check, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api, useAPI, type AISettings as SettingsData } from "./ai";

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
function SettingsForm({
  initial,
  defaults,
}: {
  initial: SettingsData;
  defaults: SettingsData;
}) {
  const [form, setForm] = useState(initial),
    [status, setStatus] = useState(""),
    [busy, setBusy] = useState(false);
  const model = (group: "text" | "image", key: string, value: unknown) =>
    setForm((f) => ({ ...f, [group]: { ...f[group], [key]: value } }));
  return (
    <form
      className="ai-form"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setStatus("");
        void api("/api/settings/ai", {
          method: "PUT",
          body: JSON.stringify(form),
        })
          .then(() => {
            setForm((f) => ({
              ...f,
              text: {
                ...f.text,
                keySet: !f.text.clearKey && (!!f.text.apiKey || f.text.keySet),
                apiKey: "",
                clearKey: false,
              },
              image: {
                ...f.image,
                keySet:
                  !f.image.clearKey && (!!f.image.apiKey || f.image.keySet),
                apiKey: "",
                clearKey: false,
              },
            }));
            setStatus("配置已保存。已有详解继续使用缓存，新任务使用当前配置。");
          })
          .catch((e) => setStatus(e.message))
          .finally(() => setBusy(false));
      }}
    >
      {(["text", "image"] as const).map((group) => (
        <section className="ai-card" key={group}>
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
          <div className="ai-form-grid">
            <Field
              label={`${group === "text" ? "文字" : "生图"} Base URL`}
              hint="填写包含 API 前缀的地址，例如 https://example.com/v1"
            >
              <input
                type="url"
                value={form[group].baseURL}
                onChange={(e) => model(group, "baseURL", e.target.value)}
                placeholder="https://example.com/v1"
              />
            </Field>
            <Field label={`${group === "text" ? "文字" : "生图"} Model`}>
              <input
                value={form[group].model}
                onChange={(e) => model(group, "model", e.target.value)}
                placeholder="填写模型名称"
              />
            </Field>
            <Field
              label={`${group === "text" ? "文字" : "生图"} API Key`}
              hint={
                form[group].keySet
                  ? "已配置；留空保留现有 Key。"
                  : "支持无需 Key 的本地兼容服务。"
              }
            >
              <input
                type="password"
                autoComplete="new-password"
                value={form[group].apiKey || ""}
                onChange={(e) => model(group, "apiKey", e.target.value)}
                placeholder={form[group].keySet ? "已配置" : "填写 API Key"}
              />
            </Field>
            <label className="ai-check">
              <input
                type="checkbox"
                checked={!!form[group].clearKey}
                onChange={(e) => model(group, "clearKey", e.target.checked)}
              />
              清除已保存的 {group === "text" ? "文字" : "生图"} Key
            </label>
            {group === "text" && (
              <Field label="文字接口协议">
                <select
                  value={form.text.protocol}
                  onChange={(e) => model(group, "protocol", e.target.value)}
                >
                  <option value="chat">Chat Completions</option>
                  <option value="responses">Responses</option>
                </select>
              </Field>
            )}
          </div>
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
                      value={form.text.maxTokens}
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
                      value={form.text.temperature ?? ""}
                      onChange={(e) =>
                        model(
                          group,
                          "temperature",
                          e.target.value === "" ? null : Number(e.target.value),
                        )
                      }
                    />
                  </Field>
                  <Field label="Chat Completions tokens 字段">
                    <select
                      value={form.text.tokenField}
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
                      checked={form.text.stream}
                      onChange={(e) => model(group, "stream", e.target.checked)}
                    />
                    流式显示文字
                  </label>
                </>
              ) : (
                <>
                  <Field label="图片尺寸">
                    <input
                      value={form.image.size}
                      onChange={(e) => model(group, "size", e.target.value)}
                      placeholder="1024x1024"
                    />
                  </Field>
                  <Field
                    label="图片质量"
                    hint="留空由服务商决定；支持的值取决于模型。"
                  >
                    <input
                      value={form.image.quality}
                      onChange={(e) => model(group, "quality", e.target.value)}
                    />
                  </Field>
                  <Field label="每次详解最多调用生图次数">
                    <input
                      type="number"
                      min={0}
                      max={6}
                      value={form.image.maxCalls}
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
                  value={form[group].timeout}
                  onChange={(e) =>
                    model(group, "timeout", Number(e.target.value))
                  }
                />
              </Field>
            </div>
          </details>
        </section>
      ))}
      <section className="ai-card">
        <h2>系统提示词</h2>
        <p>学习档案与最新进度会在生成时自动提供给 AI。</p>
        {(
          Object.entries({
            system: "通用系统提示词",
            lesson: "整课详解",
            sentence: "句段详解",
            word: "单词详解",
            image: "生图风格",
            assessment: "动态测评出题",
            evaluation: "能力评估",
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
    </form>
  );
}
export function AISettings() {
  const resource = useAPI<{ settings: SettingsData; defaults: SettingsData }>(
    "/api/settings/ai",
  );
  return (
    <main className="ai-page">
      <header className="ai-page-heading">
        <Settings size={24} />
        <div>
          <h1>系统配置</h1>
          <p>配置文字、生图模型与教学提示词。</p>
        </div>
      </header>
      {resource.value ? (
        <SettingsForm
          initial={resource.value.settings}
          defaults={resource.value.defaults}
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
