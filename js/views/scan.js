// Scan: camera (with a card-shaped guide) or photo upload → OCR → TCGdex matches.
// Claude vision is offered as a second reader when OCR can't find the card.

import { readWithClaude } from "../ai.js";
import { cardImg, h, mount } from "../dom.js";
import { detectCard, frameHash, frameMovement, hashDistance } from "../card-detect.js";
import { identify } from "../identify.js";
import { nameScore, nameTokens, sameNumber } from "../match.js";
import { autoCrop, readCard, toCanvas, warmUp } from "../ocr.js";
import { getApiKey, ownedIds, state } from "../store.js";
import { cardSheet, cardTile, openCard } from "../ui.js";

const CARD_RATIO = 63 / 88;
let stream = null;
let lastCanvas = null;
let autoTimer = null;

export function stopCamera() {
  if (autoTimer != null) clearInterval(autoTimer);
  autoTimer = null;
  if (stream) for (const t of stream.getTracks()) t.stop();
  stream = null;
}

export function render(root) {
  // Revisiting the Scan tab must not leave an invisible old camera/timer running.
  stopCamera();
  const video = h("video", { playsinline: true, muted: true, autoplay: true, "aria-label": "Camera preview" });
  const guide = h("div", { class: "guide", "aria-hidden": "true" });
  const stage = h("div", { class: "camera hidden" }, video, guide);
  const status = h("div", { class: "status", role: "status", "aria-live": "polite" });
  const results = h("div", { class: "results" });
  const preview = h("div", { class: "preview" });
  const recentHost = h("div", { class: "recent-scans" });
  const file = h("input", { type: "file", accept: "image/*", capture: "environment", class: "visually-hidden", id: "scan-file" });

  const camBtn = h("button", { class: "btn primary", type: "button" }, "Iniciar cámara");
  const shotBtn = h("button", { class: "btn hidden", type: "button" }, "Captura manual");
  const stopBtn = h("button", { class: "btn hidden", type: "button" }, "Detener cámara");

  const say = (msg, kind = "") => {
    if (status.textContent === msg && status.className === `status ${kind}`) return;
    status.className = `status ${kind}`;
    status.textContent = msg;
  };

  // Sample a small region with a margin around the guide to find real edges.
  // Large-resolution images are only processed after a card has been detected.
  const ANALYSIS_W = 144, ANALYSIS_H = 192;
  const analysis = document.createElement("canvas");
  analysis.width = ANALYSIS_W;
  analysis.height = ANALYSIS_H;
  const analysisCtx = analysis.getContext("2d", { willReadFrequently: true });
  let previousFrame = null;
  let previousBox = null;
  let stableSamples = 0;
  let busy = false;
  let paused = false; // used only for manual file or explicit review operations
  let armed = true;
  let lostFrames = 0;
  let lastHash = null;
  let lastShotAt = 0;
  let lastSampleAt = 0;
  const recent = []; // session history, never silently saved to the collection
  let activeRun = 0;

  function difference(a, b) {
    if (!a || !b) return Infinity;
    let sum = 0;
    for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
    return sum / a.length;
  }

  function sampleFrame() {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return null;
    const g = guideRect(vw, vh);
    // Include background around the guide: a card's four outer edges must
    // be visible. This distinguishes a card from random printed textures.
    const x0 = Math.max(0, g.x - g.w * .16);
    const y0 = Math.max(0, g.y - g.h * .16);
    const x1 = Math.min(vw, g.x + g.w * 1.16);
    const y1 = Math.min(vh, g.y + g.h * 1.16);
    const roi = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    analysisCtx.drawImage(video, roi.x, roi.y, roi.w, roi.h,
      0, 0, ANALYSIS_W, ANALYSIS_H);
    const rgba = analysisCtx.getImageData(0, 0, ANALYSIS_W, ANALYSIS_H).data;
    const gray = new Uint8Array(ANALYSIS_W * ANALYSIS_H);
    for (let i = 0; i < gray.length; i++) {
      const k = i * 4;
      gray[i] = Math.round(.299 * rgba[k] + .587 * rgba[k + 1] + .114 * rgba[k + 2]);
    }
    const detected = detectCard(gray, ANALYSIS_W, ANALYSIS_H, roi.w / roi.h);
    if (!detected) return { gray, detected: null };
    const r = detected.box;
    const source = {
      x: roi.x + r.x * roi.w / ANALYSIS_W,
      y: roi.y + r.y * roi.h / ANALYSIS_H,
      w: r.w * roi.w / ANALYSIS_W,
      h: r.h * roi.h / ANALYSIS_H
    };
    // Keep a small border to avoid cutting off printed name/collector number.
    const padX = source.w * .02, padY = source.h * .02;
    const crop = {
      x: Math.max(0, source.x - padX),
      y: Math.max(0, source.y - padY),
      w: Math.min(vw, source.x + source.w + padX) - Math.max(0, source.x - padX),
      h: Math.min(vh, source.y + source.h + padY) - Math.max(0, source.y - padY),
    };
    return { gray, detected, crop,
      hash: frameHash(gray, ANALYSIS_W, ANALYSIS_H, r) };
  }

  function updateRecent() {
    if (!recent.length) { recentHost.replaceChildren(); return; }
    mount(recentHost,
      h("h3", {}, "Últimas detecciones (sin guardar)"),
      h("p", { class: "muted small" },
        "Revisa las coincidencias. Ninguna carta se añade al inventario automáticamente."),
      ...recent.map((item) => h("div", { class: "recent-item" },
        cardImg(item.card.image, item.card.name),
        h("div", { class: "recent-info" },
          h("strong", {}, item.card.name),
          h("span", { class: "muted small" },
            [item.card.set?.name, item.card.localId && "#" + item.card.localId].filter(Boolean).join(" · ")),
          h("span", { class: "small" }, item.sure ? "Coincidencia probable" : "Revisar coincidencia"),
          h("div", { class: "row tight" },
            h("button", { class: "btn small", type: "button",
              onclick: () => openCard(item.card.id, afterAdd) }, "Revisar / añadir"),
            h("button", { class: "btn small", type: "button", onclick: () => {
              const i = recent.indexOf(item);
              if (i >= 0) recent.splice(i, 1);
              updateRecent();
            } }, "Descartar"))))));
  }

  function rememberResult(card, sure) {
    // A transient session list prevents an unsaved result from disappearing
    // when the next card comes into view; the collection remains unchanged.
    if (recent.length && recent[0].card.id === card.id) return;
    recent.unshift({ card, sure });
    if (recent.length > 12) recent.length = 12;
    updateRecent();
  }

  function monitorFrame() {
    if (!stream || busy || paused || document.hidden || document.body.classList.contains("modal-open")) return;
    // Throttle analysis even if the browser calls timers faster than expected.
    if (Date.now() - lastSampleAt < 260) return;
    lastSampleAt = Date.now();
    let frame;
    try { frame = sampleFrame(); } catch { return; }
    if (!frame) return;
    if (!frame.detected) {
      lostFrames++;
      stableSamples = 0;
      previousFrame = null;
      previousBox = null;
      guide.classList.remove("ready");
      if (lostFrames >= 2) {
        armed = true;
        lastHash = null;
      }
      say("Encuadra los cuatro bordes de la carta para capturarla automáticamente.");
      return;
    }
    lostFrames = 0;
    if (!armed) {
      // Do not scan the same card again just because the hand/camera moved.
      if (hashDistance(frame.hash, lastHash) < 20) {
        say("Carta detectada. Retírala o cambia por otra para continuar.", "ok");
        return;
      }
      armed = true;
      previousFrame = null;
      previousBox = null;
      stableSamples = 0;
    }

    const box = frame.detected.box;
    const geometry = previousBox
      ? Math.abs(box.x - previousBox.x) + Math.abs(box.y - previousBox.y) +
        Math.abs(box.w - previousBox.w) + Math.abs(box.h - previousBox.h)
      : Infinity;
    const movement = frameMovement(frame.gray, previousFrame);
    stableSamples = movement < 21 && geometry < 14 ? stableSamples + 1 : 0;
    previousFrame = frame.gray;
    previousBox = box;
    guide.classList.toggle("ready", stableSamples > 0);
    if (stableSamples < 2) {
      say("Carta detectada: mantenla inmóvil un instante.");
      return;
    }
    if (Date.now() - lastShotAt < 850) return;
    armed = false;
    stableSamples = 0;
    lastHash = frame.hash;
    lastShotAt = Date.now();
    guide.classList.remove("ready");
    capture(frame.crop, true);
  }

  function resumeAutoScan() {
    if (!stream || busy) return;
    previousFrame = null;
    previousBox = null;
    stableSamples = 0;
    armed = true;
    lastHash = null;
    paused = false;
    results.replaceChildren();
    preview.replaceChildren();
    guide.classList.remove("scanning", "ready");
    say("Detección activa: encuadra la carta para volver a intentar.");
  }

  function retryWhenMoved() {
    if (!stream) return;
    paused = false;
    guide.classList.remove("scanning", "ready");
    say("Sin coincidencia segura. Mueve o reemplaza la carta para reintentar.");
  }

  function layoutGuide() {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return;
    const g = guideRect(vw, vh);
    stage.style.aspectRatio = `${vw} / ${vh}`;
    Object.assign(guide.style, { left: `${(g.x / vw) * 100}%`, top: `${(g.y / vh) * 100}%`, width: `${(g.w / vw) * 100}%`, height: `${(g.h / vh) * 100}%` });
  }

  async function startCamera() {
    if (!navigator.mediaDevices?.getUserMedia) { say("This browser can't open the camera. Upload a photo instead.", "error"); return; }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
    } catch (e) {
      say(e && e.name === "NotAllowedError" ? "Camera permission was denied. You can upload a photo instead." : "Couldn't open the camera. Upload a photo instead.", "error");
      return;
    }
    video.srcObject = stream;
    video.addEventListener("loadedmetadata", layoutGuide, { once: true });
    video.play().catch(() => {});
    stage.classList.remove("hidden");
    camBtn.classList.add("hidden");
    shotBtn.classList.remove("hidden");
    stopBtn.classList.remove("hidden");
    activeRun++;
    paused = false;
    armed = true;
    previousFrame = null;
    previousBox = null;
    stableSamples = 0;
    lostFrames = 0;
    lastHash = null;
    say("Detección automática V4: muestra los cuatro bordes de una carta.");
    if (autoTimer != null) clearInterval(autoTimer);
    autoTimer = setInterval(monitorFrame, 300);
    warmUp().catch(() => {});
  }

  function stop() {
    stopCamera();
    paused = true;
    guide.classList.remove("ready", "scanning");
    video.srcObject = null;
    stage.classList.add("hidden");
    camBtn.classList.remove("hidden");
    shotBtn.classList.add("hidden");
    stopBtn.classList.add("hidden");
  }

  async function capture(crop = null, automatic = false) {
    if (!video.videoWidth || busy) return;
    if (!automatic) {
      // Manual capture always works even if no rectangular boundary is found.
      const frame = sampleFrame();
      if (frame?.hash) lastHash = frame.hash;
      armed = false;
    }
    const g = crop || guideRect(video.videoWidth, video.videoHeight);
    await scan(toCanvas(video, g), { automatic });
  }

  async function onFile() {
    const f = file.files?.[0];
    file.value = "";
    if (!f) return;
    if (!/^image\//.test(f.type) || f.size > 25 * 1024 * 1024) { say("Choose an image file under 25 MB.", "error"); return; }
    let bmp;
    try { bmp = await createImageBitmap(f, { imageOrientation: "from-image" }); } catch { say("That image couldn't be opened.", "error"); return; }
    const c = autoCrop(toCanvas(bmp));
    bmp.close?.();
    await scan(c);
  }

  async function scan(canvas, { reader = "ocr", automatic = false } = {}) {
    if (busy) return;
    busy = true;
    const run = activeRun;
    lastCanvas = canvas;
    guide.classList.add("scanning");
    try {
    mount(preview, h("img", { src: canvas.toDataURL("image/jpeg", 0.8), alt: "Captured card", class: "shot" }),
      h("div", { class: "row" },
        h("button", { class: "btn small", type: "button", onclick: () => scan(rotate(lastCanvas)) }, "Rotate ↻"),
        getApiKey() && reader === "ocr" ? h("button", { class: "btn small", type: "button", onclick: () => scan(lastCanvas, { reader: "ai" }) }, "Read with Claude") : null));
    results.replaceChildren();
    let read;
    try {
      if (reader === "ai") {
        say("Asking Claude to read the card…");
        read = await readWithClaude(canvas, state.settings.model);
      } else {
        say("Reading card text on this device…");
        read = await readCard(canvas, (m) => {
          if (m.status === "loading language traineddata" || m.status === "loading tesseract core") say(`Loading OCR engine (first time only)… ${Math.round(m.progress * 100)}%`);
        });
      }
    } catch (e) {
      say(e.message || "No se pudo leer la carta.", "error");
      if (stream) retryWhenMoved();
      return;
    }
    let out;
    try {
      out = await identify(read, (msg) => say(msg));
    } catch (e) {
      say(e.message, "error");
      if (stream) retryWhenMoved();
      return;
    }
    if (!isSure(out) && reader === "ocr" && state.settings.autoAi && getApiKey()) {
      say("OCR wasn't sure. Trying Claude…");
      try {
        const aiRead = await readWithClaude(canvas, state.settings.model);
        const aiOut = await identify(aiRead, (msg) => say(msg));
        if (run === activeRun) showResults(aiOut, "ai", automatic);
      } catch (e) {
        say("Claude could not verify this card; review the OCR alternatives.", "error");
        if (run === activeRun) showResults(out, reader, automatic);
      }
      return;
    }
    if (run === activeRun) showResults(out, reader, automatic);
    } finally {
      busy = false;
      guide.classList.remove("scanning");
    }
  }

  function showResults({ read, matches }, reader, automatic = false) {
    const owned = ownedIds();
    const readLine = h("p", { class: "muted small" }, `Read${reader === "ai" ? " by Claude" : ""}: `,
      h("code", {}, (read.nameText || "—").replace(/\s+/g, " ").slice(0, 60)), " · number ",
      h("code", {}, read.number ? `${read.number}${read.total ? `/${read.total}` : ""}` : "not found"),
      read.hp?.length ? [" · HP ", h("code", {}, read.hp.join("/"))] : null);
    const guess = nameTokens(read.nameText)[0] || "";
    const actions = h("div", { class: "row" },
      stream ? h("button", { class: "btn primary", type: "button", onclick: resumeAutoScan }, "Scan another card") : null,
      reader === "ocr" && getApiKey() ? h("button", { class: "btn", type: "button", onclick: () => scan(lastCanvas, { reader: "ai" }) }, "Not right? Read with Claude") : null,
      reader === "ocr" && !getApiKey() ? h("a", { class: "btn", href: "#/settings" }, "Add a Claude key for hard scans") : null,
      h("a", { class: "btn", href: `#/search?q=${encodeURIComponent(guess)}` }, "Search manually"));

    if (!matches.length) {
      say("No matching card found. Try better light, hold the card flat, or search manually.", "error");
      mount(results, readLine, actions);
      if (stream && reader === "ocr") retryWhenMoved();
      return;
    }
    const sure = isSure({ read, matches });
    say(sure ? "Found it." : "Best guess below. Check it's the right card, or pick another.", sure ? "ok" : "");
    const best = matches[0];
    if (automatic) rememberResult(best, sure);
    mount(results, readLine,
      h("div", { class: "best" }, cardSheet(best, afterAdd)),
      matches.length > 1 ? [h("h3", {}, "Other possibilities"), h("div", { class: "grid" }, matches.slice(1).map((c) => cardTile(c, { owned: owned.has(c.id), score: c.score })))] : null,
      actions);
  }

  function afterAdd(what) {
    if (what !== "added" || !stream) return;
    if (!state.settings.keepCamera) { stop(); return; }
    paused = false;
    say("Guardada. La cámara sigue activa; enseña una carta diferente.", "ok");
  }

  camBtn.addEventListener("click", startCamera);
  shotBtn.addEventListener("click", () => capture());
  stopBtn.addEventListener("click", stop);
  file.addEventListener("change", onFile);
  addEventListener("resize", layoutGuide);

  mount(root,
    h("section", { class: "panel" },
      h("h1", {}, "Escáner Pokémon · Fase 1 V4"),
      h("p", { class: "muted" }, "Muestra los cuatro bordes de una carta y mantenla estable. La cámara seguirá abierta para la siguiente; revisa el resultado antes de guardarlo."),
      h("div", { class: "row" }, camBtn, shotBtn, stopBtn, h("label", { class: "btn", for: "scan-file" }, "Subir foto"), file),
      stage, status, preview, results, recentHost));
}

/**
 * Only claim a match when the number agrees as well as the name, and no other
 * card (e.g. a same-numbered card from another set) is nearly as good.
 */
function isSure({ read, matches }) {
  const top = matches[0];
  if (!top || top.score < 0.82 || !read.number || !sameNumber(top.localId, read.number)) return false;
  // A printed number alone is not a unique identity across expansions.
  // Require matching card name AND printed set total before saying "Found it".
  if (!read.total || !(top.set?.official === read.total || top.set?.total === read.total)) return false;
  if (nameScore(top.name, read.nameText) < 0.78) return false;
  return !matches[1] || top.raw - matches[1].raw >= 0.12;
}

/** Card-shaped region centred in the frame: 85% of the height, capped at 90% of the width. */
export function guideRect(vw, vh) {
  let gh = vh * 0.85, gw = gh * CARD_RATIO;
  if (gw > vw * 0.9) { gw = vw * 0.9; gh = gw / CARD_RATIO; }
  return { x: Math.round((vw - gw) / 2), y: Math.round((vh - gh) / 2), w: Math.round(gw), h: Math.round(gh) };
}

function rotate(src) {
  const c = document.createElement("canvas");
  c.width = src.height;
  c.height = src.width;
  const ctx = c.getContext("2d");
  ctx.translate(c.width, 0);
  ctx.rotate(Math.PI / 2);
  ctx.drawImage(src, 0, 0);
  return c;
}
