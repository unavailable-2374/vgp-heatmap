"use strict";

let RESOURCE_CATALOG = null;
let PORTAL_READY = false;
let PORTAL_SCOPE = "pair";
let PICKER_MAP = new Map();
let PAIR_A = null;
let PAIR_B = null;
let RESOURCE_FILTER = "all";
let RESOURCE_PAGE = 1;
let RESOURCE_RESULTS = [];
let BULK_SCOPE = "selection";
let PORTAL_TOAST_TIMER = null;
const PAF_VERSIONS = {
  raw: { label: "Raw", prefix: "raw" },
  filter: { label: "Filtered", prefix: "filter" },
  cmaes: { label: "CMA-ES", prefix: "cmaes" },
  cmaes_sc: { label: "CMA-ES SC", prefix: "cmaes_sc" },
};
let ACTIVE_PAF_VERSION = "cmaes";

const RESOURCE_PAGE_SIZE = 8;

function portalEscape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function portalFormatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function portalInitials(name) {
  return String(name || "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || "")
    .join("");
}

function portalDataAvailable() {
  return typeof DATA !== "undefined" && DATA && DATA.n;
}

function pickerLabel(idx) {
  return `${prettyName(idx)} — ${accFor(idx) || "accession n/a"}`;
}

function populatePairPickers() {
  if (!portalDataAvailable()) return;
  PICKER_MAP = new Map();
  const optionHtml = DATA.leafOrder.map((_, idx) => {
    const label = pickerLabel(idx);
    PICKER_MAP.set(label.toLowerCase(), idx);
    PICKER_MAP.set(prettyName(idx).toLowerCase(), idx);
    const accessions = DATA.speciesToAcc[DATA.leafOrder[idx]] || [];
    accessions.filter(Boolean).forEach((accession) => PICKER_MAP.set(accession.toLowerCase(), idx));
    return `<option value="${portalEscape(label)}"></option>`;
  }).join("");
  document.getElementById("pair-a-list").innerHTML = optionHtml;
  document.getElementById("pair-b-list").innerHTML = optionHtml;
}

function resolvePickerValue(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return null;
  if (PICKER_MAP.has(normalized)) return PICKER_MAP.get(normalized);
  const accession = normalized.match(/gc[af]_\d+\.\d+/)?.[0];
  if (accession && PICKER_MAP.has(accession)) return PICKER_MAP.get(accession);
  const candidates = [...PICKER_MAP.entries()]
    .filter(([label]) => label.includes(normalized))
    .map(([, idx]) => idx);
  return [...new Set(candidates)].length === 1 ? candidates[0] : null;
}

function setPairPicker(which, idx) {
  const input = document.getElementById(`pair-${which}-input`);
  const meta = document.getElementById(`pair-${which}-meta`);
  if (!Number.isInteger(idx) || idx < 0 || idx >= DATA.n) {
    if (which === "a") PAIR_A = null;
    else PAIR_B = null;
    meta.textContent = `Select the ${which === "a" ? "first" : "second"} assembly`;
    renderPairResult();
    return;
  }
  if (which === "a") PAIR_A = idx;
  else PAIR_B = idx;
  input.value = pickerLabel(idx);
  const cladeIdx = DATA.speciesCladeIdx[idx];
  const common = DATA.commonNames?.[idx];
  meta.textContent = `${DATA.cladeNames[cladeIdx]}${common ? ` · ${common}` : ""}`;
  renderPairResult();
}

function handlePickerInput(which) {
  const input = document.getElementById(`pair-${which}-input`);
  const idx = resolvePickerValue(input.value);
  if (idx !== null) setPairPicker(which, idx);
  else {
    if (which === "a") PAIR_A = null;
    else PAIR_B = null;
    document.getElementById(`pair-${which}-meta`).textContent =
      input.value.trim() ? "Choose one of the matching assemblies" : "Select an assembly";
    renderPairResult();
  }
}

function swapPairGenomes() {
  const previousA = PAIR_A;
  const previousB = PAIR_B;
  if (previousB !== null) setPairPicker("a", previousB);
  else {
    PAIR_A = null;
    document.getElementById("pair-a-input").value = "";
  }
  if (previousA !== null) setPairPicker("b", previousA);
  else {
    PAIR_B = null;
    document.getElementById("pair-b-input").value = "";
  }
  renderPairResult();
}

function usePinnedPair() {
  if (!pinnedPair) return;
  setPairPicker("a", pinnedPair.row);
  setPairPicker("b", pinnedPair.col);
  setDlScope("pair");
}

function pairFileCard(queryIdx, targetIdx, role) {
  const filename = pafName(queryIdx, targetIdx);
  if (!filename) {
    return `<article class="pair-file">
      <span class="pair-file-role">${role}</span>
      <h3>Accession unavailable</h3>
      <code>No PAF filename could be generated.</code>
    </article>`;
  }
  const version = PAF_VERSIONS[ACTIVE_PAF_VERSION];
  const baseHttps = `https://genomeark.s3.amazonaws.com/working/staging/all_vs_all_alignments/FastGA/${version.prefix}/`;
  const baseUri = `s3://genomeark/working/staging/all_vs_all_alignments/FastGA/${version.prefix}/`;
  const stem = filename.replace(/\.paf\.gz$/, "");
  const artifacts = [
    { suffix: ".paf.gz", label: "PAF", ready: ACTIVE_PAF_VERSION === "cmaes" || ACTIVE_PAF_VERSION === "cmaes_sc" },
    { suffix: ".cov", label: "COV", ready: false },
    { suffix: ".id", label: "ID", ready: false },
  ];
  const links = artifacts.map((artifact) => {
    const file = `${stem}${artifact.suffix}`;
    const href = `${baseHttps}${file}`;
    return artifact.ready
      ? `<a href="${portalEscape(href)}" download="${portalEscape(file)}">Download .${artifact.label.toLowerCase()}</a>`
      : `<button class="artifact-pending" title="S3 path reserved; awaiting upload">${artifact.label} pending S3</button>`;
  }).join("");
  return `<article class="pair-file">
    <span class="pair-file-role">${role}</span>
    <h3><i>${portalEscape(prettyName(queryIdx))}</i> &rarr; <i>${portalEscape(prettyName(targetIdx))}</i></h3>
    <code>${portalEscape(filename)}</code>
    <div class="pair-file-actions">${links}
      <button onclick="portalCopyText('${portalEscape(baseUri + filename)}', this)">Copy S3 URI</button>
    </div>
  </article>`;
}

function setPafVersion(version) {
  if (!PAF_VERSIONS[version]) return;
  ACTIVE_PAF_VERSION = version;
  renderPairResult();
}

function populatePafVersions() {
  const select = document.getElementById("paf-version-select");
  if (!select) return;
  select.innerHTML = Object.entries(PAF_VERSIONS)
    .map(([value, item]) => `<option value="${value}"${value === ACTIVE_PAF_VERSION ? " selected" : ""}>${item.label}</option>`)
    .join("");
}

function renderPairResult() {
  const result = document.getElementById("pair-result");
  if (!result) return;
  const button = document.getElementById("use-pinned-pair");
  if (button) button.disabled = !pinnedPair;
  if (PAIR_A === null || PAIR_B === null || PAIR_A === PAIR_B) {
    const same = PAIR_A !== null && PAIR_A === PAIR_B;
    result.className = "pair-result empty";
    result.innerHTML = `<div class="pair-empty-mark"><span>A</span><i></i><span>B</span></div>
      <div><b>${same ? "Choose two different genomes" : "Select two different genomes"}</b>
      <p>Both directional files will appear here: A &rarr; B and B &rarr; A.</p></div>`;
    return;
  }
  result.className = "pair-result";
  result.innerHTML = `<div class="pair-result-head">
      <span>2 DIRECTIONS · PAF + COV + ID</span>
      <span class="pair-online">Public GenomeArk bucket</span>
    </div>
    <div class="pair-files">
      ${pairFileCard(PAIR_A, PAIR_B, "A → B · A AS QUERY")}
      ${pairFileCard(PAIR_B, PAIR_A, "B → A · B AS QUERY")}
    </div>`;
}

function resourceUrl(format, record) {
  const storage = RESOURCE_CATALOG?.storage?.[format];
  const file = record.files?.[format];
  if (!storage?.baseUrl || !storage?.pathTemplate || !file?.accession) return "";
  const path = storage.pathTemplate
    .replaceAll("{accession}", encodeURIComponent(file.accession))
    .replaceAll("{filename}", encodeURIComponent(file.fileName || ""));
  return `${storage.baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function resourceState(format, record) {
  if (!record.files?.[format]?.accession) return "unavailable";
  return resourceUrl(format, record) ? "ready" : "pending";
}

function normalizedResourceRecords() {
  if (!RESOURCE_CATALOG) return [];
  const colors = portalDataAvailable()
    ? Object.fromEntries(DATA.cladeNames.map((name, idx) => [name, DATA.cladeColors[idx]]))
    : {};
  const records = RESOURCE_CATALOG.records.map((record) => ({
    ...record,
    cladeColor: colors[record.clade] || "#98a5b3",
  }));
  RESOURCE_CATALOG.unmappedGff.forEach((record) => {
    records.push({
      id: `unmapped-gff-${record.accession}`,
      scientificName: record.organismName || "Unmapped annotation",
      commonName: record.commonName || "Annotation-only assembly",
      clade: "Other",
      cladeColor: colors.Other || "#98a5b3",
      accessions: { primary: record.accession, ucsc: "" },
      extra: true,
      files: {
        paf: { accession: "", fileName: "", size: null },
        gff: { accession: record.accession, fileName: record.fileName, size: record.size },
        fa: { accession: "", fileName: "", size: null },
      },
    });
  });
  return records;
}

function applyResourceFilters() {
  const records = normalizedResourceRecords();
  const query = document.getElementById("resource-search").value.trim().toLowerCase();
  RESOURCE_RESULTS = records.filter((record) => {
    if (RESOURCE_FILTER !== "all" && !record.files?.[RESOURCE_FILTER]?.accession) return false;
    if (!query) return true;
    const searchable = [
      record.scientificName,
      record.commonName,
      record.clade,
      record.accessions?.primary,
      record.accessions?.ucsc,
      record.files?.gff?.accession,
    ].filter(Boolean).join(" ").toLowerCase();
    return searchable.includes(query);
  });
  RESOURCE_PAGE = 1;
  renderResourceList();
}

function resourceAssetButton(format, record) {
  const state = resourceState(format, record);
  const file = record.files?.[format] || {};
  const size = portalFormatBytes(file.size);
  const label = state === "ready" ? (size || "Download") : state === "pending" ? "S3 pending" : "Not mapped";
  if (state === "ready") {
    return `<a class="resource-asset ready" href="${portalEscape(resourceUrl(format, record))}"
      download="${portalEscape(file.fileName)}"><b>${format.toUpperCase()}</b>${portalEscape(label)}</a>`;
  }
  return `<button class="resource-asset ${state}" type="button"
    onclick="handlePendingResource('${format}', '${portalEscape(record.id)}')"
    ${state === "unavailable" ? "disabled" : ""}><b>${format.toUpperCase()}</b>${portalEscape(label)}</button>`;
}

function renderResourceList() {
  const list = document.getElementById("resource-list");
  const empty = document.getElementById("resource-empty");
  if (!RESOURCE_CATALOG) {
    list.innerHTML = `<div class="resource-row"><span>Loading catalogue…</span></div>`;
    return;
  }
  const start = (RESOURCE_PAGE - 1) * RESOURCE_PAGE_SIZE;
  const pageRecords = RESOURCE_RESULTS.slice(start, start + RESOURCE_PAGE_SIZE);
  list.style.display = pageRecords.length ? "block" : "none";
  empty.style.display = pageRecords.length ? "none" : "flex";
  list.innerHTML = pageRecords.map((record) => {
    const primary = record.accessions?.primary || record.files?.gff?.accession || "—";
    const annotationAcc = record.files?.gff?.accession;
    const secondary = annotationAcc && annotationAcc !== primary
      ? `GFF ${annotationAcc}`
      : record.accessions?.ucsc && record.accessions.ucsc !== primary
        ? `UCSC ${record.accessions.ucsc}`
        : "MAIN HAPLOTYPE";
    return `<article class="resource-row">
      <div class="resource-organism">
        <span class="resource-avatar">${portalEscape(portalInitials(record.scientificName))}</span>
        <div><b>${portalEscape(record.scientificName)}</b>
        <small>${portalEscape(record.commonName || (record.extra ? "Annotation-only assembly" : "—"))}</small></div>
      </div>
      <div class="resource-accession"><code>${portalEscape(primary)}</code><small>${portalEscape(secondary)}</small></div>
      <span class="resource-clade" style="--clade-color:${portalEscape(record.cladeColor)}">
        <i></i>${portalEscape(record.clade || "Other")}
      </span>
      <div class="resource-assets">
        ${resourceAssetButton("gff", record)}
        ${resourceAssetButton("fa", record)}
      </div>
    </article>`;
  }).join("");
  renderResourcePagination();
}

function renderResourcePagination() {
  const totalPages = Math.max(1, Math.ceil(RESOURCE_RESULTS.length / RESOURCE_PAGE_SIZE));
  RESOURCE_PAGE = Math.min(RESOURCE_PAGE, totalPages);
  const pages = [...new Set([1, totalPages, RESOURCE_PAGE - 1, RESOURCE_PAGE, RESOURCE_PAGE + 1])]
    .filter((page) => page >= 1 && page <= totalPages)
    .sort((a, b) => a - b);
  const html = [`<button data-resource-page="${RESOURCE_PAGE - 1}" ${RESOURCE_PAGE === 1 ? "disabled" : ""}>‹</button>`];
  let previous = 0;
  pages.forEach((page) => {
    if (page - previous > 1) html.push("<button disabled>…</button>");
    html.push(`<button data-resource-page="${page}" class="${page === RESOURCE_PAGE ? "active" : ""}">${page}</button>`);
    previous = page;
  });
  html.push(`<button data-resource-page="${RESOURCE_PAGE + 1}" ${RESOURCE_PAGE === totalPages ? "disabled" : ""}>›</button>`);
  const pagination = document.getElementById("resource-pagination");
  pagination.innerHTML = html.join("");
  pagination.querySelectorAll("button[data-resource-page]:not(:disabled)").forEach((button) => {
    button.addEventListener("click", () => {
      RESOURCE_PAGE = Number(button.dataset.resourcePage);
      renderResourceList();
      document.querySelector(".portal-body").scrollTop = 0;
    });
  });
  const start = RESOURCE_RESULTS.length ? (RESOURCE_PAGE - 1) * RESOURCE_PAGE_SIZE + 1 : 0;
  const end = Math.min(RESOURCE_PAGE * RESOURCE_PAGE_SIZE, RESOURCE_RESULTS.length);
  document.getElementById("resource-page-summary").textContent =
    `Showing ${start}–${end} of ${RESOURCE_RESULTS.length.toLocaleString()} records`;
}

function handlePendingResource(format, recordId) {
  const record = normalizedResourceRecords().find((item) => item.id === recordId);
  if (!record || !record.files?.[format]?.accession) return;
  portalToast(`${format.toUpperCase()} file mapping is ready, but its S3 base URL has not been configured. No download was started.`);
}

function updateResourceCounts() {
  if (!RESOURCE_CATALOG) return;
  const records = normalizedResourceRecords();
  const base = records.filter((record) => !record.extra);
  const gff = records.filter((record) => record.files?.gff?.accession);
  const fa = records.filter((record) => record.files?.fa?.accession);
  document.getElementById("catalog-species-count").textContent = base.length.toLocaleString();
  document.getElementById("resource-count-all").textContent = base.length.toLocaleString();
  document.getElementById("resource-count-gff").textContent = gff.length.toLocaleString();
  document.getElementById("resource-count-fa").textContent = fa.length.toLocaleString();
  ["gff", "fa"].forEach((format) => {
    const configured = Boolean(RESOURCE_CATALOG.storage?.[format]?.baseUrl);
    const status = document.getElementById(`${format}-source-status`);
    status.classList.toggle("ready", configured);
    status.classList.toggle("pending", !configured);
    status.innerHTML = `<i></i>${format.toUpperCase()} ${configured ? "online" : "awaiting S3"}`;
  });
}

function setResourceFilter(filter) {
  RESOURCE_FILTER = filter;
  document.querySelectorAll("[data-resource-filter]").forEach((button) => {
    button.classList.toggle("active", button.dataset.resourceFilter === filter);
  });
  applyResourceFilters();
}

function portalCommandBlock(label, text) {
  const id = `portal-command-${Math.abs(hashStr(label + text)).toString(36)}`;
  return `<div class="bulk-command">
    <div class="bulk-command-head"><span>${portalEscape(label)}</span>
      <button onclick="portalCopyPre('${id}', this)">Copy</button></div>
    <pre id="${id}">${portalEscape(text)}</pre>
  </div>`;
}

function renderSelectionBulk() {
  const content = document.getElementById("bulk-content");
  const files = selectionFiles();
  document.getElementById("bulk-selection-count").textContent = `${files.length.toLocaleString()} files`;
  if (!selectedRegion || !files.length) {
    content.innerHTML = `<div class="bulk-empty">
      <b>No heatmap block selected</b>
      <p>Close this portal, hold Shift, and drag across a heatmap region. The exact directional PAF manifest will be generated here.</p>
      <button onclick="closeDownload()">Return to heatmap</button>
    </div>`;
    return;
  }
  const urls = files.map((file) => S3_HTTPS + file).join("\n");
  const s5Manifest = files.map((file) => `cp ${S3_URI}${file} cmaes/`).join("\n");
  window.PORTAL_SELECTION_URLS = urls;
  window.PORTAL_SELECTION_S5 = s5Manifest;
  const wget = "mkdir -p cmaes && wget -nc -P cmaes/ -i urls.txt";
  const curl = "xargs -P 8 -n 1 curl -sfL --create-dirs -O --output-dir cmaes/ < urls.txt";
  content.innerHTML = `<p class="bulk-summary">The selected block resolves to
      <span class="bulk-number">${files.length.toLocaleString()}</span> directional PAF files.</p>
    <div class="bulk-notice">GenomeArk is public. Commands skip existing files and can be re-run safely as the bucket changes.</div>
    <div class="bulk-grid">
      ${portalCommandBlock("wget · resumable", wget)}
      ${portalCommandBlock("curl · 8 parallel", curl)}
    </div>
    <div class="bulk-buttons">
      <button onclick="downloadText('vgp-selection-urls.txt', window.PORTAL_SELECTION_URLS)">Download URL manifest</button>
      <button onclick="downloadText('vgp-selection.s5cmd.txt', window.PORTAL_SELECTION_S5)">Download s5cmd manifest</button>
    </div>`;
}

function renderFullBulk() {
  const content = document.getElementById("bulk-content");
  const sync = `aws s3 sync --no-sign-request \\\n  ${S3_URI} cmaes/`;
  const s5 = `s5cmd --no-sign-request cp '${S3_URI}*' cmaes/`;
  content.innerHTML = `<p class="bulk-summary">Complete PAF collection:
      <span class="bulk-number">${TOTAL_FILES.toLocaleString()}</span> directional files for 581 genomes.</p>
    <div class="bulk-notice">The complete collection is about 1.5 TB. <b>aws s3 sync</b> is recommended because it is resumable and only fetches missing objects.</div>
    <div class="bulk-grid">
      ${portalCommandBlock("aws s3 sync · recommended", sync)}
      ${portalCommandBlock("s5cmd · fastest", s5)}
    </div>`;
}

function renderResourceBulk() {
  const gffTemplate = RESOURCE_CATALOG?.storage?.gff?.pathTemplate || "{accession}/genomic.gff";
  const faTemplate = RESOURCE_CATALOG?.storage?.fa?.pathTemplate || "{accession}/{accession}.fna.gz";
  document.getElementById("bulk-content").innerHTML = `<div class="future-formats">
    <article class="future-card"><span>GFF</span><h3>Genome annotations</h3>
      <p>508 real GFF files are catalogued. Bulk commands will appear automatically when the S3 base URL is supplied.</p>
      <code>${portalEscape(gffTemplate)}</code></article>
    <article class="future-card"><span>FA</span><h3>Reference sequences</h3>
      <p>Reference-sequence accessions are mapped for all 581 heatmap assemblies. No placeholder URL is generated.</p>
      <code>${portalEscape(faTemplate)}</code></article>
  </div>`;
}

function setBulkScope(scope) {
  BULK_SCOPE = scope;
  ["selection", "full", "resources"].forEach((name) => {
    document.getElementById(`bulk-tab-${name}`).classList.toggle("active", name === scope);
  });
  if (scope === "selection") renderSelectionBulk();
  else if (scope === "full") renderFullBulk();
  else renderResourceBulk();
}

function setDlScope(scope) {
  PORTAL_SCOPE = scope;
  ["pair", "genome", "bulk"].forEach((name) => {
    document.getElementById(`dlt-${name}`).classList.toggle("active", name === scope);
    document.getElementById(`dlp-${name}`).classList.toggle("active", name === scope);
  });
  if (scope === "pair") renderPairResult();
  if (scope === "genome") applyResourceFilters();
  if (scope === "bulk") setBulkScope(BULK_SCOPE);
}

function openDownload(scope) {
  if (portalDataAvailable() && !PORTAL_READY) onHeatmapDataReady();
  if (pinnedPair && PAIR_A === null && PAIR_B === null) {
    setPairPicker("a", pinnedPair.row);
    setPairPicker("b", pinnedPair.col);
  }
  if (selectedRegion && scope === "bulk") BULK_SCOPE = "selection";
  setDlScope(scope || PORTAL_SCOPE || "pair");
  document.getElementById("dl-backdrop").classList.add("open");
  document.body.setAttribute("data-portal-open", "true");
}

function closeDownload() {
  document.getElementById("dl-backdrop").classList.remove("open");
  document.body.removeAttribute("data-portal-open");
}

function portalCopyText(text, button) {
  navigator.clipboard.writeText(text).then(() => {
    const old = button?.textContent;
    if (button) {
      button.textContent = "Copied";
      setTimeout(() => { button.textContent = old; }, 1000);
    }
  }).catch(() => portalToast("Clipboard access was blocked by the browser."));
}

function portalCopyPre(id, button) {
  portalCopyText(document.getElementById(id).textContent, button);
}

function portalToast(message) {
  let toast = document.getElementById("portal-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "portal-toast";
    toast.className = "portal-toast";
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(PORTAL_TOAST_TIMER);
  PORTAL_TOAST_TIMER = setTimeout(() => toast.classList.remove("visible"), 3500);
}

async function loadResourceCatalogue() {
  try {
    const response = await fetch("download_catalog.json");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    RESOURCE_CATALOG = await response.json();
    updateResourceCounts();
    applyResourceFilters();
  } catch (error) {
    document.getElementById("resource-list").style.display = "none";
    const empty = document.getElementById("resource-empty");
    empty.style.display = "flex";
    empty.querySelector("b").textContent = "Catalogue failed to load";
    empty.querySelector("span").textContent = `download_catalog.json: ${error.message}`;
  }
}

function onHeatmapDataReady() {
  if (!portalDataAvailable()) return;
  populatePairPickers();
  PORTAL_READY = true;
  updateResourceCounts();
  applyResourceFilters();
  renderPairResult();
}

function initDownloadPortal() {
  populatePafVersions();
  ["a", "b"].forEach((which) => {
    const input = document.getElementById(`pair-${which}-input`);
    input.addEventListener("change", () => handlePickerInput(which));
    input.addEventListener("blur", () => handlePickerInput(which));
  });
  document.getElementById("resource-search").addEventListener("input", applyResourceFilters);
  document.querySelectorAll("[data-resource-filter]").forEach((button) => {
    button.addEventListener("click", () => setResourceFilter(button.dataset.resourceFilter));
  });
  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      openDownload("genome");
      document.getElementById("resource-search").focus();
    }
  });
  loadResourceCatalogue();
  if (portalDataAvailable()) onHeatmapDataReady();
  else {
    const waitForData = setInterval(() => {
      if (portalDataAvailable()) {
        clearInterval(waitForData);
        onHeatmapDataReady();
      }
    }, 100);
    setTimeout(() => clearInterval(waitForData), 15000);
  }
}

initDownloadPortal();
