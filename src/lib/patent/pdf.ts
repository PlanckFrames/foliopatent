import { normalizePublicationId, displayClaimNumber } from "./text";
import { detectScanLanguage } from "./scan";
import type { OfficialRecord, PatentNumber } from "./types";

const TEXT_PAGE_LIMIT = 50;
const SCAN_PAGE_LIMIT = 40;
const SPARSE_CHARS = 40;

type TextItem = { str?: string };

type PdfViewport = { width: number; height: number };

type PdfPage = {
  getTextContent: () => Promise<{ items: TextItem[] }>;
  getViewport: (params: { scale: number }) => PdfViewport;
  render: (params: { canvas: HTMLCanvasElement; viewport: PdfViewport }) => { promise: Promise<void> };
};

type PdfDoc = {
  numPages: number;
  getPage: (index: number) => Promise<PdfPage>;
};

export type PdfExtract = {
  text: string;
  pageTexts: string[];
  pages: number;
  truncated: boolean;
  scanned: boolean;
};

export async function extractPdfText(file: File, onProgress?: (message: string) => void): Promise<PdfExtract> {
  const pdfjs = await import("pdfjs-dist");
  const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const data = new Uint8Array(await file.arrayBuffer());
  const doc = (await pdfjs.getDocument({ data }).promise) as unknown as PdfDoc;
  const textLimit = Math.min(doc.numPages, TEXT_PAGE_LIMIT);
  const pages: string[] = [];
  for (let index = 1; index <= textLimit; index += 1) {
    onProgress?.(`Reading page ${index} of ${textLimit}…`);
    const page = await doc.getPage(index);
    const content = await page.getTextContent();
    pages.push(itemsToLine(content.items));
  }
  const sparse = pages.filter((line) => line.length < SPARSE_CHARS).length;
  const scanned = pages.length > 0 && sparse / pages.length >= 0.6;
  if (!scanned) {
    return {
      text: pages.join("\n"),
      pageTexts: keepPages(pages),
      pages: doc.numPages,
      truncated: doc.numPages > textLimit,
      scanned: false,
    };
  }
  if (typeof document === "undefined") {
    throw new Error("A scanned PDF can only be read in the browser.");
  }
  const scanLimit = Math.min(doc.numPages, SCAN_PAGE_LIMIT);
  const scannedPages = await readScan(doc, scanLimit, onProgress);
  const text = scannedPages.join("\n\n");
  if (!text.trim()) {
    throw new Error("This scan could not be read. Type the publication number, or upload a clearer PDF.");
  }
  return {
    text,
    pageTexts: keepPages(scannedPages),
    pages: doc.numPages,
    truncated: doc.numPages > scanLimit,
    scanned: true,
  };
}

function itemsToLine(items: TextItem[]): string {
  return items
    .map((item) => item.str ?? "")
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function keepPages(pages: string[]): string[] {
  return pages.map((page) => page.replace(/\s+/g, " ").trim()).filter((page) => page.length >= 80);
}

async function readScan(doc: PdfDoc, pageCount: number, onProgress?: (message: string) => void): Promise<string[]> {
  onProgress?.("Checking which language the scan is in…");
  const first = await renderPage(doc, 1);
  let pack = "eng";
  try {
    const { createWorker } = await import("tesseract.js");
    const osd = await createWorker("osd", 1, { legacyCore: true, legacyLang: true });
    try {
      const found = await osd.detect(first);
      pack = langsForScript(found.data?.script ?? null);
    } finally {
      await osd.terminate().catch(() => undefined);
    }
  } catch {
    pack = "eng";
  }

  onProgress?.(pack === "eng" ? "Preparing the on-device reader…" : `Preparing the ${packLabel(pack)} reader…`);
  let worker: OcrWorker;
  try {
    worker = await openReader(pack, onProgress);
  } catch {
    if (pack === "eng") {
      first.width = 0;
      first.height = 0;
      throw new Error("The on-device reader could not download. Check the connection once, then try the scan again. The PDF is not uploaded.");
    }
    try {
      pack = "eng";
      onProgress?.("Preparing the on-device reader…");
      worker = await openReader("eng", onProgress);
    } catch {
      first.width = 0;
      first.height = 0;
      throw new Error("The on-device reader could not download. Check the connection once, then try the scan again. The PDF is not uploaded.");
    }
  }

  const lines: string[] = [];
  try {
    if (pack === "eng") {
      const firstText = cleanOcr((await worker.recognize(first)).data.text ?? "");
      const latin = detectScanLanguage(firstText);
      if (latin) {
        onProgress?.(`Switching the reader to ${latin.label}…`);
        try {
          await worker.reinitialize(`eng+${latin.tess}`);
          lines.push(cleanOcr((await worker.recognize(first)).data.text ?? ""));
        } catch {
          lines.push(firstText);
        }
      } else {
        lines.push(firstText);
      }
    }
    const start = lines.length > 0 ? 2 : 1;
    for (let index = start; index <= pageCount; index += 1) {
      onProgress?.(`Reading the scan, page ${index} of ${pageCount}…`);
      const canvas = index === 1 ? first : await renderPage(doc, index);
      try {
        const result = await worker.recognize(canvas);
        lines.push(cleanOcr(result.data.text ?? ""));
      } catch {
        lines.push("");
      }
      if (canvas !== first) {
        canvas.width = 0;
        canvas.height = 0;
      }
    }
  } finally {
    first.width = 0;
    first.height = 0;
    await worker.terminate().catch(() => undefined);
  }
  return lines;
}

type OcrWorker = {
  recognize: (image: HTMLCanvasElement) => Promise<{ data: { text?: string } }>;
  reinitialize: (langs: string) => Promise<unknown>;
  terminate: () => Promise<unknown>;
};

async function openReader(langs: string, onProgress?: (message: string) => void): Promise<OcrWorker> {
  const { createWorker } = await import("tesseract.js");
  return createWorker(langs, 1, {
    logger(message) {
      if ((message.status ?? "").startsWith("loading")) {
        onProgress?.(langs === "eng" ? "Preparing the on-device reader…" : `Preparing the ${packLabel(langs)} reader…`);
      }
    },
  });
}

function packLabel(pack: string): string {
  const labels: Record<string, string> = {
    "rus+bul+eng": "Cyrillic",
    "ell+eng": "Greek",
    "ara+eng": "Arabic",
    "heb+eng": "Hebrew",
    "tha+eng": "Thai",
    "kor+eng": "Korean",
    "jpn+eng": "Japanese",
    "chi_sim+chi_tra+eng": "Chinese",
    "hin+eng": "Hindi",
    "khm+eng": "Khmer",
  };
  return labels[pack] ?? "on-device";
}

function langsForScript(script: string | null): string {
  const name = (script ?? "").toLowerCase();
  if (!name || name.includes("latin") || name === "common") return "eng";
  if (name.includes("cyrillic")) return "rus+bul+eng";
  if (name.includes("greek")) return "ell+eng";
  if (name.includes("arabic")) return "ara+eng";
  if (name.includes("hebrew")) return "heb+eng";
  if (name.includes("thai")) return "tha+eng";
  if (name.includes("hangul") || name.includes("korean")) return "kor+eng";
  if (name.includes("hiragana") || name.includes("katakana") || name.includes("japanese")) return "jpn+eng";
  if (name.includes("han") || name.includes("chinese")) return "chi_sim+chi_tra+eng";
  if (name.includes("devanagari")) return "hin+eng";
  if (name.includes("khmer")) return "khm+eng";
  return "eng";
}

async function renderPage(doc: PdfDoc, index: number): Promise<HTMLCanvasElement> {
  const page = await doc.getPage(index);
  const scale = canvasScale(page);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  await page.render({ canvas, viewport }).promise;
  return canvas;
}

function canvasScale(page: PdfPage): number {
  const base = page.getViewport({ scale: 1 });
  const longEdge = Math.max(base.width, base.height);
  if (longEdge <= 0) return 1.8;
  return Math.min(2.2, Math.max(1.35, 1700 / longEdge));
}

function cleanOcr(value: string): string {
  return value
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const OFFICES = "US|EP|WO|CN|JP|KR|GB|DE|FR|CA|AU|IN";

export function findPublicationId(text: string): string {
  const source = text.slice(0, 20_000).toUpperCase();
  const translated = source.match(/\bDK\s*[/\\]?\s*EP\s*([0-9][0-9\s.,]{4,18})/);
  if (translated?.[1]) {
    const id = cleanPublicationId(`EP${translated[1]}`);
    if (id) return id;
  }
  const labeled = source.match(
    new RegExp(`(?:PATENT|PUBLICATION)\\s*(?:NUMBER|NO\\.?)\\s*[:\\s]*((?:${OFFICES})\\s*[0-9][0-9\\s.,]{4,20}(?:\\s*[A-Z]\\d?)?)`),
  );
  if (labeled?.[1]) {
    const id = cleanPublicationId(labeled[1]);
    if (id) return id;
  }
  const header = source.slice(0, 2_500);
  const compact = header.match(new RegExp(`\\b(${OFFICES})\\s*([0-9][0-9\\s.,]{5,18})\\s*([A-Z]\\d?)\\b`));
  if (compact) {
    const id = cleanPublicationId(`${compact[1]}${compact[2]}${compact[3]}`);
    if (id) return id;
  }
  const bare = header.match(new RegExp(`\\b(${OFFICES})([0-9]{6,12})([A-Z]\\d?)?\\b`));
  if (bare) return cleanPublicationId(`${bare[1]}${bare[2]}${bare[3] ?? ""}`);
  return "";
}

function cleanPublicationId(raw: string): string {
  const id = normalizePublicationId(raw);
  const match = id.match(/^([A-Z]{2})(\d{4,14})([A-Z]\d?)?$/);
  if (!match) return "";
  const office = match[1] ?? "";
  const number = (match[2] ?? "").replace(/^0+(?=\d{6,})/, "");
  const kind = match[3] ?? "";
  if (!number) return "";
  if (/^T\d?$/.test(kind)) return `${office}${number}`;
  return `${office}${number}${kind}`;
}

const ROLE_LABELS: [string, "Applicant" | "Inventor" | "Assignee"][] = [
  ["patent owner", "Assignee"],
  ["patentinhaber", "Assignee"],
  ["patenthaver", "Assignee"],
  ["octrooihouder", "Assignee"],
  ["proprietor", "Assignee"],
  ["titulaire", "Assignee"],
  ["titolare", "Assignee"],
  ["innehavare", "Assignee"],
  ["assignee", "Assignee"],
  ["houder", "Assignee"],
  ["titular", "Assignee"],
  ["applicant", "Applicant"],
  ["anmelder", "Applicant"],
  ["aanvrager", "Applicant"],
  ["demandeur", "Applicant"],
  ["ansøger", "Applicant"],
  ["ansoeger", "Applicant"],
  ["ansoger", "Applicant"],
  ["richiedente", "Applicant"],
  ["solicitante", "Applicant"],
  ["sökande", "Applicant"],
  ["sokande", "Applicant"],
  ["inventeur", "Inventor"],
  ["inventore", "Inventor"],
  ["inventor", "Inventor"],
  ["opfinder", "Inventor"],
  ["erfinder", "Inventor"],
  ["uitvinder", "Inventor"],
  ["uppfinnare", "Inventor"],
  ["wynalazca", "Inventor"],
];

export type FaceParty = { role: "Applicant" | "Inventor" | "Assignee"; name: string; note: string };

export function partiesFromText(text: string): FaceParty[] {
  const flat = text.slice(0, 4500).replace(/\s+/g, " ");
  const labels = [...ROLE_LABELS].sort((a, b) => b[0].length - a[0].length);
  const alt = labels.map(([label]) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const re = new RegExp(
    `(?:\\((\\d{1,2})\\)\\s*)?\\b(${alt})\\b\\s*([:\\-])\\s*(.+?)(?=\\s*(?:\\(\\d{1,2}\\)\\s*)?\\b(?:${alt})\\b\\s*[:\\-]|\\(\\d{1,2}\\)|$)`,
    "gi",
  );
  const found: FaceParty[] = [];
  const seen = new Set<string>();
  for (const match of flat.matchAll(re)) {
    const label = (match[2] ?? "").toLowerCase();
    const role = labels.find(([name]) => name === label)?.[1];
    if (!role) continue;
    for (const name of namesFromBlob(match[4] ?? "")) {
      const key = `${role}|${name.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ role, name, note: "" });
    }
  }
  return found;
}

function namesFromBlob(blob: string): string[] {
  const cut = (blob.split(/\s+\(\d{1,2}\)\s*/)[0] ?? blob).trim();
  const pieces = cut.split(/\s+(?=(?:[A-Z]{2,}|[A-Z]'[A-Z]{2,}),\s+[A-Z])/);
  return pieces.map(cleanPartyName).filter((name) => name.length > 2);
}

function cleanPartyName(raw: string): string {
  let name = raw.replace(/\s+/g, " ").replace(/\.{2,}/g, ".").replace(/^[,:;\-\s]+/, "").trim();
  name = (name.split(/\b(?:Road|Drive|Court|Suite|Street|Avenue|Boulevard|Lane|Floor|Way)\b/i)[0] ?? name).trim();
  const surname = name.match(/^((?:[A-Z]{2,}|[A-Z]'[A-Z]{2,}),\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+|\s+[A-Z]\.?){0,3})/);
  if (surname?.[1]) return surname[1].replace(/[,\s]+$/, "");
  const org = name.match(/^(.+\b(?:Inc\.?|Incorporated|LLC|L\.L\.C\.|Ltd\.?|Limited|GmbH|Corp\.?|Corporation|Company|S\.A\.|AG|N\.V\.|B\.V\.|PLC))\b/i);
  if (org?.[1]) return org[1].replace(/[,\s]+$/, "");
  name = name.replace(/,?\s+\d[\d\s-]*$/, "");
  name = name.replace(/,\s*[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*,\s*[A-Z]{2}\b.*$/, "");
  name = name.replace(/,\s*[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}\s*$/, "");
  return name.replace(/[,\s]+$/, "").replace(/\s+/g, " ").trim();
}

export function collectParties(record: OfficialRecord | null, pdfText: string): Record<FaceParty["role"], FaceParty[]> {
  const buckets: Record<FaceParty["role"], FaceParty[]> = { Applicant: [], Inventor: [], Assignee: [] };
  const seen = new Set<string>();
  const add = (role: FaceParty["role"], name: string, note: string) => {
    const clean = name.replace(/\s+/g, " ").trim();
    if (clean.length < 2) return;
    const key = `${role}|${clean.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    buckets[role].push({ role, name: clean, note });
  };
  for (const party of partiesFromText(pdfText)) add(party.role, party.name, "");
  if (record) {
    for (const name of record.inventors) add("Inventor", name, "");
    for (const party of record.assignees) {
      if (/applicant/i.test(party.role)) add("Applicant", party.name, "");
      else add("Assignee", party.name, party.role === "Assignee" ? "" : party.role);
    }
  }
  return buckets;
}

export function inventorColumns(parties: FaceParty[]): { printed: string; translated: string }[] {
  const rows = new Map<string, { printed: string; translated: string; printedScore: number }>();
  for (const party of parties) {
    const key = personKey(party.name);
    if (!key) continue;
    const printedScore = printedScoreOf(party.name);
    const translated = readingOrderName(party.name);
    const current = rows.get(key);
    if (!current) {
      rows.set(key, { printed: party.name, translated, printedScore });
      continue;
    }
    if (printedScore > current.printedScore) {
      current.printed = party.name;
      current.printedScore = printedScore;
    }
    if (translated.length > current.translated.length) current.translated = translated;
  }
  return [...rows.values()].map(({ printed, translated }) => ({ printed, translated }));
}

function personKey(name: string): string {
  const comma = name.match(/^([^,]+),\s*(.+)$/);
  const surname = comma ? comma[1] : (name.trim().split(/\s+/).pop() ?? "");
  const given = comma ? comma[2] : name.trim().split(/\s+/).slice(0, -1).join(" ");
  const fold = (value: string) =>
    value
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z]/g, "");
  const surnameKey = fold(surname);
  if (surnameKey.length < 2) return "";
  return `${surnameKey}|${fold(given)}`;
}

function printedScoreOf(name: string): number {
  let score = 0;
  if (name.includes(",")) score += 2;
  if (/[A-Z]{3,}/.test(name)) score += 1;
  return score;
}

function readingOrderName(name: string): string {
  const comma = name.match(/^([^,]+),\s*(.+)$/);
  if (!comma) return titlePerson(name);
  return `${titlePerson(comma[2] ?? "")} ${titlePerson(comma[1] ?? "")}`.replace(/\s+/g, " ").trim();
}

function titlePerson(value: string): string {
  return value
    .toLowerCase()
    .replace(/(^|[^a-z])([a-z])/g, (_, separator: string, letter: string) => `${separator}${letter.toUpperCase()}`)
    .replace(/\s+/g, " ")
    .trim();
}

export function numbersFromText(text: string): PatentNumber[] {
  const head = text.slice(0, 12_000);
  const flat = head.replace(/\s+/g, " ");
  const found: PatentNumber[] = [];
  const add = (label: string, value: string) => {
    const clean = value.replace(/\s+/g, " ").replace(/^[\s,:;-]+|[\s,:;-]+$/g, "").trim();
    if (clean.length < 4 || clean.length > 40) return;
    const key = `${label}|${clean.replace(/[^A-Za-z0-9]/g, "").toUpperCase()}`;
    if (found.some((item) => `${item.label}|${item.value.replace(/[^A-Za-z0-9]/g, "").toUpperCase()}` === key)) return;
    found.push({ label, value: clean });
  };
  const publication = findPublicationId(head);
  if (publication) add("Publication", publication);
  const labeled: [string, RegExp][] = [
    ["Publication", /\(\s*(?:10|11)\s*\)\s*((?:US|EP|WO|CN|JP|KR|GB|DE|FR|CA|AU|IN|DK)\s*[\d\s./,]{4,22}(?:\s*[A-Z]\d?)?)/i],
    ["Application", /\(\s*21\s*\)\s*([A-Z]{0,2}\s*\d[\d\s./,]{3,22})/i],
    ["Application", /\bapplication\s*(?:number|no\.?)\s*[:\s]\s*([A-Z]{0,2}\s*\d[\d\s./,]{3,22})/i],
    ["PCT application", /\(\s*86\s*\)\s*(PCT\s*\/\s*[A-Z]{2}\s*\d{2,4}\s*\/\s*\d{3,8})/i],
    ["PCT publication", /\(\s*87\s*\)\s*(WO\s*\d{2,4}\s*\/?\s*\d{4,8}(?:\s*[A-Z]\d?)?)/i],
    ["Priority", /\(\s*30\s*\)\s*([A-Z]{2}[\s,]+\d[\d\s./,]{3,24})/i],
    ["Priority", /\(\s*31\s*\)\s*([A-Z0-9][\d\s./,]{4,24})/i],
  ];
  for (const [label, pattern] of labeled) {
    const match = flat.match(pattern);
    if (match?.[1]) add(label, label.startsWith("PCT") ? match[1].replace(/\s+/g, "") : match[1]);
  }
  for (const match of flat.matchAll(/\b(PCT\/[A-Z]{2}\d{2,4}\/\d{3,8})\b/gi)) add("PCT application", match[1] ?? "");
  for (const match of flat.matchAll(/\b(WO\d{4}\/?\d{5,7}[A-Z]\d?)\b/gi)) add("PCT publication", match[1] ?? "");
  return found;
}

export function collectNumbers(record: OfficialRecord | null, pdfText: string): PatentNumber[] {
  const found: PatentNumber[] = [];
  const seen = new Set<string>();
  const add = (label: string, value: string) => {
    const clean = value.replace(/\s+/g, " ").trim();
    const key = `${label}|${clean.replace(/[^A-Za-z0-9]/g, "").toUpperCase()}`;
    if (clean.length < 4 || seen.has(key)) return;
    seen.add(key);
    found.push({ label, value: clean });
  };
  if (record?.id) add("Publication", record.id);
  for (const item of record?.numbers ?? []) add(item.label, item.value);
  for (const item of numbersFromText(pdfText)) add(item.label, item.value);
  const rank: Record<string, number> = {
    Publication: 0,
    Application: 1,
    "Other publication": 2,
    "PCT application": 3,
    "PCT publication": 4,
    Priority: 5,
  };
  return found.sort((a, b) => (rank[a.label] ?? 9) - (rank[b.label] ?? 9)).slice(0, 12);
}

export type PdfBiblio = {
  abstract: string;
  background: string;
  claims: { number: string; text: string }[];
};

export function titleFromPdf(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const marked = flat.match(
    /\(\s*54\s*\)\s*(.{8,220}?)(?=\(\s*\d{2}\s*\)|\b(?:abstract|sammendrag|opfinder|inventor|applicant|ansøger|ansoeger)\b)/i,
  );
  return marked?.[1]?.replace(/\s+/g, " ").trim() ?? "";
}

export function biblioFromPdf(text: string): PdfBiblio {
  const flat = text.replace(/\s+/g, " ");
  const claimZone = claimZoneFrom(flat).slice(0, 80_000);
  const claims: { number: string; text: string }[] = [];
  const claimRe = /(?:\[(\d{1,5})\]|(?:^|\s)(\d{1,4})\.)\s+(.*?)(?=(?:\s\[\d{1,5}\]|\s\d{1,4}\.)\s|$)/g;
  for (const match of claimZone.matchAll(claimRe)) {
    const body = (match[3] ?? "").trim();
    if (body.length < 30) continue;
    claims.push({
      number: displayClaimNumber(match[1] || match[2] || String(claims.length + 1)),
      text: body.slice(0, 2200),
    });
    if (claims.length >= 40) break;
  }
  return {
    abstract: pullAbstract(flat),
    background: pullBackground(flat),
    claims,
  };
}

function claimZoneFrom(flat: string): string {
  const markers = [
    ...flat.matchAll(
      /\b(what is claimed is|patentkrav|revendications|patentanspr[uü]che|reivindicaciones|rivendicazioni|权利要求|特許請求の範囲|청구항)\b/gi,
    ),
  ];
  const claims = markers.length > 0 ? markers : [...flat.matchAll(/\bclaims\b/gi)];
  const last = claims[claims.length - 1];
  if (!last || last.index == null) return "";
  return flat.slice(last.index + last[0].length);
}

function pullAbstract(flat: string): string {
  const match = flat.match(
    /\b(?:abstract|sammendrag|zusammenfassung|abr[eé]g[eé]|resumen|riassunto|sammanfattning|sammandrag)\b[:\s]{0,8}(.{40,4500}?)(?=\b(?:claims|background|field of the invention|description|technical field|patentkrav|revendications|patentanspr|reivindicaciones|what is claimed)\b)/i,
  );
  return (match?.[1] ?? "").replace(/\s+/g, " ").trim();
}

function pullBackground(flat: string): string {
  const descAt = flat.search(/\bdescription\b/i);
  const region = descAt >= 0 ? flat.slice(descAt, descAt + 14_000) : flat.slice(0, 14_000);
  const start = region.search(/\bbackground(?:\s+of\s+the\s+(?:invention|disclosure))?\b/i);
  if (start < 0) return "";
  const after = region.slice(start).replace(/^background(?:\s+of\s+the\s+(?:invention|disclosure))?/i, "").trim();
  const stop = after.search(
    /\b(?:summary(?:\s+of\s+the\s+(?:invention|disclosure))?|brief description|detailed description|description of (?:the )?(?:drawings|figures|embodiments)|objects of the invention)\b/i,
  );
  const body = (stop > 120 ? after.slice(0, stop) : after.slice(0, 3200)).replace(/\s+/g, " ").trim();
  const cleaned = body.replace(/^(?:\[\d{3,5}\]\s*)+/, "").trim();
  if (cleaned.length < 80) return "";
  return cleaned.slice(0, 3500);
}
