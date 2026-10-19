import { expect, test } from "vitest";
import { acquireVocabularySlot } from "./vocabularyLoading";

test("word loading limits streams and skips cancelled queued entries", async () => {
  const first = await acquireVocabularySlot(new AbortController().signal);
  const second = await acquireVocabularySlot(new AbortController().signal);
  const cancelled = new AbortController();
  const third = acquireVocabularySlot(cancelled.signal);
  const rejection = expect(third).rejects.toMatchObject({ name: "AbortError" });
  let started = false;
  const fourth = acquireVocabularySlot(new AbortController().signal).then(
    (free) => {
      started = true;
      return free;
    },
  );
  await Promise.resolve();
  expect(started).toBe(false);
  cancelled.abort();
  await rejection;
  first();
  const release = await fourth;
  expect(started).toBe(true);
  first(); // Repeated cleanup must not release someone else's slot.
  second();
  release();
});
