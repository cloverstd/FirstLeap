import { createHash } from "node:crypto";
import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { createServer, type Server } from "node:http";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  copyFileSync,
  rmSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

let binaryRoot: string,
  runRoot: string,
  backend: ChildProcess,
  provider: Server,
  origin: string,
  providerURL: string;
let modelRequests: Record<string, unknown>[] = [];
let speechCalls = 0,
  scriptCalls = 0,
  failSpeech = false,
  speechGateAfter = 1,
  speechGate: Promise<void> | null = null;
let counters = {
    vocabulary: 0,
    explanations: 0,
    images: 0,
    questions: 0,
    evaluations: 0,
    models: 0,
  },
  failText = false,
  failModels = false,
  modelDelay = 0,
  modelIDs = ["teaching", "illustration", "new-provider-model"];
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
async function listen(server: Server) {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("port unavailable");
  return `http://127.0.0.1:${address.port}`;
}
test.beforeAll(() => {
  binaryRoot = mkdtempSync(join(tmpdir(), "firstleap-ai-bin-"));
  execFileSync("go", [
    "build",
    "-o",
    join(binaryRoot, "firstleap"),
    "./cmd/firstleap",
  ]);
});
test.afterAll(() => rmSync(binaryRoot, { recursive: true, force: true }));
test.beforeEach(async ({ request }) => {
  counters = {
    vocabulary: 0,
    explanations: 0,
    images: 0,
    questions: 0,
    evaluations: 0,
    models: 0,
  };
  failText = false;
  failModels = false;
  modelDelay = 0;
  modelIDs = ["teaching", "illustration", "new-provider-model"];
  modelRequests = [];
  speechCalls = 0;
  scriptCalls = 0;
  failSpeech = false;
  speechGateAfter = 1;
  speechGate = null;
  provider = createServer(async (req, res) => {
    if (req.url === "/v1/models" && req.method === "GET") {
      counters.models++;
      const ids = [...modelIDs];
      if (modelDelay) await new Promise((done) => setTimeout(done, modelDelay));
      res.setHeader("Content-Type", "application/json");
      if (failModels) {
        res.writeHead(503);
        res.end(JSON.stringify({ error: "image-private upstream details" }));
      } else if (
        !["Bearer private-key-never-expose", "Bearer image-private"].includes(
          req.headers.authorization || "",
        )
      ) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: "private-key-never-expose" }));
      } else res.end(JSON.stringify({ data: ids.map((id) => ({ id })) }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const input = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    modelRequests.push(input);
    if (req.url === "/v1/audio/speech") {
      speechCalls++;
      if (failSpeech) {
        res.writeHead(422, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ detail: "speed must be 1.0" }));
        return;
      }
      if (speechCalls > speechGateAfter && speechGate) await speechGate;
      res.setHeader("Content-Type", "audio/mpeg");
      res.end(readFileSync(join(runRoot, "audio.mp3")));
      return;
    }
    if (req.url === "/v1/tts/create" || req.url === "/v1/tts/unidirectional") {
      if (req.headers["x-api-key"] !== "speech-private") {
        res.writeHead(401);
        res.end();
        return;
      }
      speechCalls++;
      const audio = readFileSync(join(runRoot, "audio.mp3")).toString("base64");
      res.setHeader("Content-Type", "application/json");
      if (req.url.endsWith("create")) res.end(JSON.stringify({ audio }));
      else
        res.end(
          JSON.stringify({ code: 0, data: audio }) +
            "\n" +
            JSON.stringify({ code: 20000000 }),
        );
      return;
    }
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/v1/images/generations") {
      counters.images++;
      res.end(JSON.stringify({ data: [{ b64_json: png }] }));
      return;
    }
    const messages = input.messages || input.input || [],
      current = [...messages]
        .reverse()
        .find((m: { role?: string }) => m.role === "user");
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(current?.content || "{}");
    } catch {
      /* The finalization instruction is plain text. */
    }
    const chat = (content: string) =>
      res.end(
        JSON.stringify(
          input.messages
            ? {
                choices: [
                  {
                    finish_reason: "stop",
                    message: { role: "assistant", content },
                  },
                ],
                usage: { total_tokens: 16 },
              }
            : {
                status: "completed",
                output: [
                  {
                    type: "message",
                    role: "assistant",
                    content: [{ type: "output_text", text: content }],
                  },
                ],
              },
        ),
      );
    const toolOutputs = messages.filter(
      (m: { role?: string; type?: string }) =>
        m.role === "tool" || m.type === "function_call_output",
    );
    if (JSON.stringify(input).includes("你负责基于教材和基础词典")) {
      counters.vocabulary++;
      chat(
        JSON.stringify({
          phoneticUK: "/ˈhændbæɡ/",
          phoneticUS: "/ˈhændbæɡ/",
          senses: [
            {
              pos: "n.",
              meaning: "手提包",
              explanation: "本课用于询问手提包的归属。",
              countability: "countable",
              plural: ["handbags"],
              examples: [
                {
                  english: "This handbag is mine.",
                  chinese: "这个手提包是我的。",
                },
              ],
            },
          ],
          verbs: [],
          extensions: [
            { expression: "a leather handbag", meaning: "皮革手提包" },
          ],
          notes: "注意 this 与单数名词搭配。",
        }),
      );
      return;
    }
    if (JSON.stringify(input).includes("你负责将已完成")) {
      scriptCalls++;
      chat(
        "同学你好，我们先来理解指示代词。This is my bag. 这是我的包。\n" +
          "这个例句中的 this 指代单数，表示这个。我们先理解句子结构，再自己练习英文表达。".repeat(
            15,
          ),
      );
      return;
    }
    const isAssessment = payload.task === "assessment";
    const isEvaluation = payload.task === "evaluation";
    if (!isAssessment && !isEvaluation) {
      counters.explanations++;
      if (failText) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: "private-key-never-expose" }));
        return;
      }
    }
    const definitions = (input.tools || []).map(
      (tool: { name?: string; function?: { name?: string } }) =>
        tool.name || tool.function?.name,
    );
    if (definitions.length && !toolOutputs.length) {
      const calls = definitions.map((name: string) => ({
        id: name,
        type: "function",
        function: {
          name,
          arguments: JSON.stringify(
            name === "generate_image"
              ? {
                  prompt: "a handbag on a desk",
                  caption: "课文里的手提包",
                }
              : {},
          ),
        },
      }));
      res.end(
        JSON.stringify(
          input.messages
            ? {
                choices: [
                  {
                    finish_reason: "tool_calls",
                    message: {
                      role: "assistant",
                      content: "",
                      tool_calls: calls,
                    },
                  },
                ],
              }
            : {
                status: "completed",
                output: calls.map((call: (typeof calls)[number]) => ({
                  type: "function_call",
                  call_id: call.id,
                  name: call.function.name,
                  arguments: call.function.arguments,
                })),
              },
        ),
      );
      return;
    }
    const returned = Object.fromEntries(
      toolOutputs.map(
        (output: {
          tool_call_id?: string;
          call_id?: string;
          content?: string;
          output?: string;
        }) => [
          output.tool_call_id || output.call_id,
          JSON.parse(output.content || output.output || "{}"),
        ],
      ),
    );
    if (isAssessment) {
      counters.questions++;
      expect(returned.get_assessment_context).toBeTruthy();
      chat(
        JSON.stringify({
          text:
            payload.dimension === "listening"
              ? "听原音，选择正确单词。"
              : "请选择正确的单数指示代词。",
          options: ["this", "these", "those", "them"],
          answer: 0,
          explanation: "this 指代单数，these 指代复数。",
          difficulty: 1,
          audioIndex: 0,
        }),
      );
      return;
    }
    if (isEvaluation) {
      counters.evaluations++;
      expect(returned.get_evaluation_evidence).toBeTruthy();
      chat(
        JSON.stringify({
          level: 1,
          abilities: { vocabulary: 1, grammar: 1, reading: 1, listening: 1 },
          weaknesses: ["指示代词"],
          reason: "根据测评中的词汇、语法、阅读和听力回答，建议从初级开始。",
        }),
      );
      return;
    }
    const context = returned.get_current_learning_state as
      | { stage?: string }
      | undefined;
    chat(
      `## 适合你的详解\n\nThis 是单数指示代词，表示“这个”。\n\n例如：**This is my bag.**（这是我的包。）\n\n${context?.stage || "初学"}：先理解句子，再练习表达。`,
    );
  });
  providerURL = await listen(provider);
  runRoot = mkdtempSync(join(tmpdir(), "firstleap-ai-ui-"));
  const source = join(runRoot, "source"),
    data = join(runRoot, "data");
  mkdirSync(join(source, "audio/book1"), { recursive: true });
  mkdirSync(join(data, "textbooks/library/book1"), { recursive: true });
  const audio = join(runRoot, "audio.mp3");
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=12",
    "-c:a",
    "libmp3lame",
    audio,
  ]);
  const summaries = [1, 3, 5, 7, 9].map((lesson) => {
    const detail = {
      book: 1,
      lesson,
      label: `Lesson ${lesson} & ${lesson + 1}`,
      titleEn: "Excuse me!",
      titleZh: "对不起！",
      instruction: "Listen to the passage.",
      instructionZh: "听课文。",
      question: "Whose handbag is it?",
      duration: 12,
      revision: "ai-browser-fixture",
      alignment: "ready",
      paragraphs: [
        {
          id: "p1",
          sentences: [
            {
              id: "s1",
              text: "Is this your handbag?",
              translationZh: "这是你的手提包吗？",
              start: 1,
              end: 4,
              words: ["Is", "this", "your", "handbag?"].map((text, i) => ({
                id: `s1-w${i}`,
                text,
                before: i ? " " : "",
                start: 1 + i * 0.5,
                end: 1.4 + i * 0.5,
              })),
            },
          ],
        },
      ],
      vocabulary: [
        {
          id: "v0",
          word: "handbag",
          pos: "n.",
          meaning: "手提包",
          pronunciationId: "0123456789abcdef01234567",
          ready: false,
        },
      ],
      translation: ["这是你的手提包吗？"],
    };
    writeFileSync(
      join(
        data,
        `textbooks/library/book1/${String(lesson).padStart(3, "0")}.json`,
      ),
      JSON.stringify(detail),
    );
    copyFileSync(
      audio,
      join(
        source,
        `audio/book1/${String(lesson).padStart(3, "0")}-${String(lesson + 1).padStart(3, "0")}.mp3`,
      ),
    );
    return {
      lesson,
      label: detail.label,
      titleEn: detail.titleEn,
      titleZh: detail.titleZh,
      duration: 12,
      alignment: "ready",
    };
  });
  writeFileSync(
    join(data, "textbooks/library/book1/index.json"),
    JSON.stringify({
      book: 1,
      name: "新概念英语第一册",
      subtitleEn: "First things first",
      lessonCount: 5,
      lessons: summaries,
      downloads: [],
    }),
  );
  const reservation = createServer();
  origin = await listen(reservation);
  const port = new URL(origin).port;
  await new Promise<void>((done) => reservation.close(() => done()));
  const dictionaryRoot = join(runRoot, "dictionary");
  mkdirSync(dictionaryRoot);
  writeFileSync(
    join(dictionaryRoot, "manifest.json"),
    JSON.stringify({
      name: "ECDICT",
      url: "https://github.com/skywind3000/ECDICT",
      revision: "a".repeat(40),
      format: 1,
      entries: 1,
    }),
  );
  const dictionaryEntry = {
    word: "handbag",
    phonetic: "ˈhændbæɡ",
    translations: ["n. 手提包；女用手袋"],
    definitions: ["a small bag for personal items"],
    forms: [{ label: "复数", values: ["handbags"] }],
  };
  const shard = createHash("sha256")
    .update("handbag")
    .digest("hex")
    .slice(0, 2);
  writeFileSync(
    join(dictionaryRoot, shard + ".jsonl"),
    JSON.stringify(dictionaryEntry) + "\n",
  );
  backend = spawn(join(binaryRoot, "firstleap"), [], {
    env: {
      ...process.env,
      DICTIONARY_ROOT: join(runRoot, "dictionary"),
      PORT: port,
      BIND_ADDRESS: "127.0.0.1",
      DATA_ROOT: data,
      TEXTBOOK_ROOT: source,
      MEDIA_ROOT: join(runRoot, "media"),
      WEB_ROOT: resolve("web/dist"),
    },
    stdio: "ignore",
  });
  await expect
    .poll(async () => {
      try {
        return (await request.get(origin + "/health/live")).status();
      } catch {
        return 0;
      }
    })
    .toBe(200);
});
test.afterEach(async () => {
  if (backend) {
    backend.kill("SIGTERM");
    await new Promise<void>((done) => {
      if (backend.exitCode !== null) done();
      else backend.once("exit", () => done());
    });
  }
  provider.closeAllConnections();
  await new Promise<void>((done) => provider.close(() => done()));
  rmSync(runRoot, { recursive: true, force: true });
});
async function configure(
  request: APIRequestContext,
  protocol = "chat",
  images = true,
) {
  const { settings } = await (
    await request.get(origin + "/api/settings/ai")
  ).json();
  delete settings.providers; // Exercise compatibility with older settings clients.
  settings.text = {
    ...settings.text,
    baseURL: providerURL + "/v1",
    apiKey: "private-key-never-expose",
    model: "teaching",
    protocol,
  };
  settings.image = {
    ...settings.image,
    enabled: images,
    baseURL: providerURL + "/v1",
    apiKey: "image-private",
    model: "illustration",
  };
  expect(
    (await request.put(origin + "/api/settings/ai", { data: settings })).ok(),
  ).toBe(true);
}
async function openAI(page: Page) {
  if ((page.viewportSize()?.width || 1440) < 1024)
    await page
      .getByRole("group", { name: "课程与 AI 面板" })
      .getByRole("button", { name: "AI 详解", exact: true })
      .click();
}
async function openCourse(page: Page) {
  if ((page.viewportSize()?.width || 1440) < 1024)
    await page.getByRole("button", { name: "课程内容", exact: true }).click();
}

async function enableSpeech(request: APIRequestContext, speed = 1) {
  const { settings } = await (
    await request.get(origin + "/api/settings/ai")
  ).json();
  delete settings.providers;
  settings.tts = {
    ...settings.tts,
    enabled: true,
    baseURL: providerURL + "/v1",
    model: "local-tts",
    voice: "teacher",
    speed,
    apiKey: "speech-private",
  };
  expect(
    (await request.put(origin + "/api/settings/ai", { data: settings })).ok(),
  ).toBe(true);
}

async function restartSpeechBackend(request: APIRequestContext) {
  backend.kill("SIGTERM");
  await new Promise<void>((done) => backend.once("exit", () => done()));
  backend = spawn(join(binaryRoot, "firstleap"), [], {
    env: {
      ...process.env,
      DICTIONARY_ROOT: join(runRoot, "dictionary"),
      PORT: new URL(origin).port,
      BIND_ADDRESS: "127.0.0.1",
      DATA_ROOT: join(runRoot, "data"),
      TEXTBOOK_ROOT: join(runRoot, "source"),
      MEDIA_ROOT: join(runRoot, "media"),
      WEB_ROOT: resolve("web/dist"),
    },
    stdio: "ignore",
  });
  await expect
    .poll(async () => {
      try {
        return (await request.get(origin + "/health/live")).status();
      } catch {
        return 0;
      }
    })
    .toBe(200);
}

async function editProvider(page: Page, region: string, name?: string) {
  const section = page.getByRole("region", { name: region });
  const row = name
    ? section.getByRole("listitem", { name, exact: true })
    : section;
  await row.getByRole("button", { name: "编辑", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  return dialog;
}
async function saveProvider(page: Page) {
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "保存 Provider", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
}

test("TTS settings support manual models, draft preview and persistent private keys", async ({
  page,
  request,
}) => {
  await configure(request, "chat", false);
  await page.goto(origin + "/settings");
  await page.getByLabel("自动生成 AI 详解语音").check();
  let section = await editProvider(page, "语音合成配置");
  await section
    .getByLabel("语音 Base URL", { exact: true })
    .fill(providerURL + "/v1");
  await section
    .getByLabel("语音 API Key", { exact: true })
    .fill("speech-private");
  await section
    .getByLabel("语音 Model", { exact: true })
    .fill("manually-specified-model");
  await section.getByLabel("语音音色 Voice").fill("Serena");
  await section.getByLabel("合成语速", { exact: true }).fill("0.85");
  await section.getByText("讲课风格与兼容参数", { exact: true }).click();
  await section.getByLabel("语音风格指令字段").selectOption("instruct");
  await section
    .getByLabel("语音讲课风格", { exact: true })
    .fill("像耐心的老师讲课");
  await section.getByLabel("语音高级参数 JSON").fill('{"lang_code":"zh"}');
  await section.getByRole("button", { name: "生成短句试听" }).click();
  await expect(section.getByLabel("语音试听")).toHaveAttribute("src", /^blob:/);
  expect(speechCalls).toBe(1);
  expect(scriptCalls).toBe(0);
  expect(
    modelRequests.find((input) => input.model === "manually-specified-model"),
  ).toMatchObject({
    voice: "Serena",
    speed: 0.85,
    instruct: "像耐心的老师讲课",
    lang_code: "zh",
    response_format: "mp3",
  });
  expect(
    (await (await request.get(origin + "/api/settings/ai")).json()).settings.tts
      .enabled,
  ).toBe(false);
  await saveProvider(page);
  // Provider save must not submit the unsaved feature switch.
  expect(
    (await (await request.get(origin + "/api/settings/ai")).json()).settings.tts
      .enabled,
  ).toBe(false);
  await expect(page.getByLabel("自动生成 AI 详解语音")).toBeChecked();
  await page.getByRole("button", { name: "保存系统配置" }).click();
  await expect(page.getByText("配置已保存。", { exact: false })).toBeVisible();
  await page.reload();
  section = await editProvider(page, "语音合成配置");
  await expect(section.getByLabel("语音 API Key", { exact: true })).toHaveValue(
    "",
  );
  await expect(
    section.getByLabel("语音 API Key", { exact: true }),
  ).toHaveAttribute("placeholder", "已配置");
  await expect(section.getByLabel("合成语速", { exact: true })).toHaveValue(
    "0.85",
  );
  await expect(section.getByLabel("语音 Model", { exact: true })).toHaveValue(
    "manually-specified-model",
  );
  const saved = await (await request.get(origin + "/api/settings/ai")).text();
  expect(saved).not.toContain("speech-private");
  expect(JSON.parse(saved).settings.tts.keySet).toBe(true);
});

test("AI lecture plays early segments, waits, coordinates media and survives restart", async ({
  page,
  request,
}) => {
  await configure(request, "chat", false);
  await enableSpeech(request);
  let release!: () => void;
  speechGate = new Promise<void>((done) => {
    release = done;
  });
  try {
    await page.goto(origin + "/books/1/lessons/1");
    await openAI(page);
    await page
      .getByRole("button", { name: "生成整课详解", exact: true })
      .click();
    const player = page.getByRole("region", { name: "AI 语音讲解" });
    await expect(
      player.getByRole("button", { name: "播放 AI 讲解", exact: true }),
    ).toBeEnabled();
    const characterCount = player.getByLabel("语音合成字符数", { exact: true });
    await expect(characterCount).toBeVisible();
    await expect(player.locator(".ai-speech-script")).not.toHaveAttribute("open");
    const fullCharacterCount = await characterCount.innerText();
    expect(scriptCalls).toBe(1);
    await expect(player.getByRole("status")).toContainText("正在生成语音");
    const audio = page.locator('audio[aria-label="AI 讲解音频"]');
    await player.getByLabel("AI 讲解播放倍速").selectOption("1.5");
    await player
      .getByRole("button", { name: "播放 AI 讲解", exact: true })
      .click();
    await expect
      .poll(() => audio.evaluate((element: HTMLAudioElement) => element.paused))
      .toBe(false);
    await expect
      .poll(() =>
        audio.evaluate((element: HTMLAudioElement) => element.playbackRate),
      )
      .toBe(1.5);
    await audio.evaluate((element: HTMLAudioElement) => {
      element.currentTime = element.duration - 0.05;
    });
    await expect(player.getByRole("status")).toContainText("正在等待下一段");
    release();
    await expect(player.getByRole("status")).toContainText("语音已保存");
    const sentCharacters = modelRequests
      .filter((input) => input.response_format === "mp3")
      .reduce((total, input) => total + Array.from(input.input as string).length, 0);
    expect(fullCharacterCount).toBe(
      `语音字符：${sentCharacters.toLocaleString("zh-CN")}`,
    );
    await expect(characterCount).toHaveText(fullCharacterCount);
    await expect(audio).toHaveAttribute("src", /\/segments\/1$/);
    await expect
      .poll(() => audio.evaluate((element: HTMLAudioElement) => element.paused))
      .toBe(false);
    const generated = speechCalls;
    await player.getByLabel("AI 讲解播放倍速").selectOption("2");
    expect(speechCalls).toBe(generated);
    await expect
      .poll(() =>
        audio.evaluate((element: HTMLAudioElement) => element.playbackRate),
      )
      .toBe(2);
    await openCourse(page);
    await page.getByRole("button", { name: "播放精听", exact: true }).click();
    await expect
      .poll(() => audio.evaluate((element: HTMLAudioElement) => element.paused))
      .toBe(true);
    await openAI(page);
    await player
      .getByRole("button", { name: "播放 AI 讲解", exact: true })
      .click();
    await expect
      .poll(() =>
        page
          .getByTestId("textbook-audio")
          .evaluate((element: HTMLAudioElement) => element.paused),
      )
      .toBe(true);
    await restartSpeechBackend(request);
    await page.reload();
    await openAI(page);
    await expect(player.getByRole("status")).toContainText("语音已保存");
    await expect(characterCount).toHaveText(fullCharacterCount);
    await expect(player.getByLabel("AI 讲解播放倍速")).toHaveValue("2");
    await player
      .getByRole("button", { name: "播放 AI 讲解", exact: true })
      .click();
    await expect
      .poll(() => audio.evaluate((element: HTMLAudioElement) => element.paused))
      .toBe(false);
    expect(speechCalls).toBe(generated);
    expect(scriptCalls).toBe(1);
    await player.getByText("查看讲课稿", { exact: true }).click();
    await expect(player).toContainText("This is my bag.");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  } finally {
    release();
  }
});

test("retrying failed speech after correcting settings plays the first replacement segment", async ({
  page,
  request,
}) => {
  await configure(request, "chat", false);
  await enableSpeech(request, 1.1);
  failSpeech = true;
  await page.goto(origin + "/books/1/lessons/1");
  await openAI(page);
  await page.getByRole("button", { name: "生成整课详解", exact: true }).click();
  const player = page.getByRole("region", { name: "AI 语音讲解" });
  const audio = player.getByLabel("AI 讲解音频", { exact: true });
  await expect(player.getByRole("alert")).toContainText("HTTP 422");
  await expect(
    player.getByRole("button", { name: "播放 AI 讲解", exact: true }),
  ).toBeDisabled();

  await enableSpeech(request);
  failSpeech = false;
  speechGateAfter = 2;
  let release!: () => void;
  speechGate = new Promise<void>((done) => {
    release = done;
  });
  try {
    await player.getByRole("button", { name: "重试语音", exact: true }).click();
    await expect(player.getByRole("status")).toContainText("正在生成语音：1/");
    await expect(
      player.getByRole("button", { name: "播放 AI 讲解", exact: true }),
    ).toBeEnabled();
    await expect(player.getByLabel("AI 讲解播放进度")).toBeEnabled();
    await player
      .getByRole("button", { name: "播放 AI 讲解", exact: true })
      .click();
    await expect
      .poll(() => audio.evaluate((element: HTMLAudioElement) => element.paused))
      .toBe(false);
    await expect(audio).toHaveAttribute("src", /\/segments\/0$/);
    await audio.evaluate((element: HTMLAudioElement) => {
      element.currentTime = element.duration - 0.05;
    });
    await expect(player.getByRole("status")).toContainText("正在等待下一段");
    release();
    await expect(player.getByRole("status")).toContainText("语音已保存");
    await expect(audio).toHaveAttribute("src", /\/segments\/1$/);
    await expect
      .poll(() => audio.evaluate((element: HTMLAudioElement) => element.paused))
      .toBe(false);
    expect(scriptCalls).toBe(1);
  } finally {
    release();
  }
});

test("opening a saved explanation automatically adds speech without regenerating text", async ({
  page,
  request,
}) => {
  await configure(request, "responses", false);
  await page.goto(origin + "/books/1/lessons/1");
  await openAI(page);
  await page.getByRole("button", { name: "生成整课详解", exact: true }).click();
  await expect(page.getByText("适合你的详解", { exact: true })).toBeVisible();
  expect(speechCalls).toBe(0);
  const textCalls = counters.explanations;
  await enableSpeech(request);
  await page.reload();
  await openAI(page);
  const player = page.getByRole("region", { name: "AI 语音讲解" });
  await expect(player.getByRole("status")).toContainText("语音已保存");
  expect(counters.explanations).toBe(textCalls);
  expect(scriptCalls).toBe(1);
  expect(speechCalls).toBeGreaterThan(0);
});

test("regenerating lecture speech preserves playback until the listener pauses", async ({
  page,
  request,
}) => {
  await configure(request, "chat", false);
  await enableSpeech(request);
  await page.goto(origin + "/books/1/lessons/1");
  await openAI(page);
  await page.getByRole("button", { name: "生成整课详解", exact: true }).click();
  const player = page.getByRole("region", { name: "AI 语音讲解" });
  const audio = page.locator('audio[aria-label="AI 讲解音频"]');
  await expect(player.getByRole("status")).toContainText("语音已保存");
  await player
    .getByRole("button", { name: "播放 AI 讲解", exact: true })
    .click();
  await expect
    .poll(() => audio.evaluate((element: HTMLAudioElement) => element.paused))
    .toBe(false);
  const oldSource = await audio.getAttribute("src");
  const oldCalls = speechCalls;
  let release!: () => void;
  speechGate = new Promise<void>((done) => {
    release = done;
  });
  try {
    await player
      .getByRole("button", { name: "重新生成语音", exact: true })
      .click();
    await expect(player.getByRole("status")).toContainText("正在生成语音");
    await expect(audio).toHaveAttribute("src", oldSource!);
    await expect
      .poll(() => audio.evaluate((element: HTMLAudioElement) => element.paused))
      .toBe(false);
    release();
    await expect(player.getByRole("status")).toContainText("语音已保存");
    await expect(audio).toHaveAttribute("src", oldSource!);
    expect(speechCalls).toBeGreaterThan(oldCalls);
    expect(scriptCalls).toBe(1);
    await player
      .getByRole("button", { name: "暂停 AI 讲解", exact: true })
      .click();
    await expect(audio).not.toHaveAttribute("src", oldSource!);
    await player
      .getByRole("button", { name: "播放 AI 讲解", exact: true })
      .click();
    await expect
      .poll(() => audio.evaluate((element: HTMLAudioElement) => element.paused))
      .toBe(false);
    await expect(audio).not.toHaveAttribute("src", oldSource!);
    // The only configurable player option is the playback rate.
    await expect(player.locator("select")).toHaveCount(1);
  } finally {
    release();
  }
});

test("settings save independent models and write-only keys", async ({
  page,
  request,
}) => {
  await page.goto(origin + "/settings");
  for (const { label, region, key, model } of [
    {
      label: "文字",
      region: "文字模型配置",
      key: "private-key-never-expose",
      model: "teaching",
    },
    {
      label: "生图",
      region: "生图模型配置",
      key: "image-private",
      model: "illustration",
    },
  ]) {
    const dialog = await editProvider(page, region);
    await dialog
      .getByLabel(`${label} Base URL`, { exact: true })
      .fill(providerURL + "/v1");
    await dialog.getByLabel(`${label} API Key`, { exact: true }).fill(key);
    await dialog.getByRole("button", { name: `获取${label}模型列表` }).click();
    await dialog
      .getByLabel(`${label} Model`, { exact: true })
      .selectOption(model);
    await dialog.getByRole("button", { name: `测试${label}连接` }).click();
    await expect(dialog.getByRole("status")).toContainText("连接成功");
    if (label === "文字")
      await dialog.getByLabel("文字接口协议").selectOption("responses");
    await saveProvider(page);
  }
  await page.getByLabel("允许 AI 在详解时按需生成配图").check();
  await page.getByRole("button", { name: "保存系统配置" }).click();
  await expect(page.getByText("配置已保存。", { exact: false })).toBeVisible();
  const response = await (
    await request.get(origin + "/api/settings/ai")
  ).text();
  expect(response).not.toContain("private-key-never-expose");
  expect(response).not.toContain("image-private");
  expect(response).toContain('"protocol":"responses"');
  expect(
    await page.evaluate(() => Object.values(localStorage).join(" ")),
  ).not.toContain("private-key-never-expose");
  await page.reload();
  for (const { label, region, model } of [
    { label: "文字", region: "文字模型配置", model: "teaching" },
    { label: "生图", region: "生图模型配置", model: "illustration" },
  ]) {
    const dialog = await editProvider(page, region);
    await expect(
      dialog.getByLabel(`${label} API Key`, { exact: true }),
    ).toHaveAttribute("placeholder", "已配置");
    await dialog.getByRole("button", { name: `测试${label}连接` }).click();
    await expect(dialog.getByRole("status")).toContainText("连接成功");
    await expect(
      dialog.getByLabel(`${label} Model`, { exact: true }),
    ).toHaveValue(model);
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
  }
  expect(counters.explanations + counters.images).toBe(0);
});

test("provider connection errors and removed models can be corrected without saving a draft", async ({
  page,
  request,
}) => {
  await configure(request);
  await page.goto(origin + "/settings");
  const text = await editProvider(page, "文字模型配置");
  await page.getByLabel("文字 API Key", { exact: true }).fill("bad-key");
  await page.getByRole("button", { name: "测试文字连接" }).click();
  await expect(text.getByRole("alert")).toContainText("认证失败");
  await expect(text).not.toContainText("private-key-never-expose");
  await page.getByLabel("文字 API Key", { exact: true }).fill("");
  failModels = true;
  await page.getByRole("button", { name: "获取文字模型列表" }).click();
  await expect(text.getByRole("alert")).toContainText("HTTP 503");
  failModels = false;
  modelIDs = ["new-provider-model", "illustration"];
  await page.getByRole("button", { name: "测试文字连接" }).click();
  await expect(text.getByRole("alert")).toContainText("当前模型未在列表中");
  await page
    .getByLabel("文字 Model", { exact: true })
    .selectOption("new-provider-model");
  await expect(text.getByRole("alert")).toHaveCount(0);
  await page.getByRole("button", { name: "测试文字连接" }).click();
  await expect(text.getByRole("status")).toContainText("连接成功");

  const { settings } = await (
    await request.get(origin + "/api/settings/ai")
  ).json();
  expect(settings.text.model).toBe("teaching");
  expect(settings.text.keySet).toBe(true);
  expect(counters.explanations + counters.images).toBe(0);
});

test("editing a provider cancels stale model lists and never forwards a saved key to a different address", async ({
  page,
  request,
}) => {
  await configure(request);
  await page.goto(origin + "/settings");
  const text = await editProvider(page, "文字模型配置");
  modelDelay = 350;
  await page.getByRole("button", { name: "获取文字模型列表" }).click();
  await expect.poll(() => counters.models).toBe(1);
  await page
    .getByLabel("文字 Base URL", { exact: true })
    .fill(providerURL + "/other");
  await page.waitForTimeout(450);
  await expect(text.getByRole("status")).toHaveCount(0);
  await expect(
    page
      .getByLabel("文字 Model", { exact: true })
      .locator('option[value="new-provider-model"]'),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "测试文字连接" }).click();
  await expect(text.getByRole("alert")).toContainText("服务地址已更改");
  expect(counters.models).toBe(1);
  await page
    .getByLabel("文字 Base URL", { exact: true })
    .fill(providerURL + "/v1");
  modelDelay = 0;
  await page.getByRole("button", { name: "获取文字模型列表" }).click();
  await page
    .getByLabel("文字 Model", { exact: true })
    .selectOption("new-provider-model");
  expect(counters.models).toBe(2);
});
test("manual personalized explanation calls image tools and reuses durable cache", async ({
  page,
  request,
}) => {
  await configure(request, "responses");
  await page.goto(origin + "/books/1/lessons/1");
  await openAI(page);
  expect(counters.explanations).toBe(0);
  const panel = page.getByRole("complementary", { name: "AI 详解" });
  await panel.getByRole("button", { name: "生成整课详解" }).click();
  await expect(panel.getByText("适合你的详解", { exact: true })).toBeVisible();
  await expect(panel.locator("img")).toBeVisible();
  expect(counters.images).toBe(1);
  expect(counters.explanations).toBe(2);
  await page.reload();
  await openAI(page);
  await expect(panel.getByText("适合你的详解", { exact: true })).toBeVisible();
  expect(counters.explanations).toBe(2);
  failText = true;
  await panel.getByRole("button", { name: "按当前水平重新生成详解" }).click();
  await expect(panel.getByRole("alert")).toContainText("模型认证失败");
  await expect(panel.getByText("适合你的详解", { exact: true })).toBeVisible();
  await expect(panel).not.toContainText("private-key-never-expose");
  if ((page.viewportSize()?.width || 1440) >= 1024) {
    const left = await page.locator(".ai-course-column").boundingBox(),
      right = await panel.boundingBox();
    expect(right!.x).toBeGreaterThan(left!.x + left!.width);
  }
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
test("tool selection controls model access, cache and required lesson material", async ({
  page,
  request,
}) => {
  await configure(request, "chat", false);
  await page.goto(origin + "/settings");
  const tools = page.getByRole("region", { name: "AI 工具配置" });
  await expect(tools.getByRole("checkbox")).toHaveCount(7);
  for (const checkbox of await tools.getByRole("checkbox").all())
    await expect(checkbox).toBeChecked();
  await tools.getByLabel("启用学习档案工具", { exact: true }).uncheck();
  await tools.getByLabel("启用当前学习状态工具", { exact: true }).uncheck();
  await page.getByRole("button", { name: "保存系统配置" }).click();
  await expect(page.getByText("配置已保存。", { exact: false })).toBeVisible();
  await page.reload();
  await expect(
    tools.getByLabel("启用学习档案工具", { exact: true }),
  ).not.toBeChecked();
  await page.goto(origin + "/books/1/lessons/1");
  await openAI(page);
  const panel = page.getByRole("complementary", { name: "AI 详解" });
  await panel.getByRole("button", { name: "生成整课详解" }).click();
  await expect(panel.getByText("适合你的详解", { exact: true })).toBeVisible();
  await expect(panel.locator(".ai-context")).toContainText("未读取学习档案");
  const firstRequest = modelRequests[0];
  expect(JSON.stringify(firstRequest)).not.toContain("learningContext");
  expect(JSON.stringify(firstRequest)).not.toContain("handbag");
  expect(firstRequest.tools).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        function: expect.objectContaining({ name: "get_current_lesson" }),
      }),
    ]),
  );
  expect(JSON.stringify(firstRequest.tools)).not.toContain(
    "get_learner_profile",
  );
  expect(JSON.stringify(firstRequest.tools)).not.toContain(
    "get_current_learning_state",
  );
  const lookup = await (
    await request.get(
      origin +
        "/api/ai/explanations?book=1&lesson=1&target=" +
        encodeURIComponent('{"kind":"lesson"}'),
    )
  ).json();
  expect(lookup.result.toolsUsed).toEqual([
    "get_learning_progress",
    "get_current_lesson",
  ]);
  await page.goto(origin + "/settings");
  await tools
    .getByRole("button", { name: "取消全选工具", exact: true })
    .click();
  await page.getByRole("button", { name: "保存系统配置" }).click();
  await expect(page.getByText("配置已保存。", { exact: false })).toBeVisible();
  await page.reload();
  await expect(tools.locator("input:checked")).toHaveCount(0);
  await page.goto(origin + "/books/1/lessons/1");
  await openAI(page);
  await panel
    .getByRole("button", { name: "生成整课详解", exact: true })
    .click();
  await expect(panel.getByRole("alert")).toContainText("当前课文");
  expect(modelRequests).toHaveLength(2);
  // Selected text remains usable without any read tools; no profile is implied.
  await openCourse(page);
  await page
    .getByRole("button", { name: "AI 详解句子：", exact: false })
    .first()
    .click();
  await expect(panel.getByText("适合你的详解", { exact: true })).toBeVisible();
  await expect(panel.locator(".ai-context")).toContainText("未读取学习档案");
  expect(modelRequests.at(-1)?.tools).toBeUndefined();
  await page.goto(origin + "/settings");
  await tools.getByRole("button", { name: "全选工具", exact: true }).click();
  await expect(tools.locator("input:checked")).toHaveCount(7);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
test("selected words explain once without starting point reading", async ({
  page,
  request,
}) => {
  await configure(request, "chat", false);
  await page.goto(origin + "/books/1/lessons/1");
  await expect(page.locator("[data-word-id='s1-w1']")).toBeVisible();
  await page.locator("[data-word-id='s1-w1']").evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
  await page.locator(".ai-selection-button").click();
  const panel = page.getByRole("complementary", { name: "AI 详解" });
  await expect(panel.getByText("适合你的详解", { exact: true })).toBeVisible();
  await expect(panel.locator(".ai-target")).toHaveText("this");
  expect(counters.explanations).toBe(2);
  await expect(page.locator("audio")).toHaveJSProperty("paused", true);
  await openCourse(page);
  await page.locator("[data-word-id='s1-w1']").click();
  await expect
    .poll(async () => page.locator("audio").getAttribute("src"))
    .toContain("/clips/s1-w1");
});
test("dynamic assessment updates abilities and server progress reaches another device", async ({
  page,
  request,
  browser,
}) => {
  test.setTimeout(60000);
  await configure(request, "chat", false);
  await page.goto(origin + "/learning-profile");
  await page.getByRole("button", { name: "开始或继续测评" }).click();
  for (let i = 0; i < 16; i++) {
    const section = page.getByRole("region", { name: "英语水平动态测评" });
    await expect(
      section.getByText(`第 ${i + 1} 题`, { exact: false }),
    ).toBeVisible();
    await expect(
      section.getByRole("radio", { name: "不知道", exact: true }),
    ).toBeVisible();
    await expect(
      section.getByRole("button", { name: "提交答案", exact: true }),
    ).toBeDisabled();
    if (i < 4)
      await section.getByRole("radio", { name: "不知道", exact: true }).check();
    else await section.getByRole("radio").first().check();
    await section
      .getByRole("button", { name: "提交答案", exact: true })
      .click();
    if (i === 0) {
      await expect(
        section.getByText("上一题选择了“不知道”", { exact: true }),
      ).toBeVisible();
      await page.reload();
      await page.getByRole("button", { name: "开始或继续测评" }).click();
      await expect(
        section.getByText("上一题选择了“不知道”", { exact: true }),
      ).toBeVisible();
    }
  }
  await expect(
    page.getByRole("heading", { name: "测评已完成，学习档案已更新" }),
  ).toBeVisible();
  const profile = await (
    await request.get(origin + "/api/learner/profile")
  ).json();
  expect(profile.level).toBe(1);
  expect(profile.abilities.listening.level).toBe(1);
  expect(profile.abilities.speaking.level).toBe(-1);
  expect(counters.questions).toBe(16);
  const sessions = await (
    await request.get(origin + "/api/assessments")
  ).json();
  const { session } = await (
    await request.get(origin + "/api/assessments/" + sessions[0].id)
  ).json();
  expect(
    session.answers.filter((answer: { unknown?: boolean }) => answer.unknown),
  ).toHaveLength(4);
  for (const answer of session.answers.slice(0, 4)) {
    expect(answer).toMatchObject({
      unknown: true,
      choice: -2,
      correct: false,
      skipped: false,
    });
  }
  await page.goto(origin + "/books/1/lessons/1");
  await page
    .getByRole("button", { name: "第一册第1课，标记已学", exact: true })
    .click();
  await expect
    .poll(async () => {
      const data = await (
        await request.get(origin + "/api/learner/progress")
      ).json();
      return data.tracks.text?.["1:1"]?.values.completed;
    })
    .toBe(true);
  await page.locator("audio").evaluate((audio: HTMLAudioElement) => {
    audio.currentTime = 4;
    audio.dispatchEvent(new Event("timeupdate"));
    audio.dispatchEvent(new Event("pause"));
  });
  await expect
    .poll(async () => {
      const data = await (
        await request.get(origin + "/api/learner/progress")
      ).json();
      return data.tracks.text?.["1:1"]?.values.position;
    })
    .toBeCloseTo(4, 1);
  const other = await browser.newContext();
  const second = await other.newPage();
  await second.goto(origin + "/books/1/lessons/1");
  await expect(
    second.getByRole("button", { name: "第一册第1课，标记未学", exact: true }),
  ).toBeVisible();
  await expect
    .poll(async () =>
      second
        .locator("audio")
        .evaluate((audio: HTMLAudioElement) => audio.currentTime),
    )
    .toBeCloseTo(4, 1);
  await other.close();
  await openAI(page);
  await page.getByRole("button", { name: "生成整课详解", exact: true }).click();
  await expect(page.locator(".ai-context")).toContainText(
    "按初级水平 · 复习生成",
  );
});

test("provider lists use isolated editors, immediate saves and persistent defaults", async ({
  page,
  request,
}) => {
  await configure(request);
  await enableSpeech(request);
  await page.goto(origin + "/settings");
  await page
    .getByLabel("通用系统提示词", { exact: true })
    .fill("尚未保存的提示词");
  const groups = [
    {
      group: "text",
      label: "文字",
      region: "文字模型配置",
      model: "new-provider-model",
      key: "private-key-never-expose",
    },
    {
      group: "image",
      label: "生图",
      region: "生图模型配置",
      model: "illustration",
      key: "image-private",
    },
    {
      group: "tts",
      label: "语音",
      region: "语音合成配置",
      model: "second-tts",
      key: "speech-private",
    },
  ] as const;
  for (const { group, label, region, model, key } of groups) {
    const list = page.getByRole("region", { name: region });
    await expect(
      list.getByRole("button", { name: "删除", exact: true }),
    ).toBeDisabled();
    await list.getByRole("button", { name: `添加${label} Provider` }).click();
    let dialog = page.getByRole("dialog");
    for (const field of ["Provider 名称", "Base URL", "API Key", "Model"]) {
      await expect(
        dialog.getByLabel(`${label} ${field}`, { exact: true }),
      ).toHaveValue("");
    }
    await dialog
      .getByLabel(`${label} Provider 名称`, { exact: true })
      .fill(`备用${label}`);
    await dialog
      .getByLabel(`${label} Base URL`, { exact: true })
      .fill(providerURL + "/v1");
    await dialog.getByLabel(`${label} API Key`, { exact: true }).fill(key);
    if (group === "tts") {
      await dialog.getByLabel("语音 Model", { exact: true }).fill(model);
      await dialog.getByLabel("语音音色 Voice").fill("second-voice");
      await dialog.getByText("讲课风格与兼容参数", { exact: true }).click();
      await dialog.getByLabel("语音高级参数 JSON").fill('{"language":"zh"}');
    } else {
      await dialog
        .getByRole("button", { name: `获取${label}模型列表` })
        .click();
      await dialog
        .getByLabel(`${label} Model`, { exact: true })
        .selectOption(model);
    }
    // Retry a failed save without losing any entered fields.
    if (group === "text") {
      await page.route(
        "**/api/settings/ai/providers/text",
        (route) =>
          route.fulfill({ status: 500, json: { error: "保存失败，请重试" } }),
        { times: 1 },
      );
      await dialog
        .getByRole("button", { name: "保存 Provider", exact: true })
        .click();
      await expect(dialog.getByRole("alert")).toContainText("保存失败");
      await expect(
        dialog.getByLabel("文字 API Key", { exact: true }),
      ).toHaveValue(key);
    }
    await saveProvider(page);
    await expect(
      page.getByLabel("通用系统提示词", { exact: true }),
    ).toHaveValue("尚未保存的提示词");
    const row = list.getByRole("listitem", {
      name: `备用${label}`,
      exact: true,
    });
    await expect(row).toContainText(model);
    let saved = (await (await request.get(origin + "/api/settings/ai")).json())
      .settings;
    expect(saved.providers[group]).toHaveLength(2);
    expect(saved.providers.defaults[group]).toBe(`legacy-${group}`);
    expect(saved.prompts.system).not.toBe("尚未保存的提示词");
    await row.getByRole("button", { name: "设为默认", exact: true }).click();
    await expect(row.getByText("默认", { exact: true })).toBeVisible();
    await expect(
      row.getByRole("button", { name: "删除", exact: true }),
    ).toBeDisabled();
    dialog = await editProvider(page, region, `备用${label}`);
    await expect(
      dialog.getByLabel(`${label} API Key`, { exact: true }),
    ).toHaveValue("");
    await expect(
      dialog.getByLabel(`${label} API Key`, { exact: true }),
    ).toHaveAttribute("placeholder", "已配置");
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    // Starting another creation clears saved and cancelled form values.
    await list.getByRole("button", { name: `添加${label} Provider` }).click();
    dialog = page.getByRole("dialog");
    for (const field of ["Provider 名称", "Base URL", "API Key", "Model"]) {
      await expect(
        dialog.getByLabel(`${label} ${field}`, { exact: true }),
      ).toHaveValue("");
    }
    if (group === "tts") {
      await expect(dialog.getByLabel("语音音色 Voice")).toHaveValue("");
      await dialog.getByText("讲课风格与兼容参数", { exact: true }).click();
      await expect(dialog.getByLabel("语音高级参数 JSON")).toHaveValue("{}");
    }
    await dialog
      .getByLabel(`${label} Provider 名称`, { exact: true })
      .fill("丢弃的草稿");
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await expect(list.getByRole("listitem")).toHaveCount(2);
  }
  await page.getByRole("button", { name: "保存系统配置" }).click();
  await expect(page.getByText("配置已保存。", { exact: false })).toBeVisible();
  await page.reload();
  let saved = (await (await request.get(origin + "/api/settings/ai")).json())
    .settings;
  for (const { group, region, model } of groups) {
    expect(saved[group].model).toBe(model);
    await expect(
      page.getByRole("region", { name: region }).getByRole("listitem"),
    ).toHaveCount(2);
  }
  expect(saved.image.enabled).toBe(true);
  expect(saved.tts.enabled).toBe(true);
  const tts = await editProvider(page, "语音合成配置", "备用语音");
  await tts.getByRole("button", { name: "生成短句试听" }).click();
  await expect(tts.getByLabel("语音试听")).toHaveAttribute("src", /^blob:/);
  await tts.getByRole("button", { name: "取消", exact: true }).click();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  for (const { label, region } of groups) {
    const list = page.getByRole("region", { name: region });
    await list
      .getByRole("listitem", { name: `原${label}服务`, exact: true })
      .getByRole("button", { name: "设为默认", exact: true })
      .click();
    await expect(
      list
        .getByRole("listitem", { name: `原${label}服务`, exact: true })
        .getByText("默认", { exact: true }),
    ).toBeVisible();
    page.once("dialog", (d) => d.accept());
    await list
      .getByRole("listitem", { name: `备用${label}`, exact: true })
      .getByRole("button", { name: "删除", exact: true })
      .click();
    await expect(list.getByRole("listitem")).toHaveCount(1);
  }
  await restartSpeechBackend(request);
  saved = (await (await request.get(origin + "/api/settings/ai")).json())
    .settings;
  expect(saved.text.model).toBe("teaching");
  expect(saved.tts.voice).toBe("teacher");
});

test("local definitions display immediately and AI expansion is explicit, cached and survives restart", async ({
  page,
  request,
}) => {
  await configure(request, "chat", false);
  await page.goto(origin + "/books/1/lessons/1");
  await page.getByRole("tab", { name: "单词 · 1" }).click();
  const entry = page.getByRole("article", {
    name: "单词：handbag",
    exact: true,
  });
  const expansion = entry.getByRole("button", { name: "AI 拓展单词：handbag" });
  await expect(entry.locator(".vocabulary-basic")).toHaveAttribute("open", "");
  await expect(entry.getByRole("region", { name: "词典释义" })).toContainText(
    "n. 手提包；女用手袋",
  );
  await expect(entry.getByLabel("词典音标")).toContainText("/ˈhændbæɡ/");
  await expect(expansion).toHaveAttribute("aria-expanded", "false");
  expect(counters.vocabulary).toBe(0);
  await expansion.click();
  await expect(expansion).toHaveAttribute("aria-expanded", "true");
  await expect(
    entry.getByText("This handbag is mine.", { exact: true }),
  ).toBeVisible();
  await expect(expansion).toContainText("已缓存");
  expect(counters.vocabulary).toBe(1);
  expect(JSON.stringify(modelRequests)).toContain("n. 手提包；女用手袋");
  await expansion.click();
  await expect(
    entry.getByText("This handbag is mine.", { exact: true }),
  ).not.toBeVisible();
  await expansion.click();
  await expect(
    entry.getByText("This handbag is mine.", { exact: true }),
  ).toBeVisible();
  expect(counters.vocabulary).toBe(1);
  await restartSpeechBackend(request);
  await page.reload();
  await page.getByRole("tab", { name: "单词 · 1" }).click();
  await expect(expansion).toHaveAttribute("aria-expanded", "false");
  await expect(expansion).toContainText("已缓存");
  expect(counters.vocabulary).toBe(1);
  await expansion.click();
  await expect(
    entry.getByText("This handbag is mine.", { exact: true }),
  ).toBeVisible();
  expect(counters.vocabulary).toBe(1);
  await expect(entry.getByRole("region", { name: "词典释义" })).toContainText(
    "n. 手提包；女用手袋",
  );
});

for (const apiType of ["doubao-tts", "doubao-audio"] as const) {
  test(`native ${apiType} settings drive preview and lecture generation`, async ({
    page,
    request,
  }) => {
    await configure(request);
    await page.goto(origin + "/settings");
    await page.getByRole("button", { name: "添加语音 Provider" }).click();
    const dialog = page.getByRole("dialog");
    await dialog
      .getByLabel("语音 Provider 名称", { exact: true })
      .fill("豆包老师");
    await dialog.getByLabel("语音接口类型").selectOption(apiType);
    await expect(
      dialog.getByLabel("语音 Base URL", { exact: true }),
    ).toHaveValue("https://openspeech.bytedance.com/api/v3");
    await expect(
      dialog.getByRole("button", { name: "获取语音模型列表" }),
    ).toHaveCount(0);
    await expect(
      dialog.getByLabel("合成语速", { exact: true }),
    ).toHaveAttribute("min", "0.5");
    await expect(
      dialog.getByLabel("合成语速", { exact: true }),
    ).toHaveAttribute("max", "2");
    await dialog
      .getByLabel("语音 Base URL", { exact: true })
      .fill(providerURL + "/v1");
    await dialog
      .getByLabel("语音 API Key", { exact: true })
      .fill("speech-private");
    await dialog
      .getByLabel("语音音色 Voice")
      .fill("zh_female_vv_uranus_bigtts");
    await dialog.getByRole("button", { name: "生成短句试听" }).click();
    await expect(dialog.getByLabel("语音试听")).toHaveAttribute(
      "src",
      /^blob:/,
    );
    expect(counters.models).toBe(0);
    if (apiType === "doubao-tts")
      expect(modelRequests.at(-1)).toHaveProperty("req_params.text");
    else expect(modelRequests.at(-1)).toHaveProperty("text_prompt");
    await saveProvider(page);
    const row = page.getByRole("listitem", { name: "豆包老师", exact: true });
    await row.getByRole("button", { name: "设为默认", exact: true }).click();
    await expect(row.getByText("默认", { exact: true })).toBeVisible();
    await page.getByLabel("自动生成 AI 详解语音").check();
    await page.getByRole("button", { name: "保存系统配置" }).click();
    await expect(
      page.getByText("配置已保存。", { exact: false }),
    ).toBeVisible();
    await page.goto(origin + "/books/1/lessons/1");
    await openAI(page);
    await page
      .getByRole("button", { name: "生成整课详解", exact: true })
      .click();
    const speech = page.getByRole("region", { name: "AI 语音讲解" });
    await expect(
      speech.getByRole("button", { name: "播放 AI 讲解", exact: true }),
    ).toBeEnabled({ timeout: 15000 });
    expect(speechCalls).toBeGreaterThan(1);
  });
}
