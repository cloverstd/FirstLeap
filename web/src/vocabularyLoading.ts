// Keep queued word requests from filling the browser's connections with SSE
// subscriptions while the learner is listening to audio.
let active = 0;
const queue: (() => void)[] = [];

function drain() {
  while (active < 2 && queue.length) queue.shift()!();
}

export function acquireVocabularySlot(
  signal: AbortSignal,
): Promise<() => void> {
  return new Promise((resolve, reject) => {
    const cancel = () => {
      const index = queue.indexOf(start);
      if (index >= 0) queue.splice(index, 1);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const start = () => {
      signal.removeEventListener("abort", cancel);
      active++;
      let released = false;
      resolve(() => {
        if (released) return;
        released = true;
        active--;
        drain();
      });
    };
    if (signal.aborted) {
      cancel();
      return;
    }
    signal.addEventListener("abort", cancel, { once: true });
    queue.push(start);
    drain();
  });
}
