import { normalizePublicationId } from "./text";

const TEXT_PAGE_LIMIT = 50;
const SCAN_PAGE_LIMIT = 24;
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

async function readScan(doc: PdfDoc, pageCount: number, onProgress?: (message: string) => void): Promise<string[]> {
  onProgress?.("Preparing the on-device reader…");
  let worker: Awaited<ReturnType<typeof import("tesseract.js").createWorker>>;
  try {
    const { createWorker } = await import("tesseract.js");
    worker = await createWorker("eng", 1, {
      logger(message) {
        if ((message.status ?? "").startsWith("loading")) onProgress?.("Preparing the on-device reader…");
      },
    });
  } catch {
    throw new Error("The on-device reader could not download. Check the connection once, then try the scan again. The PDF is not uploaded.");
  }
  const lines: string[] = [];
  try {
    for (let index = 1; index <= pageCount; index += 1) {
      onProgress?.(`Reading the scan, page ${index} of ${pageCount}…`);
      try {
        const page = await doc.getPage(index);
        const scale = canvasScale(page);
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement("canvas");
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        await page.render({ canvas, viewport }).promise;
        const result = await worker.recognize(canvas);
        canvas.width = 0;
        canvas.height = 0;
        lines.push(cleanOcr(result.data.text ?? ""));
      } catch {
        lines.push("");
      }
    }
  } finally {
    await worker.terminate().catch(() => undefined);
  }
  return lines;
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

export function biblioFromPdf(text: string): { abstract: string; claims: string[] } {
  const flat = text.replace(/\s+/g, " ");
  const abstractMatch = flat.match(/\babstract\b(.{40,1800}?)(?=\b(claims|background|field of the invention|description|technical field)\b)/i);
  const claimZone = flat.split(/\bwhat is claimed is\b|\bclaims\b/i)[1] ?? "";
  const claims: string[] = [];
  for (const match of claimZone.matchAll(/(?:^|\s)(\d{1,3})\.\s+(.*?)(?=(?:\s\d{1,3}\.\s)|$)/g)) {
    const body = (match[2] ?? "").trim();
    if (body.length < 40) continue;
    const independent = !/\b(of|to|in|according to)\s+claims?\s+\d+/i.test(body);
    if (independent || claims.length < 2) claims.push(body.slice(0, 900));
    if (claims.filter(Boolean).length >= 4) break;
  }
  return { abstract: (abstractMatch?.[1] ?? "").trim(), claims };
}
