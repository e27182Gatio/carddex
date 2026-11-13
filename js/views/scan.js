// Scan: camera (with a card-shaped guide) or photo upload → OCR → TCGdex matches.
// Claude vision is offered as a second reader when OCR can't find the card.

import { readWithClaude } from "../ai.js";
import { h, mount } from "../dom.js";
import { identify } from "../identify.js";
import { nameScore, nameTokens, sameNumber } from "../match.js";
import { autoCrop, readCard, toCanvas, warmUp } from "../ocr.js";
import { getApiKey, ownedIds, state } from "../store.js";
import { cardSheet, cardTile } from "../ui.js";

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
  const video = h("video", { playsinline: true, muted: true, autoplay: true, "aria-label": "Camera preview" });
  const guide = h("div", { class: "guide", "aria-hidden": "true" });
  const stage = h("div", { class: "camera hidden" }, video, guide);
  const status = h("div", { class: "status", role: "status", "aria-live": "polite" });
  const results = h("div", { class: "results" });
  const preview = h("div", { class: "preview" });
  const file = h("input", { type: "file", accept: "image/*", capture: "environment", class: "visually-hidden", id: "scan-file" });

  const camBtn = h("button", { class: "btn primary", type: "button" }, "Start camera");
  const shotBtn = h("button", { class: "btn hidden", type: "button" }, "Capture manually");
  const stopBtn = h("button", { class: "btn hidden", type: "button" }, "Stop camera");

  const say = (msg, kind = "") => {
    if (status.textContent === msg && status.className === `status ${kind}`) return;
    status.className = `status ${kind}`;
    status.textContent = msg;
  };

  // Analyze only a tiny frame: OCR starts after the card is sharp, well-lit and
  // steady. The full-resolution image is used for the actual recognition.
  const ANALYSIS_W = 56, ANALYSIS_H = 80;
  const analysis = document.createElement("canvas");
  analysis.width = ANALYSIS_W;
  analysis.height = ANALYSIS_H;
  const analysisCtx = analysis.getContext("2d", { willReadFrequently: true });
  let previousFrame = null;
  let lastCapturedFrame = null;
  let stableSamples = 0;
  let busy = false;
  let paused = false;
  let needsNewCard = false;

  function difference(a, b) {
    if (!a || !b) return Infinity;
    let sum = 0;
    for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
    return sum / a.length;
  }

  function sampleFrame() {
    if (!video.videoWidth || !video.videoHeight) return null;
    const r = guideRect(video.videoWidth, video.videoHeight);
    analysisCtx.drawImage(video, r.x, r.y, r.w, r.h, 0, 0, ANALYSIS_W, ANALYSIS_H);
    const rgba = analysisCtx.getImageData(0, 0, ANALYSIS_W, ANALYSIS_H).data;
    const pixels = new Uint8Array(ANALYSIS_W * ANALYSIS_H);
    let brightness = 0, squares = 0, edges = 0, count = 0;
    for (let y = 0; y < ANALYSIS_H; y++) {
      for (let x = 0; x < ANALYSIS_W; x++) {
        const i = y * ANALYSIS_W + x;
        const p = i * 4;
        const v = Math.round(0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2]);
        pixels[i] = v;
        brightness += v;
        squares += v * v;
        if (x && y) {
          edges += (Math.abs(v - pixels[i - 1]) + Math.abs(v - pixels[i - ANALYSIS_W])) / 2;
          count++;
        }
      }
    }
    const avg = brightness / pixels.length;
    const contrast = Math.sqrt(Math.max(0, squares / pixels.length - avg * avg));
    return { pixels, brightness: avg, contrast, detail: edges / Math.max(1, count) };
  }

  function monitorFrame() {
    if (!stream || busy || paused || document.hidden) return;
    let frame;
    try { frame = sampleFrame(); } catch { return; }
    if (!frame) return;

    if (needsNewCard) {
      // After saving, don't immediately scan the same card a second time.
      if (difference(frame.pixels, lastCapturedFrame?.pixels) < 14) {
        previousFrame = frame;
        return;
      }
      needsNewCard = false;
      previousFrame = null;
    }

    const motion = difference(frame.pixels, previousFrame?.pixels);
    previousFrame = frame;
    // The earlier detail>=8 and motion<10 gates were too strict on phone
    // previews: some real cards could never auto-trigger. Use contrast OR
    // detail and tolerate normal hand-held movement.
    if (frame.brightness < 22 || frame.brightness > 248 || (frame.contrast < 13 && frame.detail < 2.5)) {
      stableSamples = 0;
      guide.classList.remove("ready");
      say("Enfoca una carta dentro del marco. La captura es automática.");
      return;
    }
    stableSamples = motion < 23 ? stableSamples + 1 : 0;
    guide.classList.toggle("ready", stableSamples > 0);
    if (stableSamples < 2) {
      say("Carta visible: mantenla centrada un instante.");
      return;
    }
    paused = true;
    stableSamples = 0;
    lastCapturedFrame = frame;
    guide.classList.remove("ready");
    guide.classList.add("scanning");
    capture();
  }

  function resumeAutoScan() {
    if (!stream || busy) return;
    previousFrame = null;
    stableSamples = 0;
    paused = false;
    needsNewCard = false;
    results.replaceChildren();
    preview.replaceChildren();
    guide.classList.remove("scanning", "ready");
    say("Escaneo automático activado: encuadra la siguiente carta.");
  }

  function retryWhenMoved() {
    if (!stream) return;
    previousFrame = null;
    stableSamples = 0;
    paused = false;
    needsNewCard = true; // Avoid a loop of OCR reads on the same bad image.
    guide.classList.remove("scanning", "ready");
    say("No se reconoció. Mueve o acerca la carta para reintentar automáticamente.");
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
    paused = false;
    needsNewCard = false;
    previousFrame = null;
    stableSamples = 0;
    say("Escaneo automático activo. Encuadra una carta; no pulses Capture.");
    if (autoTimer != null) clearInterval(autoTimer);
    autoTimer = setInterval(monitorFrame, 250);
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

  async function capture() {
    if (!video.videoWidth || busy) return;
    paused = true;
    try { lastCapturedFrame = sampleFrame(); } catch { /* manual capture still works */ }
    const g = guideRect(video.videoWidth, video.videoHeight);
    // The guide is already a card-shaped crop. Auto-cropping it again sometimes
    // cuts off the collector number or name, causing incorrect matches.
    await scan(toCanvas(video, g));
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
    paused = true;
    await scan(c);
  }

  async function scan(canvas, { reader = "ocr" } = {}) {
    if (busy) return;
    busy = true;
    paused = true;
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
        showResults(aiOut, "ai");
      } catch (e) {
        say("Claude could not verify this card; review the OCR alternatives.", "error");
        showResults(out, reader);
      }
      return;
    }
    showResults(out, reader);
    } finally {
      busy = false;
      guide.classList.remove("scanning");
    }
  }

  function showResults({ read, matches }, reader) {
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
    mount(results, readLine,
      h("div", { class: "best" }, cardSheet(best, afterAdd)),
      matches.length > 1 ? [h("h3", {}, "Other possibilities"), h("div", { class: "grid" }, matches.slice(1).map((c) => cardTile(c, { owned: owned.has(c.id), score: c.score })))] : null,
      actions);
  }

  function afterAdd(what) {
    if (what === "added" && stream && state.settings.keepCamera) {
      results.replaceChildren();
      preview.replaceChildren();
      stableSamples = 0;
      previousFrame = null;
      paused = false;
      needsNewCard = true;
      say("Carta guardada. Cambia la carta: la próxima se escaneará sola.", "ok");
    }
  }

  camBtn.addEventListener("click", startCamera);
  shotBtn.addEventListener("click", capture);
  stopBtn.addEventListener("click", stop);
  file.addEventListener("change", onFile);
  addEventListener("resize", layoutGuide);

  mount(root,
    h("section", { class: "panel" },
      h("h1", {}, "Scan a card"),
      h("p", { class: "muted" }, "Acerca la carta al recuadro y manténla visible. El escaneo se activa sin pulsar Capture. Comprueba la coincidencia antes de guardarla."),
      h("div", { class: "row" }, camBtn, shotBtn, stopBtn, h("label", { class: "btn", for: "scan-file" }, "Upload photo"), file),
      stage, status, preview, results));
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
