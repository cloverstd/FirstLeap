// Existing v1 browser records remain a local cache and a rollback-compatible backup.
type RecordState = {
  values: Record<string, unknown>;
  versions: Record<string, number>;
};
type Remote = {
  revision: number;
  tracks: Record<string, Record<string, RecordState>>;
};
type Patch = {
  operationId: string;
  track: string;
  id: string;
  base: Record<string, number>;
  values: Record<string, unknown>;
  migration?: boolean;
};
const KEYS = {
  text: "firstleap.textbook.progress.v1",
  lecture: "firstleap.progress.v1",
};
const META = "firstleap.sync.v1",
  QUEUE = "firstleap.sync.outbox.v1";
let remote: Remote = { revision: 0, tracks: {} },
  outbox: Patch[] = [],
  enabled = false,
  initialized = false,
  writing = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let inFlight = new Set<string>();
let flushRequested = false;
export function flushProgressSync() {
  if (!enabled) return;
  if (timer) {
    clearTimeout(timer);
    timer = undefined;
  }
  if (writing) {
    flushRequested = true;
    return;
  }
  void sync();
}
function read(key: string) {
  try {
    return JSON.parse(localStorage.getItem(key) || "null");
  } catch {
    return null;
  }
}
function persist() {
  try {
    localStorage.setItem(META, JSON.stringify(remote));
    localStorage.setItem(QUEUE, JSON.stringify(outbox));
  } catch {
    /* Current session still keeps pending updates. */
  }
}
function status(text: string) {
  window.dispatchEvent(
    new CustomEvent("progress-sync-status", { detail: text }),
  );
}
function uuid() {
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
export function queueProgressPatch(
  track: string,
  id: string,
  values: Record<string, unknown>,
) {
  if (typeof window === "undefined" || !enabled || !Object.keys(values).length)
    return;
  let patch = [...outbox]
    .reverse()
    .find(
      (p) =>
        p.track === track &&
        p.id === id &&
        !inFlight.has(p.operationId) &&
        !p.migration,
    );
  if (!patch) {
    patch = { operationId: uuid(), track, id, base: {}, values: {} };
    outbox.push(patch);
  }
  for (const [key, value] of Object.entries(values)) {
    if (!(key in patch.base))
      patch.base[key] = remote.tracks[track]?.[id]?.versions[key] || 0;
    patch.values[key] = value;
  }
  persist();
  status("等待同步");
  if (!("completed" in values) && !("lastLesson" in values)) {
    if (!timer)
      timer = setTimeout(() => {
        timer = undefined;
        void sync();
      }, 5000);
  } else flushProgressSync();
}
function mergeLocal(data: Remote) {
  const snapshots: Record<string, Record<string, Record<string, unknown>>> = {};
  for (const [track, storageKey] of Object.entries(KEYS)) {
    const local = read(storageKey) || {
      version: 1,
      lastLesson: "",
      lessons: {},
    };
    const rows = data.tracks[track] || {};
    for (const [id, record] of Object.entries(rows)) {
      const pending: Record<string, unknown> = {};
      for (const p of outbox)
        if (p.track === track && p.id === id && !p.migration)
          Object.assign(pending, p.values);
      const values = { ...record.values, ...pending };
      if (id === "@last") {
        if (typeof values.lastLesson === "string")
          local.lastLesson = values.lastLesson;
      } else
        local.lessons[id] = {
          position: 0,
          duration: 0,
          completed: false,
          rate: 1,
          sentence: "",
          markerMode: "sentence",
          lastVisitedAt: 0,
          ...local.lessons[id],
          ...values,
        };
    }
    snapshots[track] = local.lessons;
    try {
      const raw = JSON.stringify(local);
      if (localStorage.getItem(storageKey) !== raw) {
        localStorage.setItem(storageKey, raw);
        window.dispatchEvent(
          new StorageEvent("storage", { key: storageKey, newValue: raw }),
        );
      }
    } catch {
      status("当前设备存储不可用，进度暂存在本次会话");
    }
  }
  window.dispatchEvent(
    new CustomEvent("remote-progress-applied", { detail: snapshots }),
  );
}
async function request(url: string, init?: RequestInit) {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(10000),
    headers: { "Content-Type": "application/json" },
  });
  if (!response.ok) throw new Error("sync failed");
  return response.json();
}
async function sync() {
  if (!enabled || writing) return;
  writing = true;
  try {
    if (!initialized) {
      const data = (await request("/api/learner/progress")) as Remote;
      if (!data.tracks || typeof data.revision !== "number")
        throw new Error("invalid progress");
      remote = data;
      if (
        !localStorage.getItem("firstleap.sync.migrated.v1") ||
        data.revision === 0
      ) {
        for (const [track, key] of Object.entries(KEYS)) {
          const raw = localStorage.getItem(key),
            local = read(key);
          if (!local?.lessons) continue;
          if (raw && !localStorage.getItem(`${key}.before-sync`))
            localStorage.setItem(`${key}.before-sync`, raw);
          for (const [id, values] of Object.entries(local.lessons))
            if (!remote.tracks[track]?.[id])
              outbox.push({
                operationId: uuid(),
                track,
                id,
                base: {},
                values: values as Record<string, unknown>,
                migration: true,
              });
          if (local.lastLesson && !remote.tracks[track]?.["@last"])
            outbox.push({
              operationId: uuid(),
              track,
              id: "@last",
              base: {},
              values: { lastLesson: local.lastLesson },
              migration: true,
            });
        }
      }
      initialized = true;
      persist();
    }
    if (outbox.length) {
      const sending = outbox.slice(0, 1000);
      inFlight = new Set(sending.map((p) => p.operationId));
      const data = (await request("/api/learner/progress", {
        method: "PATCH",
        body: JSON.stringify({ patches: sending }),
      })) as { progress: Remote; conflicts: string[] };
      outbox = outbox.filter((p) => !inFlight.has(p.operationId));
      for (const p of outbox)
        for (const field of Object.keys(p.values)) {
          if (data.conflicts.includes(`${p.track}:${p.id}:${field}`)) {
            delete p.values[field];
            delete p.base[field];
          } else if (
            sending.some(
              (s) => s.track === p.track && s.id === p.id && field in s.values,
            )
          )
            p.base[field] =
              data.progress.tracks[p.track]?.[p.id]?.versions[field] || 0;
        }
      outbox = outbox.filter((p) => Object.keys(p.values).length);
      remote = data.progress;
      localStorage.setItem("firstleap.sync.migrated.v1", "true");
      status(data.conflicts.length ? "已合并其他设备的更新" : "学习进度已同步");
    } else {
      remote = (await request("/api/learner/progress")) as Remote;
      status("学习进度已同步");
    }
    persist();
    mergeLocal(remote);
  } catch {
    status("暂时离线，进度将在恢复连接后同步");
  } finally {
    writing = false;
    inFlight.clear();
    if (flushRequested) {
      flushRequested = false;
      queueMicrotask(() => void sync());
    }
  }
}
export function startProgressSync() {
  enabled = true;
  const cached = read(META);
  if (cached?.tracks && typeof cached.revision === "number") remote = cached;
  const pending = read(QUEUE);
  if (Array.isArray(pending)) outbox = pending;
  void sync();
  const interval = setInterval(() => void sync(), 15000),
    focus = () => void sync();
  const hide = () => {
    if (document.visibilityState === "hidden" && outbox.length) void sync();
  };
  window.addEventListener("focus", focus);
  window.addEventListener("online", focus);
  document.addEventListener("visibilitychange", hide);
  return () => {
    enabled = false;
    clearInterval(interval);
    if (timer) clearTimeout(timer);
    window.removeEventListener("focus", focus);
    window.removeEventListener("online", focus);
    document.removeEventListener("visibilitychange", hide);
  };
}
