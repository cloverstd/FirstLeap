import { test, expect } from "./fixtures";

const lessons = [
  {
    id: "intro",
    order: 1,
    label: "导学课",
    title: "《新概念英语》第一册 导学课",
    duration: 351,
    thumbnail: false,
  },
  {
    id: "lesson1",
    order: 2,
    label: "Lesson 1 & 2",
    title: "Excuse me! 对不起！",
    duration: 2234,
    thumbnail: false,
  },
  {
    id: "lesson25",
    order: 14,
    label: "Lesson 25 & 26",
    title: "Mrs Smith’s kitchen 史密斯太太的厨房",
    duration: 2400,
    thumbnail: false,
  },
];
const course = {
  id: "ncese01",
  title: "新概念英语第一册",
  teacher: "霍娜",
  description: "从第一句问候开始，建立扎实的英语基础。",
  lessons,
  duration: 4985,
  sourceAvailable: true,
  indexing: false,
};

test.beforeEach(async ({ page }) => {
  await page.route("**/reading/video", (route) =>
    route.fulfill({ status: 503 }),
  );
  await page.route("**/api/courses/ncese01", (route) =>
    route.fulfill({ json: course }),
  );
  await page.route("**/api/lessons/*/video", (route) =>
    route.fulfill({ status: 503, json: { error: "test source unavailable" } }),
  );
});

test("catalog search, lesson navigation and saved completion", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: /每一段新旅程/ }),
  ).toBeVisible();
  await page.getByRole("textbox", { name: "搜索课号或标题" }).fill("25");
  await expect(page.locator(".lesson-row")).toHaveCount(1);
  await page.locator(".lesson-row").click();
  await expect(page).toHaveURL(/\/learn\/lesson25$/);
  await expect(
    page.getByRole("heading", { name: "Mrs Smith’s kitchen 史密斯太太的厨房" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "标记完成", exact: true }).click();
  await page.reload();
  await expect(page.locator(".complete-button")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByRole("button", { name: "播放速度", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "1.5×", exact: true }).click();
  expect(
    await page
      .locator("video")
      .evaluate((el: HTMLVideoElement) => el.playbackRate),
  ).toBe(1.5);
  await expect(page.getByRole("switch", { name: "连续播放" })).toHaveAttribute(
    "aria-checked",
    "false",
  );
  await page.getByRole("button", { name: "上一节 Lesson 1 & 2" }).click();
  await expect(page).toHaveURL(/\/learn\/lesson1$/);
  await page.getByRole("button", { name: "我的课堂", exact: true }).click();
  await page.getByRole("button", { name: "已完成", exact: true }).click();
  await expect(page.locator(".lesson-row")).toHaveCount(1);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBeTruthy();
  expect(errors).toEqual([]);
});

test("source outage preserves catalog and offers retry", async ({ page }) => {
  await page.route("**/api/courses/ncese01", (route) =>
    route.fulfill({ json: { ...course, sourceAvailable: false } }),
  );
  await page.goto("/");
  await expect(page.getByRole("alert")).toContainText("课程视频源暂时不可用");
  await expect(page.getByRole("button", { name: "开始第一课" })).toBeDisabled();
  await expect(page.locator(".lesson-row")).toHaveCount(3);
  await page.route("**/api/courses/ncese01", (route) =>
    route.fulfill({ json: course }),
  );
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "开始第一课" })).toBeEnabled();
});

test("opening a lesson keeps the player in view", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/learn/lesson25");
  await expect(page.locator(".lesson-row.selected")).toBeVisible();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(page.locator("video")).toBeInViewport({ ratio: 0.9 });
});

test("restores playback position from browser storage", async ({ page }) => {
  await page.addInitScript(() =>
    localStorage.setItem(
      "firstleap.progress.v1",
      JSON.stringify({
        version: 1,
        lastLesson: "lesson1",
        lessons: {
          lesson1: {
            position: 120,
            duration: 2234,
            completed: false,
            updatedAt: 1,
          },
        },
      }),
    ),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "继续我的学习" }).click();
  await expect(page).toHaveURL(/\/learn\/lesson1$/);
  // Dispatch metadata with a controlled duration; real decode/seek is exercised against the deployed source.
  await page.locator("video").evaluate((el: HTMLVideoElement) => {
    Object.defineProperty(el, "duration", { value: 2234, configurable: true });
    el.dispatchEvent(new Event("loadedmetadata"));
  });
  expect(
    await page
      .locator("video")
      .evaluate((el: HTMLVideoElement) => el.currentTime),
  ).toBe(120);
});

async function metadata(
  page: import("@playwright/test").Page,
  duration: number,
) {
  await page.locator("video").evaluate((el: HTMLVideoElement, value) => {
    Object.defineProperty(el, "duration", { value, configurable: true });
    el.dispatchEvent(new Event("loadedmetadata"));
  }, duration);
}

test("retired reading mode opens the lecture and never requests reading video", async ({
  page,
}) => {
  const readingRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/reading/video"))
      readingRequests.push(request.url());
  });
  await page.addInitScript(() => {
    localStorage.setItem("firstleap.player-mode.v1", "reading");
    localStorage.setItem("firstleap.reading.loop.v1", "true");
  });
  await page.route("**/api/courses/ncese01", (route) =>
    route.fulfill({
      json: {
        ...course,
        lessons: lessons.map((lesson) => ({
          ...lesson,
          reading: {
            id: "nce1-reading-001",
            number: 1,
            duration: 16,
            status: "ready",
          },
        })),
      },
    }),
  );
  await page.goto("/learn/lesson1");
  await expect(page.locator("video")).toHaveAttribute(
    "src",
    "/api/lessons/lesson1/video",
  );
  await expect(
    page.getByRole("button", { name: "美音朗读", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("switch", { name: "循环当前视频" })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: "网页全屏", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(page.locator("video")).toHaveAttribute(
    "src",
    "/api/lessons/lesson1/video",
  );
  expect(readingRequests).toEqual([]);
});

test("lecture shortcuts clamp, preserve pause and save positions", async ({
  page,
}) => {
  await page.goto("/learn/lesson1");
  await expect(
    page.getByRole("button", { name: "更多跳转", exact: true }),
  ).toBeDisabled();
  await metadata(page, 100);
  await expect(page.locator(".seek-tools button")).toHaveCount(3);
  for (const offset of [-30, -15, -10, -5, 5, 10, 15, 30]) {
    await page.locator("video").evaluate((v: HTMLVideoElement) => {
      v.currentTime = 50;
    });
    if (Math.abs(offset) > 5)
      await page.getByRole("button", { name: "更多跳转", exact: true }).click();
    await page
      .getByRole(Math.abs(offset) > 5 ? "menuitem" : "button", {
        name: `${offset < 0 ? "快退" : "快进"} ${Math.abs(offset)} 秒`,
        exact: true,
      })
      .click();
    expect(
      await page
        .locator("video")
        .evaluate((v: HTMLVideoElement) => v.currentTime),
    ).toBe(50 + offset);
    await expect(page.locator("video")).toHaveJSProperty("paused", true);
  }
  await page.locator("video").evaluate((v: HTMLVideoElement) => {
    v.currentTime = 2;
  });
  await page.getByRole("button", { name: "快退 5 秒", exact: true }).click();
  await expect(page.locator("video")).toHaveJSProperty("currentTime", 0);
  await page.locator("video").evaluate((v: HTMLVideoElement) => {
    v.currentTime = 98;
  });
  await page.getByRole("button", { name: "快进 5 秒", exact: true }).click();
  await expect(page.locator("video")).toHaveJSProperty("currentTime", 100);
  expect(
    await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem("firstleap.progress.v1")!).lessons
          .lesson1.position,
    ),
  ).toBe(100);
  await expect(page.locator(".seek-tools button").first()).toHaveCSS(
    "min-height",
    "44px",
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("continuous lecture playback advances after a natural end", async ({
  page,
}) => {
  await page.goto("/learn/lesson1");
  await metadata(page, 100);
  await page.getByRole("switch", { name: "连续播放" }).click();
  await page.locator("video").evaluate((video: HTMLVideoElement) => {
    video.dispatchEvent(new Event("ended"));
  });
  await expect(page).toHaveURL(/\/learn\/lesson25$/);
  await expect(page.locator("video")).toHaveAttribute(
    "src",
    "/api/lessons/lesson25/video",
  );
});
