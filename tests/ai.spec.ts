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
  backend = spawn(join(binaryRoot, "firstleap"), [], {
    env: {
      ...process.env,
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

test("TTS settings support manual models, draft preview and persistent private keys", async ({
  page,
  request,
}) => {
  await configure(request, "chat", false);
  await page.goto(origin + "/settings");
  const section = page.getByRole("region", { name: "语音合成配置" });
  await section.getByLabel("自动生成 AI 详解语音").check();
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
  const speech = modelRequests.find(
    (input) => input.model === "manually-specified-model",
  )!;
  expect(speech).toMatchObject({
    voice: "Serena",
    speed: 0.85,
    instruct: "像耐心的老师讲课",
    lang_code: "zh",
    response_format: "mp3",
  });
  expect(speech).not.toHaveProperty("instructions");
  const before = await (await request.get(origin + "/api/settings/ai")).json();
  expect(before.settings.tts.enabled).toBe(false);
  await page.getByRole("button", { name: "保存系统配置" }).click();
  await expect(page.getByText("配置已保存。", { exact: false })).toBeVisible();
  await expect(section.getByLabel("语音 API Key", { exact: true })).toHaveValue(
    "",
  );
  await page.reload();
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
  await page
    .getByLabel("文字 Base URL", { exact: true })
    .fill(providerURL + "/v1");
  await page
    .getByLabel("文字 API Key", { exact: true })
    .fill("private-key-never-expose");
  await page.getByRole("button", { name: "获取文字模型列表" }).click();
  await page.getByLabel("文字 Model", { exact: true }).selectOption("teaching");
  await page.getByRole("button", { name: "测试文字连接" }).click();
  await expect(
    page.getByRole("region", { name: "文字模型配置" }).getByRole("status"),
  ).toContainText("连接成功");
  await page.getByLabel("文字接口协议").selectOption("responses");
  await page.getByLabel("允许 AI 在详解时按需生成配图").check();
  await page
    .getByLabel("生图 Base URL", { exact: true })
    .fill(providerURL + "/v1");
  await page.getByLabel("生图 API Key", { exact: true }).fill("image-private");
  await page.getByRole("button", { name: "获取生图模型列表" }).click();
  await page
    .getByLabel("生图 Model", { exact: true })
    .selectOption("illustration");
  await page.getByRole("button", { name: "测试生图连接" }).click();
  await expect(
    page.getByRole("region", { name: "生图模型配置" }).getByRole("status"),
  ).toContainText("连接成功");
  expect(counters.explanations + counters.images).toBe(0);
  await page.getByRole("button", { name: "保存系统配置" }).click();
  await expect(page.getByText("配置已保存。", { exact: false })).toBeVisible();
  await expect(page.getByLabel("文字 API Key", { exact: true })).toHaveValue(
    "",
  );
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
  await expect(
    page.getByLabel("文字 API Key", { exact: true }),
  ).toHaveAttribute("placeholder", "已配置");
  await page.getByRole("button", { name: "测试文字连接" }).click();
  await expect(
    page.getByRole("region", { name: "文字模型配置" }).getByRole("status"),
  ).toContainText("连接成功");
  await page.getByRole("button", { name: "测试生图连接" }).click();
  await expect(
    page.getByRole("region", { name: "生图模型配置" }).getByRole("status"),
  ).toContainText("连接成功");
  await expect(page.getByLabel("文字 Model", { exact: true })).toHaveValue(
    "teaching",
  );
  await expect(page.getByLabel("生图 Model", { exact: true })).toHaveValue(
    "illustration",
  );
  expect(counters.explanations + counters.images).toBe(0);
});

test("provider connection errors and removed models can be corrected without saving a draft", async ({
  page,
  request,
}) => {
  await configure(request);
  await page.goto(origin + "/settings");
  const text = page.getByRole("region", { name: "文字模型配置" });
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
  await expect(page.getByLabel("生图 Model", { exact: true })).toHaveValue(
    "illustration",
  );
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
  modelDelay = 350;
  await page.getByRole("button", { name: "获取文字模型列表" }).click();
  await expect.poll(() => counters.models).toBe(1);
  await page
    .getByLabel("文字 Base URL", { exact: true })
    .fill(providerURL + "/other");
  await page.waitForTimeout(450);
  const text = page.getByRole("region", { name: "文字模型配置" });
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

test("multiple providers keep independent drafts, defaults and credentials across reloads", async ({
  page,
  request,
}) => {
  await configure(request);
  await enableSpeech(request);
  await page.goto(origin + "/settings");
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
  const ids: Record<string, string> = {};
  for (const { group, label, region, model, key } of groups) {
    const section = page.getByRole("region", { name: region });
    const editing = section.getByLabel(`编辑${label} Provider`, {
      exact: true,
    });
    const defaultProvider = section.getByLabel(`默认${label} Provider`, {
      exact: true,
    });
    await expect(
      section.getByRole("button", { name: `删除${label} Provider` }),
    ).toBeDisabled();
    await section
      .getByRole("button", { name: `添加${label} Provider` })
      .click();
    ids[group] = await editing.inputValue();
    await section
      .getByLabel(`${label} Provider 名称`, { exact: true })
      .fill(`备用${label}`);
    await section
      .getByLabel(`${label} Base URL`, { exact: true })
      .fill(providerURL + "/v1");
    await section.getByLabel(`${label} API Key`, { exact: true }).fill(key);
    if (group === "tts") {
      await section.getByLabel("语音 Model", { exact: true }).fill(model);
      await section.getByLabel("语音音色 Voice").fill("second-voice");
      await section.getByText("讲课风格与兼容参数", { exact: true }).click();
      await section.getByLabel("语音高级参数 JSON").fill('{"language":"zh"}');
    } else {
      await section
        .getByRole("button", { name: `获取${label}模型列表` })
        .click();
      await section
        .getByLabel(`${label} Model`, { exact: true })
        .selectOption(model);
    }
    await expect(defaultProvider).toHaveValue(`legacy-${group}`);
    await editing.selectOption(`legacy-${group}`);
    await expect(
      section.getByLabel(`${label} API Key`, { exact: true }),
    ).toHaveValue("");
    await editing.selectOption(ids[group]);
    await expect(
      section.getByLabel(`${label} API Key`, { exact: true }),
    ).toHaveValue(key);
    await expect(
      section.getByLabel(`${label} Model`, { exact: true }),
    ).toHaveValue(model);
    if (group === "tts") {
      await section.getByText("讲课风格与兼容参数", { exact: true }).click();
      await expect(section.getByLabel("语音高级参数 JSON")).toHaveValue(
        '{"language":"zh"}',
      );
    }
    await defaultProvider.selectOption(ids[group]);
    await expect(
      section.getByRole("button", { name: `删除${label} Provider` }),
    ).toBeDisabled();
  }
  await page.getByRole("button", { name: "保存系统配置" }).click();
  await expect(page.getByText("配置已保存。", { exact: false })).toBeVisible();
  await page.reload();
  let saved = await (await request.get(origin + "/api/settings/ai")).json();
  for (const { group, label, region, model } of groups) {
    const section = page.getByRole("region", { name: region });
    await expect(
      section.getByLabel(`默认${label} Provider`, { exact: true }),
    ).toHaveValue(ids[group]);
    await expect(
      section.getByLabel(`${label} Model`, { exact: true }),
    ).toHaveValue(model);
    await expect(
      section.getByLabel(`${label} API Key`, { exact: true }),
    ).toHaveAttribute("placeholder", "已配置");
    expect(saved.settings.providers[group]).toHaveLength(2);
    expect(saved.settings[group].model).toBe(model);
    expect(saved.settings.providers[group][0].config.keySet).toBe(true);
  }
  expect(saved.settings.image.enabled).toBe(true);
  expect(saved.settings.tts.enabled).toBe(true);
  expect(saved.settings.tts.extra).toEqual({ language: "zh" });
  await page.getByRole("button", { name: "测试文字连接" }).click();
  await expect(
    page.getByRole("region", { name: "文字模型配置" }).getByRole("status"),
  ).toContainText("连接成功");
  const tts = page.getByRole("region", { name: "语音合成配置" });
  await tts.getByRole("button", { name: "生成短句试听" }).click();
  await expect(tts.getByLabel("语音试听")).toHaveAttribute("src", /^blob:/);
  expect(
    modelRequests.find((input) => input.model === "second-tts"),
  ).toMatchObject({ voice: "second-voice", language: "zh" });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  for (const { group, label, region } of groups) {
    const section = page.getByRole("region", { name: region });
    await section
      .getByLabel(`默认${label} Provider`, { exact: true })
      .selectOption(`legacy-${group}`);
    await section
      .getByRole("button", { name: `删除${label} Provider` })
      .click();
    await expect(
      section.getByLabel(`编辑${label} Provider`, { exact: true }),
    ).toHaveValue(`legacy-${group}`);
  }
  await page.getByRole("button", { name: "保存系统配置" }).click();
  await expect(page.getByText("配置已保存。", { exact: false })).toBeVisible();
  saved = await (await request.get(origin + "/api/settings/ai")).json();
  for (const { group } of groups) {
    expect(saved.settings.providers[group]).toHaveLength(1);
    expect(saved.settings.providers.defaults[group]).toBe(`legacy-${group}`);
    expect(saved.settings[group].keySet).toBe(true);
  }
  await restartSpeechBackend(request);
  saved = await (await request.get(origin + "/api/settings/ai")).json();
  expect(saved.settings.text.model).toBe("teaching");
  expect(saved.settings.tts.voice).toBe("teacher");
});
