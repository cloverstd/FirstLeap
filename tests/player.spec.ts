import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let temp: string;
let media: Buffer;
const lesson = {
  id: "player-test",
  order: 1,
  label: "Lesson 1 & 2",
  title: "播放器测试课程",
  duration: 12,
  thumbnail: false,
  reading: { id: "nce1-reading-001", number: 1, duration: 12, status: "ready" },
};
test.beforeAll(() => {
  temp = mkdtempSync(join(tmpdir(), "firstleap-player-"));
  const path = join(temp, "sample.mp4");
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=320x240:rate=12",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=44100",
    "-t",
    "12",
    "-c:v",
    "libx264",
    "-threads",
    "1",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-movflags",
    "+faststart",
    path,
  ]);
  media = readFileSync(path);
});
test.afterAll(() => rmSync(temp, { recursive: true, force: true }));
test.beforeEach(async ({ page }) => {
  await page.route("**/api/courses/ncese01", (route) =>
    route.fulfill({
      json: {
        id: "ncese01",
        title: "新概念英语第一册",
        teacher: "霍娜",
        description: "测试课程",
        lessons: [lesson],
        duration: 12,
        sourceAvailable: true,
        indexing: false,
      },
    }),
  );
  await page.route(/\/api\/lessons\/.*\/video$/, (route) => {
    const range = route
      .request()
      .headers()
      .range?.match(/bytes=(\d+)-(\d*)/);
    if (!range) return route.fulfill({ contentType: "video/mp4", body: media });
    const start = Number(range[1]),
      end = Math.min(Number(range[2] || media.length - 1), media.length - 1);
    if (start >= media.length)
      return route.fulfill({
        status: 416,
        headers: { "Content-Range": `bytes */${media.length}` },
      });
    return route.fulfill({
      status: 206,
      contentType: "video/mp4",
      body: media.subarray(start, end + 1),
      headers: {
        "Accept-Ranges": "bytes",
        "Content-Range": `bytes ${start}-${end}/${media.length}`,
      },
    });
  });
});
async function loaded(page: Page) {
  await expect(page.locator("video")).toHaveCount(1);
  await page.waitForFunction(
    () => document.querySelector("video")!.readyState >= 2,
  );
}
async function pausedSeek(page: Page, time: number) {
  await page.locator("video").evaluate((v: HTMLVideoElement, time) => {
    v.pause();
    v.currentTime = time;
  }, time);
  await page.waitForFunction(() => !document.querySelector("video")!.seeking);
}

test("decoded media resumes, repeats naturally and retains the playback rate", async ({
  page,
  isMobile,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/learn/player-test");
  await loaded(page);
  await expect(page.locator("video")).not.toHaveAttribute("controls", /.*/);
  const timeline = page.getByRole("slider", { name: "播放进度" });
  const track = await timeline.boundingBox();
  const point = { position: { x: track!.width / 4, y: track!.height / 2 } };
  if (isMobile) await timeline.tap(point);
  else await timeline.click(point);
  await expect
    .poll(() =>
      page.locator("video").evaluate((v: HTMLVideoElement) => v.currentTime),
    )
    .toBeCloseTo(3, 0);
  expect(
    await page.locator("video").evaluate((v: HTMLVideoElement) => v.paused),
  ).toBe(true);
  await pausedSeek(page, 1);
  await page.getByRole("button", { name: "快进 5 秒", exact: true }).click();
  await expect
    .poll(() =>
      page.locator("video").evaluate((v: HTMLVideoElement) => v.currentTime),
    )
    .toBe(6);
  expect(
    await page.locator("video").evaluate((v: HTMLVideoElement) => v.paused),
  ).toBe(true);
  await page.reload();
  await loaded(page);
  await expect
    .poll(() =>
      page.locator("video").evaluate((v: HTMLVideoElement) => v.currentTime),
    )
    .toBe(6);
  await page.getByRole("button", { name: "美音朗读", exact: true }).click();
  await loaded(page);
  await page.getByRole("switch", { name: "循环当前视频" }).click();
  await page.getByRole("button", { name: "播放速度", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "2×", exact: true }).click();
  for (let i = 0; i < 2; i++) {
    await pausedSeek(page, 11);
    // The real ended event, not a synthetic dispatch, must restart the video.
    await page.getByRole("button", { name: "播放", exact: true }).click();
    await expect
      .poll(() =>
        page.locator("video").evaluate((v: HTMLVideoElement) => v.currentTime),
      )
      .toBeLessThan(3);
    expect(
      await page
        .locator("video")
        .evaluate((v: HTMLVideoElement) => [v.paused, v.playbackRate]),
    ).toEqual([false, 2]);
    await page.locator("video").evaluate((v: HTMLVideoElement) => v.pause());
  }
  await expect(page.locator(".complete-button")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(errors).toEqual([]);
});

test("player keyboard scope, instance cleanup and retry preserve independent progress", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/learn/player-test");
  await loaded(page);
  await pausedSeek(page, 1);
  await page.getByRole("region", { name: "课程播放器" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect
    .poll(() =>
      page.locator("video").evaluate((v: HTMLVideoElement) => v.currentTime),
    )
    .toBe(6);
  const search = page.getByRole("textbox", { name: "搜索课号或标题" });
  await search.fill("Lesson");
  await search.press("ArrowLeft");
  expect(
    await page
      .locator("video")
      .evaluate((v: HTMLVideoElement) => v.currentTime),
  ).toBe(6);
  for (let i = 0; i < 3; i++) {
    await page.getByRole("button", { name: "美音朗读", exact: true }).click();
    await loaded(page);
    await pausedSeek(page, 3);
    await page.getByRole("button", { name: "课程讲解", exact: true }).click();
    await loaded(page);
    expect(
      await page
        .locator("video")
        .evaluate((v: HTMLVideoElement) => v.currentTime),
    ).toBe(6);
    await expect(page.locator(".art-video-player")).toHaveCount(1);
  }
  await page
    .locator("video")
    .evaluate((v) => v.dispatchEvent(new Event("error")));
  await expect(
    page.getByRole("button", { name: "快进 5 秒", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "重新加载" }).click();
  await loaded(page);
  await expect(
    page.getByRole("button", { name: "快进 5 秒", exact: true }),
  ).toBeEnabled();
  expect(
    await page
      .locator("video")
      .evaluate((v: HTMLVideoElement) => v.currentTime),
  ).toBe(6);
  await page.getByRole("button", { name: "我的课堂", exact: true }).click();
  await expect(page.locator("video")).toHaveCount(0);
  expect(
    await page.evaluate(() => ({
      lecture: JSON.parse(localStorage.getItem("firstleap.progress.v1")!)
        .lessons["player-test"].position,
      reading: JSON.parse(
        localStorage.getItem("firstleap.reading.progress.v1")!,
      ).lessons["nce1-reading-001"].position,
    })),
  ).toEqual({ lecture: 6, reading: 3 });
  expect(errors).toEqual([]);
});

test("small screens and fullscreen retain every learning control", async ({
  page,
}) => {
  await page.goto("/learn/player-test");
  await loaded(page);
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const buttons = page
      .getByRole("group", { name: "快捷跳转" })
      .getByRole("button");
    await expect(buttons).toHaveCount(4);
    const boxes = await buttons.evaluateAll((items) =>
      items.map((item) => {
        const r = item.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      }),
    );
    expect(boxes.every((b) => b.width >= 44 && b.height >= 44)).toBe(true);
    expect(
      boxes.every(
        (b) => b.y + b.height / 2 === boxes[0].y + boxes[0].height / 2,
      ),
    ).toBe(true);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.getByRole("button", { name: "播放速度", exact: true }).click();
    const menu = await page
      .getByRole("menu", { name: "播放速度" })
      .boundingBox();
    expect(menu!.x).toBeGreaterThanOrEqual(0);
    expect(menu!.x + menu!.width).toBeLessThanOrEqual(width);
    await page.keyboard.press("Escape");
  }
  // Exercise the web fullscreen fallback used when container fullscreen is unavailable.
  await page.evaluate(() => {
    Element.prototype.requestFullscreen = () =>
      Promise.reject(new Error("unsupported"));
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "全屏", exact: true }).click();
  await expect(page.getByRole("region", { name: "课程播放器" })).toHaveClass(
    /web-fullscreen/,
  );
  await page.getByRole("button", { name: "更多跳转", exact: true }).click();
  await expect(
    page.getByRole("menuitem", { name: "快退 30 秒", exact: true }),
  ).toBeInViewport();
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 844, height: 390 });
  await page.getByRole("button", { name: "更多跳转", exact: true }).click();
  await expect(
    page.getByRole("menuitem", { name: "快进 30 秒", exact: true }),
  ).toBeInViewport();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "退出全屏", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "课程播放器" }),
  ).not.toHaveClass(/is-fullscreen/);
  expect(await page.evaluate(() => document.body.style.overflow)).toBe("");
});

test("fullscreen keeps jump and speed menus inside the active player", async ({
  page,
}) => {
  await page.goto("/learn/player-test");
  await loaded(page);
  await page.getByRole("button", { name: "全屏", exact: true }).click();
  await expect(page.getByRole("region", { name: "课程播放器" })).toHaveClass(
    /is-fullscreen/,
  );
  for (const name of ["更多跳转", "播放速度"]) {
    await page.getByRole("button", { name, exact: true }).click();
    const menu = page.getByRole("menu", { name, exact: true });
    await expect(menu).toBeVisible();
    expect(
      await menu.evaluate((element) =>
        document.fullscreenElement
          ? document.fullscreenElement.contains(element)
          : Boolean(element.closest(".learning-player")),
      ),
    ).toBe(true);
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
  }
  await page.getByRole("button", { name: "退出全屏", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "课程播放器" }),
  ).not.toHaveClass(/is-fullscreen/);
});
