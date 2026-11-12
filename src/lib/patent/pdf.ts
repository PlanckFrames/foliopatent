import { normalizePublicationId } from "./text";

export async function extractPdfText(
  file: File,
  onPage?: (done: number, total: number) => void,
): Promise<{ text: string; pages: number; truncated: boolean }> {
  const pdfjs = await import("pdfjs-dist");
  const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const data = new Uint8Array(await file.arrayBuffer());
  const doc = await pdfjs.getDocument({ data }).promise;
  const limit = Math.min(doc.numPages, 50);
  const pages: string[] = [];
  for (let index = 1; index <= limit; index += 1) {
    const page = await doc.getPage(index);
    const content = await page.getTextContent();
    const line = content.items
      .map((item) => ("str" in item ? item.str : ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    pages.push(line);
    onPage?.(index, doc.numPages);
  }
  return { text: pages.join("\n"), pages: doc.numPages, truncated: doc.numPages > limit };
}

export function findPublicationId(text: string): string {
  const window = text.slice(0, 12_000);
  const labeled = window.match(
    /(?:publication|patent)\s*(?:number|no\.?)\s*[:\s]*([A-Z]{2}\s*[0-9][0-9,\s]{4,16}\s*[A-Z]\d?)/i,
  );
  const loose = window.match(/\b(US|EP|WO|CN|JP|KR|GB|DE|FR|CA)\s*([0-9][0-9,\s]{4,16})\s*([A-Z]\d?)\b/);
  const raw = labeled?.[1] ?? (loose ? `${loose[1]}${loose[2]}${loose[3] ?? ""}` : "");
  return raw ? normalizePublicationId(raw) : "";
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
