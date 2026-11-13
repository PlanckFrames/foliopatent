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

export function patentUrl(id: string): string {
  return `https://patents.google.com/patent/${encodeURIComponent(id)}/en`;
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

export function displayClaimNumber(value: string): string {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const number = Number.parseInt(trimmed, 10);
    if (Number.isFinite(number)) return String(number);
  }
  return trimmed;
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
