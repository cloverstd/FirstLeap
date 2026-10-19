import { test, expect, type Page } from "./fixtures";
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

test("decoded lecture resumes, finishes naturally and retains the playback rate", async ({
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
  await page.getByRole("button", { name: "播放速度", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "2×", exact: true }).click();
  await page.getByRole("region", { name: "课程播放器" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("video")).toHaveJSProperty("currentTime", 11);
  await page.waitForFunction(() => !document.querySelector("video")!.seeking);
  await page.getByRole("button", { name: "播放", exact: true }).click();
  await expect(page.locator("video")).toHaveJSProperty("ended", true);
  await expect(page.locator("video")).toHaveJSProperty("playbackRate", 2);
  await expect(page.locator(".complete-button")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(errors).toEqual([]);
});

test("player keyboard scope, instance cleanup and retry preserve lecture progress", async ({
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
    await page.getByRole("button", { name: "我的课堂", exact: true }).click();
    await expect(page.locator("video")).toHaveCount(0);
    await page.getByRole("button", { name: "继续我的学习" }).click();
    await loaded(page);
    const resumed = await page
      .locator("video")
      .evaluate((video: HTMLVideoElement) => {
        video.pause();
        const time = video.currentTime;
        video.currentTime = 6;
        return time;
      });
    expect(resumed).toBeGreaterThanOrEqual(6);
    expect(resumed).toBeLessThan(7);
    await page.waitForFunction(() => !document.querySelector("video")!.seeking);
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
  const position = await page
    .locator("video")
    .evaluate((video: HTMLVideoElement) => {
      video.pause();
      return video.currentTime;
    });
  expect(position).toBeCloseTo(6, 0);
  await page.getByRole("button", { name: "我的课堂", exact: true }).click();
  await expect(page.locator("video")).toHaveCount(0);
  expect(
    await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem("firstleap.progress.v1")!).lessons[
          "player-test"
        ].position,
    ),
  ).toBeCloseTo(6, 0);
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
    await expect(buttons).toHaveCount(3);
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
  await page.getByRole("button", { name: "退出网页全屏", exact: true }).click();
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

test("webpage fullscreen fills the viewport, keeps menus usable and restores the page", async ({
  page,
}) => {
  await page.goto("/learn/player-test");
  await loaded(page);
  await page.evaluate(() => {
    document.body.style.overflow = "clip";
    Element.prototype.requestFullscreen = () => {
      throw new Error("Webpage fullscreen must not request browser fullscreen");
    };
  });
  const player = page.getByRole("region", { name: "课程播放器" });
  await page.getByRole("button", { name: "网页全屏", exact: true }).click();
  await expect(player).toHaveClass(/web-fullscreen/);
  expect(await page.evaluate(() => document.fullscreenElement)).toBeNull();
  await expect(page.locator("body")).toHaveCSS("overflow", "hidden");
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    const bounds = await player.boundingBox();
    expect(bounds).toEqual({ x: 0, y: 0, width, height: 844 });
    const web = await page
      .getByRole("button", { name: "退出网页全屏", exact: true })
      .boundingBox();
    const native = await page
      .getByRole("button", { name: "全屏", exact: true })
      .boundingBox();
    expect(native!.x).toBeGreaterThanOrEqual(web!.x + web!.width);
    expect(native!.x + native!.width).toBeLessThanOrEqual(width);
  }
  await page.getByRole("button", { name: "播放速度", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "1.5×", exact: true }).click();
  await expect(page.locator("video")).toHaveJSProperty("playbackRate", 1.5);
  await page.getByRole("button", { name: "更多跳转", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(player).toHaveClass(/web-fullscreen/);
  await page.keyboard.press("Escape");
  await expect(player).not.toHaveClass(/is-fullscreen/);
  await expect(page.locator("body")).toHaveCSS("overflow", "clip");
  await page.getByRole("button", { name: "网页全屏", exact: true }).click();
  await page.getByRole("button", { name: "退出网页全屏", exact: true }).click();
  await expect(player).not.toHaveClass(/is-fullscreen/);
  await expect(page.locator("body")).toHaveCSS("overflow", "clip");
  await page.getByRole("button", { name: "网页全屏", exact: true }).click();
  await page.evaluate(() => {
    history.pushState({}, "", "/");
    dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(page.locator("video")).toHaveCount(0);
  await expect(page.locator("body")).toHaveCSS("overflow", "clip");
});
