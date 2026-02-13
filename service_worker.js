// service_worker.js (Manifest V3, module)

const SESSIONS_KEY = "sessions_v1";
const ACTIVE_KEY_SESSION = "active_recordings_v1_session"; // chrome.storage.session
const ACTIVE_KEY_LOCAL = "active_recordings_v1_local";     // chrome.storage.local (fallback)

// tabId -> session
const activeRecordings = new Map();

// ---- Active Recordings persistence ----
async function loadActiveRecordings() {
  // 1) Try session storage
  const s = await chrome.storage.session.get([ACTIVE_KEY_SESSION]);
  const objSession = s[ACTIVE_KEY_SESSION] || {};

  // 2) If empty, fallback to local
  let obj = objSession;
  if (!obj || Object.keys(obj).length === 0) {
    const l = await chrome.storage.local.get([ACTIVE_KEY_LOCAL]);
    obj = l[ACTIVE_KEY_LOCAL] || {};
  }

  activeRecordings.clear();
  for (const [tabIdStr, session] of Object.entries(obj)) {
    const tabId = Number(tabIdStr);
    if (Number.isFinite(tabId) && session && typeof session === "object") {
      activeRecordings.set(tabId, session);
    }
  }
}

async function persistActiveRecordings() {
  const obj = {};
  for (const [tabId, session] of activeRecordings.entries()) {
    obj[String(tabId)] = session;
  }
  await chrome.storage.session.set({ [ACTIVE_KEY_SESSION]: obj });
  await chrome.storage.local.set({ [ACTIVE_KEY_LOCAL]: obj });
}

let activeLoaded = false;
async function ensureActiveLoaded() {
  if (activeLoaded) return;
  await loadActiveRecordings();
  activeLoaded = true;
}

// ---- Sessions persistence ----
async function getSessions() {
  const r = await chrome.storage.local.get([SESSIONS_KEY]);
  return r[SESSIONS_KEY] || [];
}

async function saveSessions(sessions) {
  await chrome.storage.local.set({ [SESSIONS_KEY]: sessions });
}

async function addSession(session) {
  const sessions = await getSessions();
  sessions.unshift(session);
  await saveSessions(sessions.slice(0, 50));
}

// ---- Replay helpers ----
async function waitForTabComplete(tabId, timeoutMs = 30000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const listener = (updatedTabId, info) => {
      if (updatedTabId === tabId && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(true);
      }
    };
    chrome.tabs.onUpdated.addListener(listener);

    const tick = () => {
      if (Date.now() - start > timeoutMs) {
        chrome.tabs.onUpdated.removeListener(listener);
        reject(new Error("Timeout waiting for tab to load."));
      } else {
        setTimeout(tick, 250);
      }
    };
    tick();
  });
}

async function sendStep(tabId, step) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: "REPLAY_STEP", step }, (resp) => {
      const err = chrome.runtime.lastError;
      if (err) return resolve({ ok: false, error: err.message });
      resolve(resp || { ok: false, error: "No response" });
    });
  });
}

// ---- NEW: preprocess steps to avoid duplicate navigations ----
function preprocessReplaySteps(rawSteps) {
  const steps = Array.isArray(rawSteps) ? rawSteps : [];

  // Kinds, die aus Recording-Gründen existieren, aber beim Replay nicht als echte Navigation taugen
  const SKIP_NAV_KINDS = new Set([
    "beforeunload",                 // would navigate "back" to same page again
    "confirmed",                    // meta marker
    "recording_started",            // meta marker
    "recording_activated_by_interaction", // meta marker
    "flag-faststart",               // meta marker (note in our code)
    "bg-confirm-load",              // meta marker (note in our code)
    "flag_set"                      // meta marker
  ]);

  const out = [];
  let lastNavUrl = null;

  for (const s of steps) {
    if (!s || typeof s !== "object") continue;

    if (s.type !== "navigate") {
      out.push(s);
      continue;
    }

    const kind = String(s.kind || "");
    const url = typeof s.url === "string" ? s.url : null;
    if (!url) continue;

    // skip meta/unhelpful navs
    if (SKIP_NAV_KINDS.has(kind)) continue;

    // collapse consecutive identical navigations
    if (lastNavUrl === url) continue;

    out.push(s);
    lastNavUrl = url;
  }

  return out;
}

async function replaySessionOnTab(tabId, session, opts) {
  const { baseDelayMs = 300, navWaitMs = 1500, maxSteps = 2000 } = opts || {};
  const rawSteps = (session.steps || []).slice(0, maxSteps);
  const steps = preprocessReplaySteps(rawSteps);

  // Track current URL to skip no-op navigations
  let currentUrl = null;
  try {
    const tab = await chrome.tabs.get(tabId);
    currentUrl = tab?.url || null;
  } catch {
    currentUrl = null;
  }

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];

    if (step.type === "navigate") {
      const url = step.url || session.startUrl;
      if (url) {
        // If already on this URL, skip (prevents geo.de > geo.de duplicates etc.)
        if (currentUrl === url) {
          continue;
        }

        await chrome.tabs.update(tabId, { url });
        await waitForTabComplete(tabId, 30000);
        await new Promise((r) => setTimeout(r, navWaitMs));

        currentUrl = url;
      }
      continue;
    }

    await sendStep(tabId, step);
    await new Promise((r) => setTimeout(r, baseDelayMs));
  }

  return { ok: true };
}

// Cleanup when tab closes
chrome.tabs.onRemoved.addListener(async (tabId) => {
  await ensureActiveLoaded();
  if (activeRecordings.has(tabId)) {
    activeRecordings.delete(tabId);
    await persistActiveRecordings();
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    await ensureActiveLoaded();

    const senderTabId = sender?.tab?.id ?? null;

    // Defensive reload if needed
    if (
      (msg.type === "IS_RECORDING" || msg.type === "APPEND_STEP") &&
      senderTabId != null &&
      !activeRecordings.has(senderTabId)
    ) {
      await loadActiveRecordings();
      activeLoaded = true;
    }

    // Popup status check
    if (msg.type === "GET_RECORDING_STATUS") {
      const tabId = msg.tabId;
      if (typeof tabId !== "number") {
        sendResponse({ ok: false, error: "Missing tabId" });
        return;
      }

      const session = activeRecordings.get(tabId) || null;
      sendResponse({
        ok: true,
        isRecording: !!session,
        sessionMeta: session
          ? {
              id: session.id,
              name: session.name,
              startedAt: session.startedAt,
              steps: (session.steps || []).length,
              startUrl: session.startUrl || ""
            }
          : null
      });
      return;
    }

    // Recording: Start/Stop (from popup, explicit tabId)
    if (msg.type === "START_RECORD_BG") {
      const tabId = msg.tabId;
      if (typeof tabId !== "number") {
        sendResponse({ ok: false, error: "Missing tabId" });
        return;
      }

      const session = {
        id: crypto.randomUUID(),
        name: msg.name || `Session ${new Date().toISOString()}`,
        startedAt: Date.now(),
        startUrl: msg.startUrl || "",
        steps: []
      };

      activeRecordings.set(tabId, session);
      await persistActiveRecordings();

      sendResponse({ ok: true, sessionId: session.id });
      return;
    }

    if (msg.type === "STOP_RECORD_BG") {
      const tabId = msg.tabId;
      const session = activeRecordings.get(tabId);
      if (!session) {
        sendResponse({ ok: false, error: "No active recording for this tab" });
        return;
      }

      activeRecordings.delete(tabId);
      await persistActiveRecordings();

      sendResponse({ ok: true, session });
      return;
    }

    // Recording: Content Script hooks (tabId via sender)
    if (msg.type === "IS_RECORDING") {
      if (senderTabId == null) {
        sendResponse({ ok: true, isRecording: false });
        return;
      }
      sendResponse({ ok: true, isRecording: activeRecordings.has(senderTabId) });
      return;
    }

    if (msg.type === "APPEND_STEP") {
      if (senderTabId == null) {
        sendResponse({ ok: false, error: "No sender tabId" });
        return;
      }

      const session = activeRecordings.get(senderTabId);
      if (!session) {
        sendResponse({ ok: false, error: "Not recording on this tab" });
        return;
      }

      const step = msg.step;
      if (step) {
        session.steps.push(step);

        if (!session.startUrl && step.type === "navigate" && step.url) {
          session.startUrl = step.url;
        }

        activeRecordings.set(senderTabId, session);
        await persistActiveRecordings();
      }

      sendResponse({ ok: true });
      return;
    }

    // Sessions: Save/List/Delete
    if (msg.type === "SAVE_SESSION") {
      await addSession(msg.session);
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === "LIST_SESSIONS") {
      const sessions = await getSessions();
      sendResponse({ ok: true, sessions });
      return;
    }

    if (msg.type === "DELETE_SESSION") {
      const sessions = await getSessions();
      const filtered = sessions.filter((s) => s.id !== msg.id);
      await saveSessions(filtered);
      sendResponse({ ok: true });
      return;
    }

    // Replay
    if (msg.type === "REPLAY_SESSION") {
      const sessions = await getSessions();
      const session = sessions.find((s) => s.id === msg.id);
      if (!session) {
        sendResponse({ ok: false, error: "Session not found" });
        return;
      }

      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) {
        sendResponse({ ok: false, error: "No active tab found" });
        return;
      }

      if (msg.navigateToStartUrl) {
        await chrome.tabs.update(tab.id, { url: session.startUrl });
        await waitForTabComplete(tab.id, 30000);
      }

      const result = await replaySessionOnTab(tab.id, session, msg.opts);
      sendResponse(result);
      return;
    }

    sendResponse({ ok: false, error: "Unknown message type" });
  })();

  return true;
});