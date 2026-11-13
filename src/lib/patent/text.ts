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

export function claimPoints(text: string): string[] {
  const body = text.replace(/^\s*\d+\.\s*/, "").replace(/\s+/g, " ").trim();
  if (!body) return [];
  const parts = body.split(/;\s+/).map((part) => part.trim()).filter((part) => part.length > 24);
  const source = parts.length >= 2 ? parts : [body];
  return source.slice(0, 3).map((part) => {
    const clean = part.replace(/[,:;]\s*$/, "");
    if (clean.length <= 150) return clean;
    return `${clean.slice(0, 147).replace(/\s+\S*$/, "")}…`;
  });
}
