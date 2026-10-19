import { test as base } from "@playwright/test";
export { expect, type Page } from "@playwright/test";
// Media regression tests control their catalogue and should not call a live AI backend.
export const test = base.extend({
  page: async ({ page }, use) => {
    await page.route("**/api/learner/progress", (route) =>
      route.fulfill({
        json:
          route.request().method() === "GET"
            ? { revision: 0, tracks: {} }
            : { progress: { revision: 0, tracks: {} }, conflicts: [] },
      }),
    );
    await page.route("**/api/ai/explanations?**", (route) =>
      route.fulfill({
        json: { cached: false, result: null, history: [], jobId: "" },
      }),
    );
    await use(page);
  },
});
