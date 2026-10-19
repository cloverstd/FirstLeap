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
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

let binaryRoot: string,
  runRoot: string,
  backend: ChildProcess,
  provider: Server,
  origin: string,
  providerURL: string;
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
    if (payload.dimension) {
      counters.questions++;
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
    if (payload.evidence) {
      counters.evaluations++;
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
    counters.explanations++;
    if (failText) {
      res.writeHead(401);
      res.end(JSON.stringify({ error: "private-key-never-expose" }));
      return;
    }
    const toolResult = messages.find(
      (m: { role?: string; type?: string }) =>
        m.role === "tool" || m.type === "function_call_output",
    );
    if (input.tools?.length && !toolResult) {
      if (input.messages)
        res.end(
          JSON.stringify({
            choices: [
              {
                finish_reason: "tool_calls",
                message: {
                  role: "assistant",
                  content: "",
                  tool_calls: [
                    {
                      id: "illustration",
                      type: "function",
                      function: {
                        name: "generate_image",
                        arguments: JSON.stringify({
                          prompt: "a handbag on a desk",
                          caption: "课文里的手提包",
                        }),
                      },
                    },
                  ],
                },
              },
            ],
          }),
        );
      else
        res.end(
          JSON.stringify({
            status: "completed",
            output: [
              {
                type: "function_call",
                call_id: "illustration",
                name: "generate_image",
                arguments: JSON.stringify({
                  prompt: "a handbag on a desk",
                  caption: "课文里的手提包",
                }),
              },
            ],
          }),
        );
      return;
    }
    const context = payload.learningContext as
      | { profile?: { level?: number }; stage?: string }
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
  expect(counters.explanations).toBe(1);
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
