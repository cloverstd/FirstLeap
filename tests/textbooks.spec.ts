import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let directory: string;
let full: Buffer, wordClip: Buffer, sentenceClip: Buffer, video: Buffer;
const sentence = (id: string, start: number) => ({
  id,
  text: "Is this your handbag?",
  translationZh: "这是你的手提包吗？",
  start,
  end: start + 1.8,
  words: ["Is", "this", "your", "handbag?"].map((text, i) => ({
    id: `${id}-w${i}`,
    text,
    before: i ? " " : "",
    start: start + i * 0.4,
    end: start + i * 0.4 + 0.35,
  })),
});
const detail = {
  book: 1,
  lesson: 1,
  label: "Lesson 1 & 2",
  titleEn: "Excuse me!",
  titleZh: "对不起！",
  instruction: "Listen to the tape then answer this question.",
  instructionZh: "听录音，回答问题。",
  question: "Whose handbag is it?",
  paragraphs: [{ id: "p0", sentences: [sentence("s1", 2), sentence("s2", 5)] }],
  vocabulary: [
    {
      id: "v0",
      word: "handbag",
      pos: "n.",
      meaning: "手提包",
      pronunciationId: "0123456789abcdef01234567",
      ready: true,
    },
  ],
  translation: ["这是你的手提包吗？"],
  duration: 10,
  revision: "browser-test",
  alignment: "ready",
  lectureLessonId: "lesson1",
};
const summary = {
  lesson: 1,
  label: detail.label,
  titleEn: detail.titleEn,
  titleZh: detail.titleZh,
  duration: 10,
  alignment: "ready",
  lectureLessonId: "lesson1",
};
const book = {
  book: 1,
  name: "新概念英语 第一册 英语初阶",
  subtitleEn: "First Things First",
  available: true,
  lessonCount: 1,
  lessons: [summary],
  downloads: ["epub", "pdf", "azw3", "mobi"],
};

test.beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "firstleap-textbooks-"));
  const create = (name: string, seconds: string, format: string[]) => {
    const path = join(directory, name);
    execFileSync("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=440:sample_rate=24000:duration=${seconds}`,
      ...format,
      path,
    ]);
    return readFileSync(path);
  };
  full = create("full.mp3", "10", ["-c:a", "libmp3lame"]);
  wordClip = create("word.wav", "0.39", ["-c:a", "pcm_s16le"]);
  sentenceClip = create("sentence.wav", "1.8", ["-c:a", "pcm_s16le"]);
  const path = join(directory, "video.mp4");
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=black:s=320x240:r=10",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=44100",
    "-t",
    "10",
    "-c:v",
    "libx264",
    "-threads",
    "1",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-movflags",
    "+faststart",
    path,
  ]);
  video = readFileSync(path);
});
test.afterAll(() => rmSync(directory, { recursive: true, force: true }));
test.beforeEach(async ({ page }) => {
  await page.route("**/api/courses/ncese01", (route) =>
    route.fulfill({
      json: {
        id: "ncese01",
        title: "新概念英语第一册",
        teacher: "霍娜",
        description: "测试",
        sourceAvailable: true,
        indexing: false,
        duration: 10,
        lessons: [
          {
            id: "lesson1",
            order: 1,
            label: "Lesson 1 & 2",
            title: "Excuse me! 对不起！",
            duration: 10,
            thumbnail: false,
            textbook: { book: 1, lesson: 1 },
          },
        ],
      },
    }),
  );
  await page.route("**/api/books", (route) =>
    route.fulfill({ json: [1, 2, 3, 4].map((n) => ({ ...book, book: n })) }),
  );
  await page.route("**/api/books/1", (route) => route.fulfill({ json: book }));
  await page.route("**/api/books/1/lessons/1", (route) =>
    route.fulfill({ json: detail }),
  );
  await page.route(
    /\/(audio|clips\/[^/]+|pronunciations\/[^/]+|lessons\/(?:lesson1|intro)\/video)$/,
    (route) => {
      const url = route.request().url();
      const data = url.endsWith("/video")
        ? video
        : url.endsWith("/audio")
          ? full
          : url.includes("-w") || url.includes("/pronunciations/")
            ? wordClip
            : sentenceClip;
      const contentType = url.endsWith("/video")
        ? "video/mp4"
        : url.endsWith("/audio")
          ? "audio/mpeg"
          : "audio/wav";
      const range = route
        .request()
        .headers()
        .range?.match(/bytes=(\d+)-(\d*)/);
      if (!range) return route.fulfill({ body: data, contentType });
      const start = Number(range[1]),
        end = Math.min(Number(range[2] || data.length - 1), data.length - 1);
      if (start >= data.length)
        return route.fulfill({
          status: 416,
          headers: { "Content-Range": `bytes */${data.length}` },
        });
      return route.fulfill({
        status: 206,
        contentType,
        body: data.subarray(start, end + 1),
        headers: {
          "Accept-Ranges": "bytes",
          "Content-Range": `bytes ${start}-${end}/${data.length}`,
        },
      });
    },
  );
});
async function loaded(page: Page) {
  await page.waitForFunction(
    () => (document.querySelector("audio")?.readyState || 0) >= 2,
  );
}

test("four books, searchable contents and mobile reading stay usable without video", async ({
  page,
}) => {
  await page.route("**/api/courses/ncese01", (route) =>
    route.fulfill({ status: 503, json: { error: "video offline" } }),
  );
  await page.goto("/books");
  await expect(page.locator(".textbook-cover")).toHaveCount(4);
  await page.locator(".textbook-cover").first().click();
  await page.getByRole("textbox", { name: "搜索课文" }).fill("Excuse");
  await expect(page.locator(".textbook-lesson-card")).toHaveCount(1);
  await expect(
    page.getByRole("link", { name: "EPUB", exact: true }),
  ).toHaveAttribute("href", "/api/books/1/downloads/epub");
  await page.locator(".textbook-lesson-card").click();
  await expect(
    page.getByRole("heading", { name: "Excuse me!", exact: true }),
  ).toBeVisible();
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await expect(
      page.getByRole("button", { name: "播放整课", exact: true }),
    ).toBeVisible();
    if (width < 800) {
      await page.getByRole("tab", { name: "单词 · 1" }).click();
      await expect(
        page.getByRole("button", { name: "生词发音：handbag" }),
      ).toBeVisible();
      await page.getByRole("tab", { name: "课文", exact: true }).click();
    }
  }
  await page
    .getByRole("button", { name: "展开第 1 句译文", exact: true })
    .click();
  await expect(page.locator(".reading-translation").first()).toContainText(
    "这是你的手提包吗",
  );
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Excuse me!", exact: true }),
  ).toBeVisible();
});

test("word clips use the selected occurrence and repeat on their natural end", async ({
  page,
  isMobile,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/books/1/lessons/1");
  await loaded(page);
  await page.getByRole("button", { name: "循环模式" }).click();
  await page
    .getByRole("menuitemradio", { name: "选中内容循环", exact: true })
    .click();
  await page.getByRole("combobox", { name: "精听倍速" }).click();
  await page.getByRole("option", { name: "1.25×", exact: true }).click();
  await page
    .getByRole("button", { name: "点读单词：handbag?", exact: true })
    .nth(1)
    .click();
  await loaded(page);
  await expect
    .poll(() =>
      page.locator("audio").evaluate((a: HTMLAudioElement) => a.currentSrc),
    )
    .toContain("/clips/s2-w3");
  await page.locator("audio").evaluate((a) => {
    a.dataset.ends = "0";
    a.addEventListener("ended", () => {
      a.dataset.ends = String(Number(a.dataset.ends) + 1);
    });
  });
  await expect
    .poll(() => page.locator("audio").getAttribute("data-ends"), {
      timeout: 10000,
    })
    .toMatch(/^[2-9]/);
  expect(
    await page
      .locator("audio")
      .evaluate((a: HTMLAudioElement) => [a.playbackRate, a.preservesPitch]),
  ).toEqual([1.25, true]);
  await page.getByRole("button", { name: "暂停精听" }).click();
  const count = await page.locator("audio").getAttribute("data-ends");
  await page.waitForTimeout(1000);
  expect(await page.locator("audio").getAttribute("data-ends")).toBe(count);
  expect(
    await page.locator("audio").evaluate((a: HTMLAudioElement) => a.paused),
  ).toBe(true);
  const stored = await page.evaluate(
    () =>
      JSON.parse(localStorage.getItem("firstleap.textbook.progress.v1")!)
        .lessons["1:1"],
  );
  expect(stored.completed).toBe(false);
  expect(stored.position).toBe(0);
  await page.getByRole("tab", { name: "单词 · 1" }).click();
  await page.getByRole("button", { name: "生词发音：handbag" }).click();
  await expect
    .poll(() =>
      page.locator("audio").evaluate((a: HTMLAudioElement) => a.currentSrc),
    )
    .toContain("/api/pronunciations/");
  const beforeVocabulary = Number(
    await page.locator("audio").getAttribute("data-ends"),
  );
  await expect
    .poll(
      async () => Number(await page.locator("audio").getAttribute("data-ends")),
      { timeout: 10000 },
    )
    .toBeGreaterThan(beforeVocabulary + 1);
  await page.getByRole("button", { name: "暂停精听" }).click();
  if (isMobile) {
    await page.getByRole("button", { name: "播放整课", exact: true }).click();
    await expect(page.getByRole("tab", { name: "单词 · 1" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  }
  expect(errors).toEqual([]);
});

test("full lesson seek, highlights and resume survive temporary point reading", async ({
  page,
}) => {
  await page.goto("/books/1/lessons/1");
  await loaded(page);
  await page.getByRole("button", { name: "播放整课" }).click();
  await loaded(page);
  await page.locator("audio").evaluate((a: HTMLAudioElement) => {
    a.pause();
    a.currentTime = 3.3;
  });
  await expect(page.locator(".current-word")).toHaveText("handbag?");
  await page
    .getByRole("button", {
      name: "点读句子：Is this your handbag?",
      exact: true,
    })
    .nth(1)
    .click();
  await loaded(page);
  await expect
    .poll(() =>
      page.locator("audio").evaluate((a: HTMLAudioElement) => a.currentSrc),
    )
    .toContain("/clips/s2");
  await page.getByRole("button", { name: "暂停精听" }).click();
  await page.reload();
  await loaded(page);
  await expect
    .poll(() =>
      page.locator("audio").evaluate((a: HTMLAudioElement) => a.currentTime),
    )
    .toBeCloseTo(3.3, 1);
  const seek = page.getByRole("slider", { name: "课文音频进度" });
  await seek.focus();
  await seek.press("Home");
  for (let i = 0; i < 118; i++) await seek.press("ArrowRight");
  await loaded(page);
  await expect
    .poll(() =>
      page.locator("audio").evaluate((a: HTMLAudioElement) => a.currentTime),
    )
    .toBeCloseTo(5.9, 1);
  expect(
    await page.locator("audio").evaluate((a: HTMLAudioElement) => a.paused),
  ).toBe(true);
  await page
    .locator("audio")
    .evaluate((a) => a.dispatchEvent(new Event("error")));
  await expect(page.getByRole("alert")).toContainText("音频暂时无法播放");
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await loaded(page);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("classroom text mode releases video and shares progress with the ebook", async ({
  page,
}) => {
  await page.goto("/learn/lesson1");
  await expect(page.locator("video")).toHaveCount(1);
  await page.getByRole("button", { name: "课文精听", exact: true }).click();
  await loaded(page);
  await expect(page.locator("video")).toHaveCount(0);
  await page.getByRole("button", { name: "播放整课" }).click();
  await loaded(page);
  await page.locator("audio").evaluate((a: HTMLAudioElement) => {
    a.pause();
    a.currentTime = 2.7;
  });
  await expect
    .poll(() =>
      page.locator("audio").evaluate((a: HTMLAudioElement) => a.currentTime),
    )
    .toBeCloseTo(2.7, 1);
  await page.getByRole("button", { name: "课程讲解", exact: true }).click();
  await expect(page.locator("audio")).toHaveCount(0);
  await expect(page.locator("video")).toHaveCount(1);
  await page.goto("/books/1/lessons/1");
  await loaded(page);
  await expect
    .poll(() =>
      page.locator("audio").evaluate((a: HTMLAudioElement) => a.currentTime),
    )
    .toBeCloseTo(2.7, 1);
});

test("sentence navigation retains its position after a natural clip end", async ({
  page,
}) => {
  await page.goto("/books/1/lessons/1");
  await loaded(page);
  await page
    .getByRole("button", {
      name: "点读句子：Is this your handbag?",
      exact: true,
    })
    .first()
    .click();
  await loaded(page);
  await page.waitForFunction(() => document.querySelector("audio")!.ended);
  await page.getByRole("button", { name: "下一句", exact: true }).click();
  await loaded(page);
  await expect
    .poll(() =>
      page.locator("audio").evaluate((a: HTMLAudioElement) => a.currentSrc),
    )
    .toContain("/clips/s2");
  await page.waitForFunction(() => document.querySelector("audio")!.ended);
  await expect(
    page.getByRole("button", { name: "下一句", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "上一句", exact: true }).click();
  await expect
    .poll(() =>
      page.locator("audio").evaluate((a: HTMLAudioElement) => a.currentSrc),
    )
    .toContain("/clips/s1");
});

test("remembering text mode still opens an introductory video lesson", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem("firstleap.player-mode.v1", "text"),
  );
  await page.route("**/api/courses/ncese01", (route) =>
    route.fulfill({
      json: {
        id: "ncese01",
        title: "新概念英语第一册",
        teacher: "霍娜",
        description: "测试",
        sourceAvailable: true,
        indexing: false,
        duration: 10,
        lessons: [
          {
            id: "intro",
            order: 0,
            label: "导学课",
            title: "教程导学",
            duration: 10,
            thumbnail: false,
          },
        ],
      },
    }),
  );
  await page.goto("/learn/intro");
  await expect(page.locator("video")).toHaveCount(1);
  await page.waitForFunction(
    () => (document.querySelector("video")?.readyState || 0) >= 2,
  );
  await expect(
    page.getByRole("heading", { name: "教程导学", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".complete-button")).toBeEnabled();
});

test("pausing during a pending repeat also cancels late playback", async ({
  page,
}) => {
  await page.goto("/books/1/lessons/1");
  await loaded(page);
  await page.getByRole("button", { name: "循环模式" }).click();
  await page
    .getByRole("menuitemradio", { name: "选中内容循环", exact: true })
    .click();
  await page
    .getByRole("button", { name: "点读单词：handbag?", exact: true })
    .first()
    .click();
  await loaded(page);
  await page.locator("audio").evaluate((audio: HTMLAudioElement) => {
    const nativePlay = audio.play.bind(audio);
    audio.dataset.ends = "0";
    audio.addEventListener("ended", () => {
      audio.dataset.ends = String(Number(audio.dataset.ends) + 1);
    });
    audio.play = () =>
      new Promise<void>((resolve) => {
        audio.dataset.pendingRepeat = "true";
        (window as unknown as { releaseRepeat: () => void }).releaseRepeat =
          () => {
            audio.play = nativePlay;
            void nativePlay().then(resolve, resolve);
          };
      });
  });
  await expect
    .poll(() => page.locator("audio").getAttribute("data-pending-repeat"))
    .toBe("true");
  await page.getByRole("button", { name: "暂停精听" }).click();
  const ended = await page.locator("audio").getAttribute("data-ends");
  await page.evaluate(() =>
    (window as unknown as { releaseRepeat: () => void }).releaseRepeat(),
  );
  await page.waitForTimeout(1200);
  expect(
    await page.locator("audio").evaluate((a: HTMLAudioElement) => a.paused),
  ).toBe(true);
  expect(await page.locator("audio").getAttribute("data-ends")).toBe(ended);
  await expect(
    page.getByRole("button", { name: "播放精听", exact: true }),
  ).toBeVisible();
});

test("sentence translations start collapsed and tabs work on every screen", async ({
  page,
}) => {
  await page.goto("/books/1/lessons/1");
  await loaded(page);
  await expect(page.locator(".reading-translation")).toHaveCount(0);
  const first = page.getByRole("button", {
    name: "展开第 1 句译文",
    exact: true,
  });
  await first.click();
  await expect(page.locator(".reading-translation")).toHaveCount(1);
  await expect(page.locator(".reading-sentence").first()).toContainText(
    "这是你的手提包吗？",
  );
  await expect(page.locator("audio")).toHaveJSProperty("paused", true);
  await page.getByRole("button", { name: "展开全部译文", exact: true }).click();
  await expect(page.locator(".reading-translation")).toHaveCount(2);
  await page.getByRole("tab", { name: "单词 · 1" }).click();
  await expect(page.locator(".reading-passage")).toBeHidden();
  await expect(
    page.getByRole("button", { name: "生词发音：handbag" }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "课文", exact: true }).click();
  await page.reload();
  await expect(page.locator(".reading-translation")).toHaveCount(0);
});

test("speed selection keeps its keyboard input separate from sentence navigation", async ({
  page,
}) => {
  await page.goto("/books/1/lessons/1");
  await loaded(page);
  await page.getByRole("combobox", { name: "精听倍速" }).click();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("audio")).toHaveJSProperty("paused", true);
  expect(
    await page.locator("audio").evaluate((a: HTMLAudioElement) => a.currentSrc),
  ).toContain("/audio");
  await page.keyboard.press("Escape");
  await page.getByRole("region", { name: "课文精听", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect
    .poll(() =>
      page.locator("audio").evaluate((a: HTMLAudioElement) => a.currentSrc),
    )
    .toContain("/clips/s1");
});

test("whole lesson repeats naturally and manual completion survives playback saves", async ({
  page,
}) => {
  await page.goto("/books/1/lessons/1");
  await loaded(page);
  await page.getByRole("combobox", { name: "精听倍速" }).click();
  await page.getByRole("option", { name: "1.5×", exact: true }).click();
  await page.getByRole("button", { name: "循环模式" }).click();
  await page
    .getByRole("menuitemradio", { name: "整课循环", exact: true })
    .click();
  for (let i = 0; i < 2; i++) {
    await page.locator("audio").evaluate((audio: HTMLAudioElement) => {
      audio.pause();
      audio.currentTime = 9.3;
    });
    await page.getByRole("button", { name: "播放精听", exact: true }).click();
    await expect
      .poll(() =>
        page
          .locator("audio")
          .evaluate((audio: HTMLAudioElement) => audio.currentTime),
      )
      .toBeLessThan(3);
    await expect(page.locator("audio")).toHaveJSProperty("paused", false);
    await expect(page.locator("audio")).toHaveJSProperty("playbackRate", 1.5);
    await expect(
      page.getByRole("button", { name: "第一册第1课，标记未学", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
  }
  await page
    .getByRole("button", { name: "第一册第1课，标记未学", exact: true })
    .click();
  await page.getByRole("button", { name: "暂停精听", exact: true }).click();
  await page.reload();
  await loaded(page);
  await expect(
    page.getByRole("button", { name: "第一册第1课，标记已学", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
  await page.goto("/books/1");
  await expect(
    page.getByRole("progressbar", { name: "第一册完成度", exact: true }),
  ).toHaveAttribute("aria-valuenow", "0");
  await page
    .getByRole("button", { name: "第一册第1课，标记已学", exact: true })
    .click();
  await expect(page).toHaveURL(/\/books\/1$/);
  await expect(
    page.getByRole("progressbar", { name: "第一册完成度", exact: true }),
  ).toHaveAttribute("aria-valuenow", "100");
});

test("both boundary kinds seek without changing playback and preferences are per lesson", async ({
  page,
}) => {
  await page.route("**/api/books/1/lessons/3", (route) =>
    route.fulfill({
      json: { ...detail, lesson: 3, label: "Lesson 3 & 4", revision: "third" },
    }),
  );
  await page.goto("/books/1/lessons/1");
  await loaded(page);
  const seekToMarker = async (name: RegExp) => {
    await page.getByRole("button", { name: "全部断点", exact: true }).click();
    await page.getByRole("button", { name }).click();
  };
  await seekToMarker(/^第 2 句起点/);
  await loaded(page);
  await expect
    .poll(() =>
      page.locator("audio").evaluate((a: HTMLAudioElement) => a.currentTime),
    )
    .toBeCloseTo(5, 1);
  await expect(page.locator("audio")).toHaveJSProperty("paused", true);
  await seekToMarker(/^第 1 句终点/);
  await expect
    .poll(() =>
      page.locator("audio").evaluate((a: HTMLAudioElement) => a.currentTime),
    )
    .toBeCloseTo(3.8, 1);
  await page.getByRole("button", { name: "播放精听", exact: true }).click();
  await seekToMarker(/^第 2 句起点/);
  await expect(page.locator("audio")).toHaveJSProperty("paused", false);
  await page.getByRole("button", { name: "暂停精听", exact: true }).click();
  await page.getByRole("tab", { name: "段落起止", exact: true }).click();
  await seekToMarker(/^第 1 段终点/);
  await expect
    .poll(() =>
      page.locator("audio").evaluate((a: HTMLAudioElement) => a.currentTime),
    )
    .toBeCloseTo(6.8, 1);
  await page.goto("/books/1/lessons/3");
  await expect(
    page.getByRole("tab", { name: "句子起止", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await page.goto("/books/1/lessons/1");
  await expect(
    page.getByRole("tab", { name: "段落起止", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("button", { name: "第一册第1课，标记已学", exact: true }),
  ).toBeVisible();
});

test("catalog updates do not move the continue-learning target and synchronize across tabs", async ({
  page,
  context,
}) => {
  await page.route("**/api/books/1", (route) =>
    route.fulfill({
      json: {
        ...book,
        lessonCount: 2,
        lessons: [summary, { ...summary, lesson: 3, label: "Lesson 3 & 4" }],
      },
    }),
  );
  await page.goto("/books/1/lessons/1");
  await loaded(page);
  await page.goto("/books/1");
  await page
    .getByRole("button", { name: "第一册第3课，标记已学", exact: true })
    .click();
  await expect(page.getByRole("link", { name: /继续学习/ })).toHaveAttribute(
    "href",
    "/books/1/lessons/1",
  );
  await expect(
    page.getByRole("progressbar", { name: "第一册完成度", exact: true }),
  ).toHaveAttribute("aria-valuenow", "50");
  // A second page writes the same local progress store; the first page updates
  // through the browser's actual storage event, without reloading.
  const second = await context.newPage();
  await second.route("**/*", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<html><body>Progress sync</body></html>",
    }),
  );
  await second.goto("/");
  await second.evaluate(() => {
    const key = "firstleap.textbook.progress.v1";
    const value = JSON.parse(localStorage.getItem(key)!);
    value.lessons["1:3"].completed = false;
    localStorage.setItem(key, JSON.stringify(value));
  });
  await expect(
    page.getByRole("progressbar", { name: "第一册完成度", exact: true }),
  ).toHaveAttribute("aria-valuenow", "0");
  await second.close();
});

test("classroom theme has no horizontal overflow and keeps the audio dock usable", async ({
  page,
}, testInfo) => {
  const lessonPath = join(
    process.cwd(),
    "data/textbooks/library/book1/001.json",
  );
  const real = existsSync(lessonPath)
    ? JSON.parse(readFileSync(lessonPath, "utf8"))
    : detail;
  await page.route("**/api/books/1/lessons/1", (route) =>
    route.fulfill({ json: real }),
  );
  await page.goto("/books/1/lessons/1");
  await expect(
    page.getByRole("heading", { name: "Excuse me!", exact: true }),
  ).toBeVisible();
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await expect(
      page.getByRole("button", { name: "播放精听", exact: true }),
    ).toBeVisible();
  }
  await page.setViewportSize({
    width: testInfo.project.name === "mobile" ? 390 : 1440,
    height: 1000,
  });
  await page.screenshot({
    path: testInfo.outputPath("reading.png"),
    fullPage: true,
  });
});
