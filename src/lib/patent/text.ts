const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeOnce(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]+);/g, (entity, body: string) => {
    if (body[0] === "#") {
      const hex = body[1] === "x" || body[1] === "X";
      const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : entity;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? entity;
  });
}

export function decodeEntities(value: string): string {
  let out = decodeOnce(value);
  if (out.includes("&")) out = decodeOnce(out);
  return out.replace(/\s+/g, " ").trim();
}

export function stripTags(value: string): string {
  return decodeEntities(value.replace(/<[^>]+>/g, " "));
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normalizePublicationId(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function publicationCandidates(raw: string): string[] {
  const id = normalizePublicationId(raw);
  const match = id.match(/^([A-Z]{2})(\d{4,14})([A-Z]\d?)?$/);
  if (!match) return id.length >= 6 ? [id] : [];
  const [, office, number, kind] = match;
  const kinds = ["B2", "B1", "A1", "A2", "A9", "A", "B", "C1", "C2", "C"];
  const ordered: string[] = [];
  const push = (value: string) => {
    if (!ordered.includes(value)) ordered.push(value);
  };
  if (kind) push(`${office}${number}${kind}`);
  for (const code of kinds) push(`${office}${number}${code}`);
  push(`${office}${number}`);
  return ordered.slice(0, 8);
}

export function officeFromId(id: string): { code: string; name: string } {
  const code = id.slice(0, 2);
  const names: Record<string, string> = {
    US: "United States",
    EP: "European Patent Office",
    WO: "WIPO (PCT)",
    CN: "China",
    JP: "Japan",
    KR: "Korea",
    GB: "United Kingdom",
    DE: "Germany",
    FR: "France",
    CA: "Canada",
    AU: "Australia",
    IN: "India",
  };
  return { code, name: names[code] ?? code };
}

export function foreignLetters(text: string): number {
  return text.match(/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\u0600-\u06ff\u0590-\u05ff\u0e00-\u0e7f\u0400-\u04ff\u0370-\u03ff]/g)?.length ?? 0;
}

export function patentUrl(id: string): string {
  return `https://patents.google.com/patent/${encodeURIComponent(id.replace(/\s+/g, ""))}/en`;
}

export function documentHref(value: string): string {
  const clean = value.trim();
  const compact = clean.replace(/\s+/g, "");
  const publication = compact.match(/^([A-Z]{2}\d{5,})([A-Z]\d?)$/i);
  if (publication?.[1] && publication[2]) return patentUrl(`${publication[1]}${publication[2]}`.toUpperCase());
  const application = compact.match(/^([A-Z]{2})(\d{6,})\.\d+([A-Z]\d?)?$/i);
  if (application?.[1] && application[2]) return patentUrl(`${application[1]}${application[2]}${application[3] ?? ""}`.toUpperCase());
  return `https://patents.google.com/?q=${encodeURIComponent(clean)}`;
}

export function wikiUrl(title: string): string {
  const slug = title.trim().replace(/\s+/g, "_");
  return `https://en.wikipedia.org/wiki/${encodeURIComponent(slug)}`;
}

export function grokUrl(title: string): string {
  const slug = title.trim().replace(/\s+/g, "_");
  return `https://grokipedia.com/page/${encodeURIComponent(slug)}`;
}

export function wikiSearch(query: string): string {
  return `https://en.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(query)}`;
}

export function firstSentences(text: string, count: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return "";
  const parts = clean.split(/(?<=[.!?])\s+/).filter(Boolean);
  return parts.slice(0, count).join(" ");
}

export function chunkProse(text: string, size: number, max: number): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const out: string[] = [];
  for (let index = 0; index < clean.length && out.length < max; index += size) {
    const slice = clean.slice(index, index + size).trim();
    if (slice.length >= 80) out.push(slice);
  }
  return out;
}

export type ReadingPage = { page: number; text: string; example: boolean };

const EXAMPLE_ASIDE =
  /\b(?:for\s+example|par\s+exemple|zum\s+beispiel|beispielsweise|por\s+ejemplo|por\s+exemplo|ad\s+esempio|bijvoorbeeld|för\s+exempel|for\s+eksempel|e\.g\.)\b|例如/gi;

function withoutAsides(text: string): string {
  EXAMPLE_ASIDE.lastIndex = 0;
  return text.replace(EXAMPLE_ASIDE, " ");
}

const EXAMPLE_MARK =
  /(?:^|[^\p{L}])(?:EXAMPLES?|EXPERIMENTAL(?:\s+SECTION)?|BEISPIELE|EXEMPLES|EJEMPLOS|ESEMPI|EXEMPLOS|VOORBEELDEN|EKSEMPLER)\b|\b(?:Example|Beispiel|Exemple|Ejemplo|Esempio|Exemplo|Voorbeeld|Eksempel|Exempel|Пример)\s+\d{1,3}\b|\bexperimental\s+(?:section|examples?|procedures?|part|data)\b|実施例|実験例|实施例|实验例|실시예|실험예/u;

export function isExamplePage(text: string): boolean {
  return EXAMPLE_MARK.test(withoutAsides(text));
}

const CLAIM_HEAD = /(?:what is claimed is|patentkrav|revendications|patentanspr[uü]che|reivindicaciones|rivendicazioni|权利要求|特許請求|청구항|\bclaims\b)/i;

export function selectReadingPages(pages: string[]): { pages: ReadingPage[]; examplesTruncated: boolean } {
  const tagged = pages.map((text, index) => ({ page: index + 1, text, example: isExamplePage(text) }));
  const firstExample = tagged.findIndex((page) => page.example);
  if (firstExample < 0) return { pages: tagged.slice(0, 24), examplesTruncated: false };
  const opening = tagged.slice(0, Math.min(6, firstExample)).map((page) => ({ ...page, example: false }));
  const bridge = tagged.slice(Math.max(opening.length, firstExample - 4), firstExample).map((page) => ({ ...page, example: false }));
  const exampleRun: ReadingPage[] = [];
  let truncated = false;
  for (const page of tagged.slice(firstExample)) {
    if (exampleRun.length > 0 && CLAIM_HEAD.test(page.text.slice(0, 500)) && !isExamplePage(page.text)) break;
    if (exampleRun.length >= 24) {
      truncated = true;
      break;
    }
    exampleRun.push({ ...page, example: true });
  }
  return { pages: [...opening, ...bridge, ...exampleRun], examplesTruncated: truncated };
}

function exampleIndex(flat: string): number {
  const re = new RegExp(EXAMPLE_MARK.source, "gu");
  let match: RegExpExecArray | null;
  while ((match = re.exec(flat))) {
    const prior = flat.slice(Math.max(0, match.index - 18), match.index).toLowerCase();
    if (/(?:for|par|zum|por|ad|bij)\s*$/.test(prior)) continue;
    return match.index;
  }
  return -1;
}

export function readingChunksFromExcerpt(excerpt: string): { pages: ReadingPage[]; examplesTruncated: boolean } {
  const flat = excerpt.replace(/\s+/g, " ").trim();
  if (flat.length < 80) return { pages: [], examplesTruncated: false };
  const at = exampleIndex(flat);
  if (at < 0) {
    return {
      pages: chunkProse(flat.slice(0, 36_000), 4500, 8).map((text, index) => ({ page: index + 1, text, example: false })),
      examplesTruncated: false,
    };
  }
  const head = chunkProse(flat.slice(0, Math.min(at, 14_000)), 4500, 4).map((text, index) => ({
    page: index + 1,
    text,
    example: false,
  }));
  const rest = flat.slice(at);
  const stop = rest.search(/\b(?:what is claimed is|claims|patentkrav|revendications)\b/i);
  const exampleText = stop > 500 ? rest.slice(0, stop) : rest.slice(0, 72_000);
  const examplesTruncated = exampleText.length < rest.length && (stop < 0 || stop > exampleText.length);
  const examples = chunkProse(exampleText, 4500, 16).map((text, index) => ({
    page: head.length + index + 1,
    text,
    example: true,
  }));
  return { pages: [...head, ...examples], examplesTruncated };
}

export function samePassage(left: string, right: string): boolean {
  const a = passageKey(left);
  const b = passageKey(right);
  if (!a || !b) return false;
  if (a === b) return true;
  const shorter = a.length < b.length ? a : b;
  const longer = a.length < b.length ? b : a;
  if (longer.includes(shorter) && shorter.length / longer.length > 0.62) return true;
  const leftWords = passageWords(a);
  const rightWords = passageWords(b);
  if (leftWords.length < 12 || rightWords.length < 12) return false;
  const leftSet = new Set(leftWords);
  const shared = rightWords.filter((word) => leftSet.has(word)).length;
  return shared / rightWords.length > 0.78 && shared / leftWords.length > 0.78;
}

function passageKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function passageWords(value: string): string[] {
  return value.split(" ").filter((word) => word.length > 3);
}

export function displayClaimNumber(value: string): string {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const number = Number.parseInt(trimmed, 10);
    if (Number.isFinite(number)) return String(number);
  }
  return trimmed;
}

export function plainClaimBullets(text: string): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const dependent = /\baccording to (?:any preceding claim|claim\s+\d+)/i.test(clean);
  const parts = clean
    .split(/\b(?:characterized in that|further wherein|and further wherein|wherein)\b/i)
    .map((part) => softenClaim(part))
    .filter((part) => part.length > 20);
  const bullets: string[] = [];
  if (dependent) bullets.push("Adds a further requirement to an earlier claim.");
  else if (/^\s*a method\b/i.test(clean)) bullets.push("Covers a way of doing something.");
  else if (/^\s*an? (?:system|device|apparatus|injection device)\b/i.test(clean)) bullets.push("Covers a device.");
  else if (/\bcomposition\b/i.test(clean)) bullets.push("Covers a mixture or formulation.");
  else if (/\bfor use\b/i.test(clean)) bullets.push("Covers a use of the invention.");
  else bullets.push("States what this claim protects.");
  for (const part of parts.slice(dependent ? 0 : 1)) {
    if (bullets.length >= 3) break;
    const sentence = part.charAt(0).toUpperCase() + part.slice(1);
    if (bullets.some((item) => item.toLowerCase() === sentence.toLowerCase())) continue;
    bullets.push(sentence.endsWith(".") ? sentence : `${sentence}.`);
  }
  if (bullets.length === 1 && parts[0]) {
    const lead = parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
    bullets.push(lead.endsWith(".") ? lead : `${lead}.`);
  }
  return bullets.slice(0, 3);
}

function softenClaim(value: string): string {
  return value
    .replace(/\bcomprising\b/gi, "including")
    .replace(/\bconsisting of\b/gi, "made of")
    .replace(/\baccording to (?:any preceding claim|claim\s+\d+)\b/gi, "")
    .replace(/\bfor use\b/gi, "used")
    .replace(/\bsaid\b/gi, "the")
    .replace(/\bthereof\b/gi, "")
    .replace(/^[\s,;:.-]+|[\s,;:.-]+$/g, "")
    .replace(/\s+\band$/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

const FILING_PLACES: Record<string, { country: string; office: string }> = {
  US: { country: "United States", office: "United States Patent and Trademark Office" },
  EP: { country: "Europe", office: "European Patent Office" },
  WO: { country: "International (PCT)", office: "World Intellectual Property Organization" },
  DK: { country: "Denmark", office: "Danish Patent and Trademark Office" },
  CN: { country: "China", office: "China National Intellectual Property Administration" },
  JP: { country: "Japan", office: "Japan Patent Office" },
  KR: { country: "South Korea", office: "Korean Intellectual Property Office" },
  GB: { country: "United Kingdom", office: "UK Intellectual Property Office" },
  DE: { country: "Germany", office: "German Patent and Trade Mark Office" },
  FR: { country: "France", office: "National Institute of Industrial Property" },
  CA: { country: "Canada", office: "Canadian Intellectual Property Office" },
  AU: { country: "Australia", office: "IP Australia" },
  IN: { country: "India", office: "Indian Patent Office" },
  AT: { country: "Austria", office: "Austrian Patent Office" },
  BE: { country: "Belgium", office: "Belgian Office for Intellectual Property" },
  BR: { country: "Brazil", office: "National Institute of Industrial Property" },
  CH: { country: "Switzerland", office: "Swiss Federal Institute of Intellectual Property" },
  CZ: { country: "Czechia", office: "Industrial Property Office" },
  ES: { country: "Spain", office: "Spanish Patent and Trademark Office" },
  FI: { country: "Finland", office: "Finnish Patent and Registration Office" },
  HU: { country: "Hungary", office: "Hungarian Intellectual Property Office" },
  IE: { country: "Ireland", office: "Intellectual Property Office of Ireland" },
  IL: { country: "Israel", office: "Israel Patent Office" },
  IT: { country: "Italy", office: "Italian Patent and Trademark Office" },
  MX: { country: "Mexico", office: "Mexican Institute of Industrial Property" },
  NL: { country: "Netherlands", office: "Netherlands Patent Office" },
  NO: { country: "Norway", office: "Norwegian Industrial Property Office" },
  NZ: { country: "New Zealand", office: "Intellectual Property Office of New Zealand" },
  PL: { country: "Poland", office: "Patent Office of the Republic of Poland" },
  PT: { country: "Portugal", office: "Portuguese Institute of Industrial Property" },
  RU: { country: "Russia", office: "Federal Service for Intellectual Property" },
  SE: { country: "Sweden", office: "Swedish Intellectual Property Office" },
  SG: { country: "Singapore", office: "Intellectual Property Office of Singapore" },
  TW: { country: "Taiwan", office: "Taiwan Intellectual Property Office" },
  ZA: { country: "South Africa", office: "Companies and Intellectual Property Commission" },
  HK: { country: "Hong Kong", office: "Intellectual Property Department" },
  TR: { country: "Turkey", office: "Turkish Patent and Trademark Office" },
  UA: { country: "Ukraine", office: "Ukrainian Intellectual Property Institute" },
  AR: { country: "Argentina", office: "National Institute of Industrial Property" },
  CL: { country: "Chile", office: "National Institute of Industrial Property" },
  CO: { country: "Colombia", office: "Superintendence of Industry and Commerce" },
  MY: { country: "Malaysia", office: "Intellectual Property Corporation of Malaysia" },
  ID: { country: "Indonesia", office: "Directorate General of Intellectual Property" },
  TH: { country: "Thailand", office: "Department of Intellectual Property" },
  VN: { country: "Vietnam", office: "Intellectual Property Office of Vietnam" },
  PH: { country: "Philippines", office: "Intellectual Property Office of the Philippines" },
  GR: { country: "Greece", office: "Hellenic Industrial Property Organisation" },
  RO: { country: "Romania", office: "State Office for Inventions and Trademarks" },
  BG: { country: "Bulgaria", office: "Patent Office of the Republic of Bulgaria" },
  SK: { country: "Slovakia", office: "Industrial Property Office" },
  SI: { country: "Slovenia", office: "Slovenian Intellectual Property Office" },
  HR: { country: "Croatia", office: "State Intellectual Property Office" },
  CY: { country: "Cyprus", office: "Department of Registrar of Companies and Intellectual Property" },
  MT: { country: "Malta", office: "Industrial Property Registrations Directorate" },
  LT: { country: "Lithuania", office: "State Patent Bureau" },
  LV: { country: "Latvia", office: "Patent Office of the Republic of Latvia" },
  EE: { country: "Estonia", office: "Estonian Patent Office" },
  IS: { country: "Iceland", office: "Icelandic Intellectual Property Office" },
  LU: { country: "Luxembourg", office: "Intellectual Property Office" },
  AP: { country: "African Regional", office: "African Regional Intellectual Property Organization" },
  EA: { country: "Eurasian", office: "Eurasian Patent Organization" },
  OA: { country: "OAPI", office: "African Intellectual Property Organization" },
  GC: { country: "Gulf", office: "Gulf Cooperation Council Patent Office" },
};

export function filingPlace(code: string): { country: string; office: string } {
  const key = code.trim().toUpperCase().replace(/[^A-Z]/g, "").slice(0, 2);
  if (!key) return { country: "Unknown", office: "Unknown office" };
  return FILING_PLACES[key] ?? { country: key, office: `${key} patent office` };
}
