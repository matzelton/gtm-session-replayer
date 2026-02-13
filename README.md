# GTM Preview Session Recorder & Replayer

## Zweck

Diese Browser-Extension erweitert den Google Tag Assistant / GTM Preview Workflow um die Möglichkeit, eine reale Nutzer-Session aufzuzeichnen und später erneut abzuspielen.

Ziel ist es, reproduzierbare Test-Szenarien zu erstellen, z. B.:

Homepage → Kategorie → Produkt → Checkout → Purchase

Damit kannst du:

- Änderungen an Tags, Triggern oder Variablen testen  
- Tracking-Logik regressionssicher prüfen  
- Beispiel-Flows standardisieren  
- Debugging im Tag Assistant reproduzierbar machen  

---

# Architektur

Die Extension basiert auf **Manifest V3** und besteht aus drei Kernkomponenten:

## 1. Popup (`popup.js`)

UI für:

- Start Record  
- Stop & Save  
- Replay  
- Statusanzeige (läuft Recording?)  
- Sessionliste  

---

## 2. Service Worker (`service_worker.js`)

Zentrale Steuerung:

- Hält aktive Recordings pro Tab  
- Persistiert Recording-State  
- Speichert Sessions  
- Führt Replay aus  
- Dedupliziert Navigationsschritte  

---

## 3. Content Script (`content.js`)

Wird in jede Seite injiziert und übernimmt:

- Hook von `dataLayer.push`  
- Erkennung von Klicks & Formularen  
- SPA-Navigationserkennung (History API)  
- Kommunikation mit Service Worker  
- Robustes Queueing bei MV3-Kontextwechseln  

---

# Ablauf: Recording

## 1. Start

Wenn im Popup **Start Record** gedrückt wird:

1. Popup sendet `START_RECORD_BG` an den Service Worker  
2. Service Worker:
   - Erstellt neue Session  
   - Speichert sie in:
     - `chrome.storage.session`
     - `chrome.storage.local`
3. Popup setzt Recording-Flag im Content Script  
4. Content Script aktiviert:
   - `isRecording = true`
   - Hook für `dataLayer`
   - Event Listener  

---

## 2. Während der Aufnahme

Folgende Events werden aufgezeichnet:

### Navigations

- Hard Navigation (`load`)  
- SPA Navigation (`pushState`, `replaceState`)  
- URL-Wechsel  

### User-Interaktionen

- Klicks  
- Formular-Submits  

### Tracking

- `dataLayer.push(...)`  

---

## 3. Datenspeicherung

Schritte werden als Objekt gespeichert:

~~~js
{
  t: timestamp,
  type: "click" | "navigate" | "submit" | "datalayer_push",
  ...
}
~~~

Diese Schritte werden an den Service Worker gesendet.

Der Service Worker:

- hängt sie an `session.steps`
- persistiert den aktuellen Stand
- überlebt MV3 Service Worker Restarts

---

## 4. Stop & Save

Wenn **Stop & Save** gedrückt wird:

1. Service Worker beendet Recording für diesen Tab  
2. Session wird in `chrome.storage.local` gespeichert  
3. Popup aktualisiert die Liste  

---

# Ablauf: Replay

## 1. Replay starten

Beim Klick auf **Replay**:

1. Service Worker lädt die Session  
2. Replay läuft im **aktuell aktiven Tab**  
3. Schritte werden vorverarbeitet  

---

## 2. Navigation-Deduplikation

Vor Replay werden:

- `beforeunload`-Events entfernt  
- Meta-Marker entfernt  
- Doppelte URLs zusammengefasst  
- Navigationen übersprungen, wenn der Tab bereits auf dieser URL ist  

Beispiel:

geo.de → geo.de → geo.de/kontakt → geo.de/kontakt  

wird zu:

geo.de → geo.de/kontakt  

---

## 3. Replay-Execution

### Navigation

~~~js
chrome.tabs.update(tabId, { url })
~~~

- Warten auf `complete`
- zusätzliche Delay-Zeit

---

### Click / Submit

- DOM-Selektor wird gesucht  
- Event wird ausgelöst  

---

### dataLayer Push

~~~js
window.dataLayer.push(...)
~~~

Wird direkt im Seitenkontext ausgeführt.

---

# Technische Besonderheiten

## MV3 Service Worker Instabilität

Manifest V3 Service Worker können jederzeit schlafen gehen.

Lösung:

- Active Recordings werden doppelt gespeichert:
  - `chrome.storage.session`
  - `chrome.storage.local`
- State wird bei Bedarf neu geladen
- Content Script puffert Steps in einer Queue

---

## Extension Context Invalidated

Beim Seitenwechsel kann folgender Fehler auftreten:

Extension context invalidated

Lösung:

- Alle `chrome.runtime.sendMessage` Aufrufe sind abgesichert  
- Kein Senden während `beforeunload`  
- Defensive Try/Catch  
- Schritt-Queue wird sauber gestoppt  

---

## Popup-Neustart-Problem

Popup wird bei jedem Öffnen neu initialisiert.

Lösung:

- Popup fragt mit `GET_RECORDING_STATUS`
- Buttons werden anhand des echten Recording-Status gesetzt

---

# Gespeicherte Session-Struktur

~~~js
{
  id: string,
  name: string,
  startedAt: timestamp,
  startUrl: string,
  steps: [
    {
      t: timestamp,
      type: "navigate",
      url: "...",
      kind: "load"
    },
    {
      type: "click",
      selector: "...",
      url: "..."
    },
    {
      type: "datalayer_push",
      args: [...]
    }
  ]
}
~~~

---

# Unterstützte Szenarien

- Multi-Page Navigation (MPA)  
- SPA Navigation  
- dataLayer-basierte Tracking-Events  
- Klick-Trigger  
- Formular-Trigger  
- GTM Preview Reproduktion  
- Service Worker Restarts  
- Popup schließen ohne Verlust  

---

# Einschränkungen

- Kein Netzwerk-Level-Replay (keine echten HTTP-Replays)  
- Selektor-basierte Klick-Reproduktion kann fehlschlagen bei:
  - stark verändertem DOM  
  - A/B Tests  
  - dynamischen IDs  
- Login-/Sessionabhängige Inhalte müssen manuell vorbereitet werden  
- Keine Cross-Tab-Aufzeichnung (nur aktueller Tab)  

---

# Typischer Workflow mit GTM Preview

1. GTM → Preview starten  
2. Website im Preview-gekoppelten Tab öffnen  
3. Start Record  
4. User Flow durchführen  
5. Stop & Save  
6. GTM ändern (Tags/Trigger/Variablen)  
7. Replay  
8. Tag Assistant zeigt Events erneut  

---

# Erweiterungsmöglichkeiten

- Session-Editor (Steps an/aus, Payload ändern)  
- Export/Import als JSON  
- Mehrtab-Unterstützung  
- Wartebedingungen pro Step  
- Stabilere Selektorstrategie (`data-testid`, ARIA etc.)  
- E-Commerce-Event-Fokus-Modus  
- Snapshot-Vergleich (Expected vs Actual Events)  

---

# Zusammenfassung

Die Extension erzeugt einen deterministischen Test-Flow für GTM-Tracking, indem sie:

1. Nutzerverhalten + dataLayer-Events aufzeichnet  
2. Recording robust gegen MV3-Restarts speichert  
3. Replay dedupliziert und stabil ausführt  
4. Tracking-Ereignisse im Tag Assistant reproduziert  

Damit können Tracking-Änderungen zuverlässig validiert werden, ohne jedes Mal manuell durch den gesamten Flow klicken zu müssen.
