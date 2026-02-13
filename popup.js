async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function sendToTab(tabId, msg) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, msg, (resp) => {
      const err = chrome.runtime.lastError;
      if (err) return resolve({ ok: false, error: err.message });
      resolve(resp || { ok: true });
    });
  });
}

async function bg(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (resp) => {
      const err = chrome.runtime.lastError;
      if (err) return resolve({ ok: false, error: err.message });
      resolve(resp || { ok: false, error: "No response" });
    });
  });
}

function fmt(ts) {
  try { return new Date(ts).toLocaleString(); } catch { return String(ts); }
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function retrySendToTab(tabId, msg, tries = 20, delayMs = 100) {
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    const r = await sendToTab(tabId, msg);
    if (r?.ok) return { ok: true };
    lastErr = r?.error || "Unknown";
    await new Promise((r2) => setTimeout(r2, delayMs));
  }
  return { ok: false, error: lastErr || "Failed to deliver message" };
}

async function setUiStateFromStatus(tabId, startBtn, stopBtn) {
  const st = await bg({ type: "GET_RECORDING_STATUS", tabId });

  if (!st.ok) {
    // Wenn Status nicht geht, lieber konservativ
    startBtn.disabled = false;
    stopBtn.disabled = true;
    return;
  }

  if (st.isRecording) {
    startBtn.disabled = true;
    stopBtn.disabled = false;
  } else {
    startBtn.disabled = false;
    stopBtn.disabled = true;
  }
}

async function refreshList() {
  const list = document.getElementById("list");
  list.innerHTML = "Lade…";

  const r = await bg({ type: "LIST_SESSIONS" });
  if (!r.ok) {
    list.innerHTML = `Fehler: ${escapeHtml(r.error)}`;
    return;
  }

  const sessions = r.sessions || [];
  if (!sessions.length) {
    list.innerHTML = "<div class='meta'>Keine Sessions gespeichert.</div>";
    return;
  }

  const navToStart = document.getElementById("navToStart").checked;

  list.innerHTML = "";
  for (const s of sessions) {
    const div = document.createElement("div");
    div.className = "item";
    div.innerHTML = `
      <div><strong>${escapeHtml(s.name || "Unnamed")}</strong></div>
      <div class="meta">${escapeHtml(s.startUrl || "")}</div>
      <div class="meta">Steps: ${(s.steps || []).length} · Start: ${escapeHtml(fmt(s.startedAt))}</div>
      <div class="actions">
        <button class="small replay">Replay</button>
        <button class="small del">Delete</button>
      </div>
    `;

    div.querySelector(".replay").addEventListener("click", async () => {
      await bg({
        type: "REPLAY_SESSION",
        id: s.id,
        opts: { baseDelayMs: 250, navWaitMs: 1500 },
        navigateToStartUrl: navToStart
      });
      window.close();
    });

    div.querySelector(".del").addEventListener("click", async () => {
      await bg({ type: "DELETE_SESSION", id: s.id });
      await refreshList();
    });

    list.appendChild(div);
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  const startBtn = document.getElementById("start");
  const stopBtn = document.getElementById("stop");
  const nameInput = document.getElementById("sessionName");
  const navToStart = document.getElementById("navToStart");

  navToStart.addEventListener("change", refreshList);

  const tab = await getActiveTab();
  if (!tab?.id) {
    startBtn.disabled = false;
    stopBtn.disabled = true;
    await refreshList();
    return;
  }

  // ✅ Beim Öffnen: Status abfragen und Buttons setzen
  await setUiStateFromStatus(tab.id, startBtn, stopBtn);

  startBtn.addEventListener("click", async () => {
    const tabNow = await getActiveTab();
    if (!tabNow?.id) {
      alert("Kein aktiver Tab gefunden.");
      return;
    }

    const name = nameInput.value?.trim();
    const r = await bg({
      type: "START_RECORD_BG",
      tabId: tabNow.id,
      name,
      startUrl: tabNow.url
    });

    if (!r.ok) {
      alert(`Start fehlgeschlagen: ${r.error}`);
      return;
    }

    // Flag sicher in den Tab bringen (mit Retry)
    await retrySendToTab(tabNow.id, { type: "SET_RECORDING_FLAG" }, 25, 120);

    // ✅ UI aktualisieren
    await setUiStateFromStatus(tabNow.id, startBtn, stopBtn);
  });

  stopBtn.addEventListener("click", async () => {
    const tabNow = await getActiveTab();
    if (!tabNow?.id) {
      alert("Kein aktiver Tab gefunden.");
      return;
    }

    const r = await bg({ type: "STOP_RECORD_BG", tabId: tabNow.id });
    if (!r.ok) {
      alert(`Stop fehlgeschlagen: ${r.error}`);
      return;
    }

    // Flag entfernen (best effort)
    await retrySendToTab(tabNow.id, { type: "CLEAR_RECORDING_FLAG" }, 10, 120);

    await bg({ type: "SAVE_SESSION", session: r.session });

    // ✅ UI aktualisieren
    await setUiStateFromStatus(tabNow.id, startBtn, stopBtn);

    await refreshList();
  });

  await refreshList();
});