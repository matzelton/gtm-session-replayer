// content.js
(() => {
  if (window.__gtmSessionToolInstalled) return;
  window.__gtmSessionToolInstalled = true;

  const RECORDING_FLAG_KEY = "__gtmSessionRecording"; // sessionStorage
  let isRecording = false;

  // Queue, falls BG noch nicht ready / race
  const pendingSteps = [];
  let bgConfirmed = false;
  let flushInProgress = false;

  // Wenn der Kontext gerade invalidiert wird (Navigation/Unload), nicht mehr senden
  let contextInvalidating = false;

  const now = () => Date.now();

  const safeClone = (obj) => {
    try {
      return structuredClone(obj);
    } catch {
      return JSON.parse(JSON.stringify(obj));
    }
  };

  function runtimeAvailable() {
    // chrome.runtime ist im invalidierten Kontext manchmal noch da, aber sendMessage wirft.
    // Wir behandeln das trotzdem defensiv.
    try {
      return !!(chrome?.runtime?.id);
    } catch {
      return false;
    }
  }

  function sendAppendStep(step) {
    return new Promise((resolve) => {
      if (!runtimeAvailable() || contextInvalidating) {
        resolve({ ok: false, error: "Context not available" });
        return;
      }

      try {
        chrome.runtime.sendMessage({ type: "APPEND_STEP", step }, (resp) => {
          const err = chrome.runtime.lastError;
          if (err) {
            // Wichtig: KEIN throw, sonst "Uncaught (in promise)"
            resolve({ ok: false, error: err.message });
            return;
          }
          resolve(resp || { ok: false, error: "No response" });
        });
      } catch (e) {
        // Das ist genau der Fall "Extension context invalidated"
        resolve({ ok: false, error: String(e) });
      }
    });
  }

  async function flushPending() {
    if (!bgConfirmed || flushInProgress || contextInvalidating) return;
    flushInProgress = true;

    try {
      let safety = 200; // nicht zu groß, damit wir nicht lange im document_start blocken
      while (pendingSteps.length && safety-- > 0) {
        if (contextInvalidating) break;

        const step = pendingSteps[0];
        const resp = await sendAppendStep(step);

        if (resp?.ok) {
          pendingSteps.shift();
          continue;
        }

        const errMsg = String(resp?.error || "");

        // Wenn Kontext invalidiert / runtime weg: abbrechen, nächsten Load abwarten
        if (errMsg.includes("invalidated") || errMsg.includes("Context not available")) {
          break;
        }

        // BG sagt "Not recording" oder noch wachwerden → kurz warten, nochmal
        if (errMsg.includes("Not recording") || errMsg.includes("No response")) {
          await new Promise((r) => setTimeout(r, 120));
          continue;
        }

        // Unbekannter Fehler → abbrechen, später erneut versuchen
        break;
      }
    } finally {
      flushInProgress = false;
    }
  }

  function pushStep(step) {
    if (!isRecording || contextInvalidating) return;

    const full = { t: now(), ...step };

    if (!bgConfirmed) {
      pendingSteps.push(full);
      return;
    }

    // Direkt senden, aber Fehler nur puffern (keine unhandled rejection)
    sendAppendStep(full).then((resp) => {
      if (!resp?.ok && !contextInvalidating) {
        pendingSteps.push(full);
        setTimeout(flushPending, 150);
      }
    });
  }

  const cssPath = (el) => {
    if (!el || el.nodeType !== 1) return null;
    if (el.id) return `#${CSS.escape(el.id)}`;

    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 6) {
      let part = node.nodeName.toLowerCase();
      if (node.classList && node.classList.length) {
        const cls = [...node.classList]
          .slice(0, 2)
          .map((c) => `.${CSS.escape(c)}`)
          .join("");
        part += cls;
      }
      const parent = node.parentElement;
      if (parent) {
        const siblings = [...parent.children].filter((c) => c.nodeName === node.nodeName);
        if (siblings.length > 1) {
          const idx = siblings.indexOf(node) + 1;
          part += `:nth-of-type(${idx})`;
        }
      }
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(" > ");
  };

  // ---- Hook dataLayer.push ----
  const ensureDataLayerHooked = () => {
    window.dataLayer = window.dataLayer || [];
    if (window.__gtmSessionToolDataLayerHooked) return;
    window.__gtmSessionToolDataLayerHooked = true;

    const originalPush = window.dataLayer.push.bind(window.dataLayer);
    window.dataLayer.push = function (...args) {
      if (isRecording && !contextInvalidating) {
        pushStep({
          type: "datalayer_push",
          args: safeClone(args),
          url: location.href
        });
      }
      return originalPush(...args);
    };
  };

  ensureDataLayerHooked();

  // ---- SPA navigation hooks ----
  const hookHistory = () => {
    if (window.__gtmSessionToolHistoryHooked) return;
    window.__gtmSessionToolHistoryHooked = true;

    const recordNav = (kind) => {
      pushStep({ type: "navigate", kind, url: location.href });
    };

    const origPushState = history.pushState;
    history.pushState = function (...args) {
      const ret = origPushState.apply(this, args);
      recordNav("pushState");
      return ret;
    };

    const origReplaceState = history.replaceState;
    history.replaceState = function (...args) {
      const ret = origReplaceState.apply(this, args);
      recordNav("replaceState");
      return ret;
    };

    window.addEventListener("popstate", () => recordNav("popstate"));
  };

  hookHistory();

  // ---- Background confirm helper ----
  function confirmWithBackground() {
    return new Promise((resolve) => {
      if (!runtimeAvailable() || contextInvalidating) {
        resolve(false);
        return;
      }

      try {
        chrome.runtime.sendMessage({ type: "IS_RECORDING" }, (resp) => {
          const err = chrome.runtime.lastError;
          if (err) {
            resolve(false);
            return;
          }

          if (resp?.ok && resp.isRecording) {
            bgConfirmed = true;
            isRecording = true;
            try { sessionStorage.setItem(RECORDING_FLAG_KEY, "1"); } catch {}
            ensureDataLayerHooked();
            resolve(true);
          } else {
            bgConfirmed = false;
            isRecording = false;
            try { sessionStorage.removeItem(RECORDING_FLAG_KEY); } catch {}
            resolve(false);
          }
        });
      } catch {
        resolve(false);
      }
    });
  }

  // ---- Self-activation on first interaction ----
  let interactionCheckDone = false;
  async function maybeActivateOnInteraction() {
    if (interactionCheckDone || contextInvalidating) return;
    interactionCheckDone = true;

    const ok = await confirmWithBackground();
    if (ok) {
      pendingSteps.push({ t: now(), type: "navigate", kind: "recording_activated_by_interaction", url: location.href });
      flushPending();
    }
  }

  window.addEventListener("pointerdown", maybeActivateOnInteraction, true);
  window.addEventListener("keydown", maybeActivateOnInteraction, true);

  // ---- Record clicks & submits ----
  document.addEventListener(
    "click",
    async (e) => {
      if (!isRecording) {
        await maybeActivateOnInteraction();
      }
      if (!isRecording || contextInvalidating) return;

      const target =
        e.target && e.target.closest
          ? e.target.closest("a,button,input,select,textarea,[role='button']")
          : e.target;

      pushStep({
        type: "click",
        selector: cssPath(target),
        url: location.href
      });
    },
    true
  );

  document.addEventListener(
    "submit",
    async (e) => {
      if (!isRecording) {
        await maybeActivateOnInteraction();
      }
      if (!isRecording || contextInvalidating) return;

      const form = e.target;
      pushStep({
        type: "submit",
        selector: cssPath(form),
        url: location.href
      });
    },
    true
  );

  // ---- Fast start via sessionStorage flag ----
  try {
    if (sessionStorage.getItem(RECORDING_FLAG_KEY) === "1") {
      isRecording = true;
      // BG confirm kommt gleich, bis dahin puffern wir
      pendingSteps.push({ t: now(), type: "navigate", kind: "load", url: location.href, note: "flag-faststart" });
    }
  } catch {}

  // initial BG confirm at load
  confirmWithBackground().then((ok) => {
    if (ok && !contextInvalidating) {
      pendingSteps.push({ t: now(), type: "navigate", kind: "load", url: location.href, note: "bg-confirm-load" });
      flushPending();
    }
  });

  // ---- IMPORTANT: mark invalidation early to avoid sendMessage during teardown ----
  window.addEventListener("pagehide", () => {
    contextInvalidating = true;
  });

  window.addEventListener("beforeunload", () => {
    contextInvalidating = true;
    // KEIN pushStep mehr hier – genau das triggert häufig invalidated errors
  });

  // ---- Messages from popup / replay ----
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      if (!msg || !msg.type) return;

      if (msg.type === "SET_RECORDING_FLAG") {
        try { sessionStorage.setItem(RECORDING_FLAG_KEY, "1"); } catch {}
        isRecording = true;
        bgConfirmed = true; // optimistisch, sofort aktiv

        ensureDataLayerHooked();
        pendingSteps.push({ t: now(), type: "navigate", kind: "recording_started", url: location.href });

        flushPending();
        await confirmWithBackground();
        flushPending();

        sendResponse({ ok: true });
        return;
      }

      if (msg.type === "CLEAR_RECORDING_FLAG") {
        isRecording = false;
        bgConfirmed = false;
        pendingSteps.length = 0;
        try { sessionStorage.removeItem(RECORDING_FLAG_KEY); } catch {}
        sendResponse({ ok: true });
        return;
      }

      if (msg.type === "REPLAY_STEP") {
        const step = msg.step;

        try {
          if (step.type === "navigate") {
            sendResponse({ ok: true, note: "navigate handled by background" });
            return;
          }

          if (step.type === "datalayer_push") {
            ensureDataLayerHooked();
            window.dataLayer = window.dataLayer || [];
            window.dataLayer.push(...(step.args || []));
            sendResponse({ ok: true });
            return;
          }

          const findEl = (sel) => {
            if (!sel) return null;
            try {
              return document.querySelector(sel);
            } catch {
              return null;
            }
          };

          if (step.type === "click") {
            const el = findEl(step.selector);
            if (!el) {
              sendResponse({ ok: false, error: `Element not found: ${step.selector}` });
              return;
            }
            el.click();
            sendResponse({ ok: true });
            return;
          }

          if (step.type === "submit") {
            const el = findEl(step.selector);
            if (!el) {
              sendResponse({ ok: false, error: `Form not found: ${step.selector}` });
              return;
            }
            el.requestSubmit ? el.requestSubmit() : el.submit();
            sendResponse({ ok: true });
            return;
          }

          sendResponse({ ok: true, note: "Unknown step ignored" });
        } catch (err) {
          sendResponse({ ok: false, error: String(err) });
        }
      }

      if (msg.type === "PING") {
        sendResponse({ ok: true });
        return;
      }
    })();

    return true;
  });
})();
