/**
 * =============================================================================
 *  Serverless Cloud File Upload & Processing System — app.js
 *  Student  : Adarsh Mund  |  Centurion University
 *  Purpose  : Client-side upload pipeline simulation, drag-and-drop handler,
 *             image preview rendering, telemetry table population.
 * =============================================================================
 */

"use strict";

// ---------------------------------------------------------------------------
// Constants & State
// ---------------------------------------------------------------------------
const ACCEPTED_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_FILE_SIZE  = 10 * 1024 * 1024; // 10 MB

/** Simulated AWS region / bucket for display purposes */
const AWS_REGION  = "ap-south-1";
const BUCKET_NAME = "adarsh-cloud-uploads-bucket";

/** Application state object */
const state = {
  selectedFile   : null,
  originalDataURL: null,
  thumbDataURL   : null,
  processing     : false,
};

// ---------------------------------------------------------------------------
// DOM References (resolved after DOMContentLoaded)
// ---------------------------------------------------------------------------
let els = {};

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

/** Format bytes to human-readable string */
function fmtBytes(bytes) {
  if (bytes === 0) return "0 B";
  const k = 1024, sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

/** Format milliseconds to readable latency string */
function fmtMs(ms) {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`;
}

/** Zero-pad numbers */
function zp(n, len = 2) { return String(n).padStart(len, "0"); }

/** ISO-like timestamp for log stream */
function logTs() {
  const d = new Date();
  return `${d.getFullYear()}-${zp(d.getMonth()+1)}-${zp(d.getDate())} ` +
         `${zp(d.getHours())}:${zp(d.getMinutes())}:${zp(d.getSeconds())}.${zp(d.getMilliseconds(), 3)}`;
}

/** Sanitize a string for safe HTML insertion */
function esc(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Get image dimensions from a File object → Promise<{w, h}> */
function getImageDimensions(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload  = () => { URL.revokeObjectURL(url); resolve({ w: img.naturalWidth, h: img.naturalHeight }); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Failed to read image dimensions.")); };
    img.src = url;
  });
}

/** Generate 200×200 thumbnail using Canvas API → Promise<{dataURL, width, height, bytes}> */
function generateThumbnail(file, maxW = 200, maxH = 200) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);

    img.onload = () => {
      URL.revokeObjectURL(url);

      // Compute scaled dimensions preserving aspect ratio
      let { naturalWidth: w, naturalHeight: h } = img;
      const ratio = Math.min(maxW / w, maxH / h);
      const tw = Math.round(w * ratio);
      const th = Math.round(h * ratio);

      const canvas = document.createElement("canvas");
      canvas.width  = tw;
      canvas.height = th;

      const ctx = canvas.getContext("2d");
      // Smooth downscaling via multiple passes for large images
      ctx.imageSmoothingEnabled  = true;
      ctx.imageSmoothingQuality  = "high";
      ctx.drawImage(img, 0, 0, tw, th);

      // Encode based on original type (WebP → WebP, else JPEG for compression demo)
      const mimeOut = file.type === "image/png" ? "image/png"
                    : file.type === "image/webp" ? "image/webp"
                    : "image/jpeg";
      const quality = mimeOut === "image/png" ? 1.0 : 0.82;
      const dataURL = canvas.toDataURL(mimeOut, quality);

      // Approximate byte size from base64 payload
      const base64 = dataURL.split(",")[1] || "";
      const approxBytes = Math.round((base64.length * 3) / 4);

      resolve({ dataURL, width: tw, height: th, bytes: approxBytes });
    };

    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Canvas image load failed.")); };
    img.src = URL.createObjectURL(file);  // second URL for img.src (first was revoked in onload)
  });
}

/** Syntax-highlight a JSON object for display in the S3 event box */
function highlightJSON(obj) {
  const raw = JSON.stringify(obj, null, 2);
  return raw.replace(
    /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,
    (match) => {
      let cls = "json-num";
      if (/^"/.test(match)) cls = /:$/.test(match) ? "json-key" : "json-str";
      else if (/true|false/.test(match)) cls = "json-bool";
      else if (/null/.test(match)) cls = "json-null";
      return `<span class="${cls}">${esc(match)}</span>`;
    }
  );
}

// ---------------------------------------------------------------------------
// Log stream helpers
// ---------------------------------------------------------------------------
function appendLog(level, message) {
  const entry = document.createElement("div");
  entry.className = "log-entry";
  entry.innerHTML = `
    <span class="log-ts">${logTs()}</span>
    <span class="log-lvl ${level}">${level}</span>
    <span class="log-msg">${esc(message)}</span>`;
  els.logStream.appendChild(entry);
  els.logStream.scrollTop = els.logStream.scrollHeight;
}

function clearLogs() {
  els.logStream.innerHTML = "";
}

// ---------------------------------------------------------------------------
// Status & Pipeline helpers
// ---------------------------------------------------------------------------
const PIPELINE_STEPS = [
  { id: "step-select",   label: "📁 File Selected" },
  { id: "step-upload",   label: "☁️ S3 PUT" },
  { id: "step-trigger",  label: "⚡ Lambda Trigger" },
  { id: "step-process",  label: "🖼️ Processing" },
  { id: "step-store",    label: "💾 Store Output" },
  { id: "step-done",     label: "✅ Complete" },
];

function setStatus(type, text, stage = "") {
  els.statusBar.className = `status-bar ${type}`;
  els.statusText.textContent  = text;
  els.statusStage.textContent = stage;
}

function activatePipelineStep(index) {
  PIPELINE_STEPS.forEach((s, i) => {
    const el = document.getElementById(s.id);
    if (!el) return;
    el.classList.remove("active", "done");
    if (i < index) el.classList.add("done");
    else if (i === index) el.classList.add("active");
  });
}

function setProgress(pct) {
  els.progressTrack.classList.toggle("visible", pct > 0 && pct < 100);
  els.progressFill.style.width = `${Math.min(100, pct)}%`;
}

// ---------------------------------------------------------------------------
// Pipeline simulation — mirrors the real Lambda execution flow
// ---------------------------------------------------------------------------
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function runPipeline(file) {
  if (state.processing) return;
  state.processing = true;
  clearLogs();

  const requestId = "req-" + Math.random().toString(36).slice(2, 10).toUpperCase();
  const s3Key     = `uploads/${file.name}`;

  // ── Step 0: File selected ────────────────────────────────────────────────
  activatePipelineStep(0);
  setStatus("progress", "Reading file metadata…", "LOCAL");
  setProgress(5);
  appendLog("INFO", `File selected: ${file.name} (${fmtBytes(file.size)})`);
  appendLog("INFO", `MIME type: ${file.type}`);

  // Get original dimensions
  let origDims;
  try {
    origDims = await getImageDimensions(file);
  } catch (err) {
    appendLog("ERROR", `Could not read image dimensions: ${err.message}`);
    setStatus("error", "Failed to read image. Please try again.", "ERROR");
    state.processing = false;
    return;
  }

  // Show original preview immediately
  const origReader = new FileReader();
  origReader.onload = (e) => {
    state.originalDataURL = e.target.result;
    showPanel("original", e.target.result, file.name, fmtBytes(file.size));
  };
  origReader.readAsDataURL(file);

  await sleep(400);

  // ── Step 1: Simulated S3 Upload ──────────────────────────────────────────
  activatePipelineStep(1);
  setStatus("progress", `Uploading to S3 bucket (${BUCKET_NAME})…`, "S3 PUT");
  setProgress(20);
  appendLog("INFO", `Initiating S3 PutObject → s3://${BUCKET_NAME}/${s3Key}`);
  appendLog("INFO", `Region: ${AWS_REGION} | Content-Type: ${file.type}`);

  // Simulate upload time proportional to file size
  const uploadDelay = Math.min(800, Math.max(300, file.size / 10000));
  await sleep(uploadDelay);
  setProgress(45);
  appendLog("SUCCESS", `S3 PutObject complete. ETag: "${Math.random().toString(36).slice(2, 18)}"`);

  await sleep(200);

  // ── Step 2: Lambda Trigger ───────────────────────────────────────────────
  activatePipelineStep(2);
  setStatus("progress", "S3 Event emitted → Lambda trigger fired…", "LAMBDA");
  setProgress(55);
  appendLog("INFO", `S3 Event: ObjectCreated:Put | key: ${s3Key}`);
  appendLog("INFO", `Lambda invoked | function: image-processing-pipeline`);
  appendLog("INFO", `AWS Request ID: ${requestId}`);

  await sleep(350);

  // ── Step 3: Processing (thumbnail generation) ────────────────────────────
  activatePipelineStep(3);
  setStatus("progress", "Lambda processing image → generating thumbnail…", "PROCESSING");
  setProgress(68);
  appendLog("INFO", `Downloaded s3://${BUCKET_NAME}/${s3Key} (${fmtBytes(file.size)})`);
  appendLog("INFO", `Image opened | format: ${file.type.split("/")[1].toUpperCase()} | dims: ${origDims.w}×${origDims.h}`);
  appendLog("INFO", `Generating 200×200 thumbnail (LANCZOS resampling)…`);

  let thumbResult;
  try {
    thumbResult = await generateThumbnail(file, 200, 200);
  } catch (err) {
    appendLog("ERROR", `Thumbnail generation failed: ${err.message}`);
    setStatus("error", "Thumbnail generation failed.", "ERROR");
    state.processing = false;
    return;
  }

  state.thumbDataURL = thumbResult.dataURL;
  setProgress(80);
  appendLog("SUCCESS", `Thumbnail generated | dims: ${thumbResult.width}×${thumbResult.height} | size: ${fmtBytes(thumbResult.bytes)}`);

  await sleep(300);

  // ── Step 4: Store output ─────────────────────────────────────────────────
  activatePipelineStep(4);
  setStatus("progress", "Uploading processed output back to S3…", "S3 PUT");
  setProgress(88);

  const baseName   = file.name;
  const thumbKey   = `processed/thumb_${baseName}`;
  const metaKey    = `processed/meta_${baseName.replace(/\.[^.]+$/, "")}.json`;
  const execMs     = Math.round(uploadDelay + 350 + 300 + 200);
  const reduction  = (((file.size - thumbResult.bytes) / file.size) * 100).toFixed(2);

  appendLog("INFO",    `Uploading thumbnail → s3://${BUCKET_NAME}/${thumbKey}`);
  appendLog("SUCCESS", `Thumbnail uploaded | size: ${fmtBytes(thumbResult.bytes)} | reduction: ${reduction}%`);
  appendLog("INFO",    `Uploading metadata → s3://${BUCKET_NAME}/${metaKey}`);

  await sleep(350);

  // ── Step 5: Done ─────────────────────────────────────────────────────────
  activatePipelineStep(5);
  setStatus("success", "Pipeline complete — thumbnail and metadata stored in S3!", "DONE");
  setProgress(100);
  setTimeout(() => setProgress(0), 800);

  appendLog("SUCCESS", `Pipeline complete | latency: ${fmtMs(execMs)} | request_id: ${requestId}`);

  // Show processed thumbnail
  showPanel("processed", thumbResult.dataURL, `thumb_${baseName}`, fmtBytes(thumbResult.bytes));

  // Populate metadata table
  populateMetaTable({
    fileName     : file.name,
    s3Key,
    thumbKey,
    metaKey,
    origW        : origDims.w,
    origH        : origDims.h,
    thumbW       : thumbResult.width,
    thumbH       : thumbResult.height,
    origBytes    : file.size,
    thumbBytes   : thumbResult.bytes,
    reduction,
    execMs,
    requestId,
    fileType     : file.type,
    bucket       : BUCKET_NAME,
    region       : AWS_REGION,
  });

  // Populate S3 event JSON viewer
  populateEventViewer({
    s3Key, bucket: BUCKET_NAME, fileSize: file.size, requestId, region: AWS_REGION,
  });

  // Update stat cards
  updateStatCards({ origBytes: file.size, thumbBytes: thumbResult.bytes, execMs, reduction });

  // Reveal result section
  els.resultSection.classList.remove("hidden");
  els.resultSection.scrollIntoView({ behavior: "smooth", block: "start" });

  state.processing = false;
}

// ---------------------------------------------------------------------------
// UI population helpers
// ---------------------------------------------------------------------------

function showPanel(panelType, dataURL, label, sizeLabel) {
  const panel = els[`${panelType}Panel`];
  const img   = panel.querySelector("img") || document.createElement("img");
  img.src = dataURL;
  img.alt = label;
  const body = panel.querySelector(".image-panel-body");
  body.innerHTML = "";
  body.appendChild(img);
  panel.querySelector(".panel-size-badge").textContent = sizeLabel;
}

function populateMetaTable(d) {
  const rows = [
    { icon: "📄", key: "File Name",           val: d.fileName,                              cls: "" },
    { icon: "📦", key: "S3 Source Key",        val: d.s3Key,                                 cls: "" },
    { icon: "🖼️", key: "Original Dimensions",  val: `${d.origW} × ${d.origH} px`,            cls: "" },
    { icon: "📐", key: "Thumbnail Dimensions", val: `${d.thumbW} × ${d.thumbH} px`,           cls: "" },
    { icon: "💾", key: "Original Size",        val: fmtBytes(d.origBytes),                   cls: "warn" },
    { icon: "🗜️", key: "Thumbnail Size",       val: fmtBytes(d.thumbBytes),                  cls: "highlight" },
    { icon: "📉", key: "Size Reduction",       val: `${d.reduction}%`,                        cls: "highlight" },
    { icon: "⏱️", key: "Execution Latency",    val: fmtMs(d.execMs),                         cls: "" },
    { icon: "🔖", key: "Image Format",         val: d.fileType.split("/")[1].toUpperCase(),  cls: "" },
    { icon: "🪣", key: "S3 Bucket",            val: d.bucket,                                cls: "dim" },
    { icon: "🌏", key: "AWS Region",           val: d.region,                                cls: "dim" },
    { icon: "🔑", key: "Lambda Request ID",    val: d.requestId,                             cls: "dim" },
    { icon: "📤", key: "Thumbnail Key",        val: d.thumbKey,                              cls: "" },
    { icon: "📋", key: "Metadata Key",         val: d.metaKey,                               cls: "" },
  ];

  els.metaTable.innerHTML = rows.map(r => `
    <tr>
      <td class="meta-key"><span class="key-icon">${r.icon}</span>${esc(r.key)}</td>
      <td class="meta-val ${r.cls}">${esc(r.val)}</td>
    </tr>`).join("");
}

function populateEventViewer({ s3Key, bucket, fileSize, requestId, region }) {
  const event = {
    Records: [{
      eventVersion: "2.1",
      eventSource:  "aws:s3",
      awsRegion:    region,
      eventTime:    new Date().toISOString(),
      eventName:    "ObjectCreated:Put",
      requestParameters: { sourceIPAddress: "203.0.113.42" },
      responseElements: {
        "x-amz-request-id": requestId,
        "x-amz-id-2": "base64/" + Math.random().toString(36).slice(2, 30),
      },
      s3: {
        s3SchemaVersion: "1.0",
        configurationId: "image-upload-trigger",
        bucket: {
          name: bucket,
          ownerIdentity: { principalId: "A3NF8QP9EXAMPLE" },
          arn:  `arn:aws:s3:::${bucket}`,
        },
        object: {
          key:       encodeURIComponent(s3Key),
          size:      fileSize,
          eTag:      Math.random().toString(36).slice(2, 18),
          sequencer: Math.random().toString(16).slice(2, 18).toUpperCase(),
        },
      },
    }],
  };

  els.eventViewer.innerHTML = highlightJSON(event);
}

function updateStatCards({ origBytes, thumbBytes, execMs, reduction }) {
  document.getElementById("stat-reduction").textContent  = `${reduction}%`;
  document.getElementById("stat-latency").textContent    = fmtMs(execMs);
  document.getElementById("stat-orig-size").textContent  = fmtBytes(origBytes);
  document.getElementById("stat-thumb-size").textContent = fmtBytes(thumbBytes);
}

// ---------------------------------------------------------------------------
// File validation
// ---------------------------------------------------------------------------
function validateFile(file) {
  if (!ACCEPTED_TYPES.includes(file.type)) {
    return `Unsupported file type: ${file.type}. Please upload JPG, PNG, or WebP.`;
  }
  if (file.size > MAX_FILE_SIZE) {
    return `File too large (${fmtBytes(file.size)}). Maximum allowed size is ${fmtBytes(MAX_FILE_SIZE)}.`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

function handleFileSelection(file) {
  const err = validateFile(file);
  if (err) {
    setStatus("error", err, "VALIDATION");
    appendLog("ERROR", err);
    return;
  }
  state.selectedFile = file;
  els.fileName.textContent = file.name;
  els.fileSize.textContent = fmtBytes(file.size);
  els.fileCard.classList.remove("hidden");
  els.uploadBtn.disabled = false;
  setStatus("idle", `Ready — ${file.name} (${fmtBytes(file.size)}) selected.`, "READY");
  appendLog("INFO", `File ready: ${file.name} | ${fmtBytes(file.size)} | ${file.type}`);
}

function bindDropZone() {
  const dz = els.dropZone;

  dz.addEventListener("dragover", (e) => {
    e.preventDefault();
    dz.classList.add("drag-over");
  });

  dz.addEventListener("dragleave", (e) => {
    if (!dz.contains(e.relatedTarget)) dz.classList.remove("drag-over");
  });

  dz.addEventListener("drop", (e) => {
    e.preventDefault();
    dz.classList.remove("drag-over");
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) handleFileSelection(files[0]);
  });

  dz.addEventListener("click", () => els.fileInput.click());

  els.fileInput.addEventListener("change", () => {
    if (els.fileInput.files.length > 0) handleFileSelection(els.fileInput.files[0]);
  });
}

// ---------------------------------------------------------------------------
// Initialise pipeline step indicators
// ---------------------------------------------------------------------------
function buildPipeline() {
  els.pipelineRow.innerHTML = PIPELINE_STEPS.map((s, i) => {
    const arrow = i < PIPELINE_STEPS.length - 1
      ? `<span class="pipeline-arrow">›</span>` : "";
    return `<div id="${s.id}" class="pipeline-step">${s.label}</div>${arrow}`;
  }).join("");
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------
document.addEventListener("DOMContentLoaded", () => {
  // Resolve DOM references
  els = {
    dropZone      : document.getElementById("drop-zone"),
    fileInput     : document.getElementById("file-input"),
    fileCard      : document.getElementById("file-card"),
    fileName      : document.getElementById("file-name"),
    fileSize      : document.getElementById("file-size"),
    uploadBtn     : document.getElementById("upload-btn"),
    clearBtn      : document.getElementById("clear-btn"),
    statusBar     : document.getElementById("status-bar"),
    statusText    : document.getElementById("status-text"),
    statusStage   : document.getElementById("status-stage"),
    progressTrack : document.getElementById("progress-track"),
    progressFill  : document.getElementById("progress-fill"),
    pipelineRow   : document.getElementById("pipeline-row"),
    logStream     : document.getElementById("log-stream"),
    resultSection : document.getElementById("result-section"),
    originalPanel : document.getElementById("panel-original"),
    processedPanel: document.getElementById("panel-processed"),
    metaTable     : document.getElementById("meta-table-body"),
    eventViewer   : document.getElementById("event-viewer"),
  };

  // Build pipeline steps UI
  buildPipeline();

  // Bind drag-and-drop + file input
  bindDropZone();

  // Upload button → run pipeline
  els.uploadBtn.addEventListener("click", () => {
    if (state.selectedFile && !state.processing) {
      runPipeline(state.selectedFile);
    }
  });

  // Clear / Reset button
  els.clearBtn.addEventListener("click", () => {
    state.selectedFile    = null;
    state.originalDataURL = null;
    state.thumbDataURL    = null;
    state.processing      = false;

    els.fileCard.classList.add("hidden");
    els.resultSection.classList.add("hidden");
    els.uploadBtn.disabled = true;
    els.fileInput.value    = "";
    clearLogs();
    setProgress(0);
    setStatus("idle", "Drop an image file here or click to browse.", "IDLE");
    PIPELINE_STEPS.forEach(s => {
      const el = document.getElementById(s.id);
      if (el) el.classList.remove("active", "done");
    });
    appendLog("INFO", "Session reset. Ready for a new upload.");
  });

  // Initial log entry
  appendLog("INFO", "System ready | Lambda Image Processing Pipeline v1.0");
  appendLog("INFO", `Target bucket: ${BUCKET_NAME} | Region: ${AWS_REGION}`);
  appendLog("INFO", "Waiting for file upload…");
});
