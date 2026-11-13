import type { Citation, ClaimText, Classification, FamilyMember, OfficialRecord, PatentNumber, RelatedCase } from "./types";
import { displayClaimNumber, officeFromId, stripTags } from "./text";

type SerpParty = string | { name?: string };
type SerpCitation = { publication_number?: string; title?: string; assignee_original?: string };
type SerpFamilyApp = {
  country_code?: string;
  document_id?: string;
  filing_date?: string;
  this_app?: boolean;
  legal_status?: string;
};
type SerpRelated = { representative_publication?: string; relation_type?: string; title?: string };
type SerpDetails = {
  error?: string;
  title?: string;
  publication_number?: string;
  abstract?: string;
  claims?: unknown[];
  description_link?: string;
  inventors?: { name?: string }[];
  assignees?: SerpParty[];
  priority_date?: string;
  filing_date?: string;
  publication_date?: string;
  application_number?: string;
  priority_applications?: { application_number?: string; representative_publication?: string }[];
  prior_art_keywords?: string[];
  classifications?: { code?: string; description?: string; leaf?: boolean }[];
  events?: { date?: string; title?: string; type?: string }[];
  patent_citations?: { original?: SerpCitation[] };
  child_applications?: SerpRelated[];
  parent_applications?: SerpRelated[];
  worldwide_applications?: Record<string, SerpFamilyApp[]>;
};

const detailsCache = new Map<string, { at: number; body: SerpDetails }>();

function partyName(value: SerpParty | undefined): string {
  if (!value) return "";
  return (typeof value === "string" ? value : value.name ?? "").replace(/\s+/g, " ").trim();
}

function cleanId(value: string): string {
  const match = value.toUpperCase().match(/[A-Z]{2}\d{5,14}[A-Z]\d?/);
  return match?.[0] ?? "";
}

function isIndependent(text: string): boolean {
  return !/\b(of|to|in|with|according to)\s+claims?\s+\d+/i.test(text) && !/\bas claimed in\b/i.test(text);
}

function pickClaims(raw: unknown[]): ClaimText[] {
  const claims: ClaimText[] = [];
  for (const item of raw) {
    const text = (typeof item === "string" ? item : "").replace(/\s+/g, " ").trim();
    if (text.length < 24) continue;
    const number = displayClaimNumber(text.match(/^(\d+)\./)?.[1] ?? String(claims.length + 1));
    claims.push({ number, text: text.slice(0, 2200), independent: isIndependent(text) });
    if (claims.length >= 40) break;
  }
  return claims;
}

function pickClasses(items: { code?: string; description?: string; leaf?: boolean }[]): Classification[] {
  const pairs = items
    .map((item) => ({
      code: (item.code ?? "").trim(),
      description: (item.description ?? "").replace(/\s+/g, " ").trim(),
      leaf: Boolean(item.leaf),
    }))
    .filter((item) => item.code.length >= 4 && item.description);
  const leaves = pairs.filter((item) => item.leaf && !item.code.startsWith("Y") && !item.code.startsWith("B01J2219"));
  const pool = leaves.length > 0 ? leaves : pairs.filter((item) => item.code.includes("/") && !item.code.startsWith("Y"));
  const groups = new Map<string, Classification[]>();
  for (const item of pool) {
    const key = item.code.split("/")[0] ?? item.code;
    const list = groups.get(key) ?? [];
    list.push({ code: item.code, description: item.description, scheme: "CPC" });
    groups.set(key, list);
  }
  const ranked = [...groups.values()].sort((a, b) => b.length - a.length);
  const picked: Classification[] = [];
  const seen = new Set<string>();
  for (const group of ranked) {
    for (const item of [...group].sort((a, b) => b.code.length - a.code.length)) {
      const key = item.description.toLowerCase().slice(0, 56);
      if (seen.has(key)) continue;
      seen.add(key);
      picked.push(item);
      if (picked.length >= 5) return picked;
    }
    if (picked.length >= 4) break;
  }
  return picked;
}

function relatedFrom(items: SerpRelated[] | undefined, fallback: string): RelatedCase[] {
  const related: RelatedCase[] = [];
  for (const item of items ?? []) {
    const number = cleanId(item.representative_publication ?? "");
    if (!number || related.some((entry) => entry.number === number)) continue;
    related.push({
      number,
      relationship: (item.relation_type || fallback).replace(/\s+/g, " ").trim(),
      title: (item.title ?? "").replace(/\s+/g, " ").trim(),
    });
    if (related.length >= 12) break;
  }
  return related;
}

function numbersFromSerp(body: SerpDetails, id: string, office: string): PatentNumber[] {
  const numbers: PatentNumber[] = [];
  const seen = new Set<string>();
  const add = (label: string, value: string) => {
    const clean = value.replace(/\s+/g, " ").trim();
    const compact = clean.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
    const key = `${label}|${compact}`;
    if (clean.length < 4 || seen.has(key)) return;
    if (label !== "Publication" && compact === id) return;
    seen.add(key);
    numbers.push({ label, value: clean });
  };
  add("Publication", id);
  if (body.application_number) add("Application", body.application_number);
  for (const item of body.priority_applications ?? []) {
    const value = item.application_number || item.representative_publication || "";
    if (value) add("Priority", value);
  }
  for (const year of Object.values(body.worldwide_applications ?? {})) {
    for (const app of year ?? []) {
      if (!app.this_app) continue;
      const number = cleanId(app.document_id ?? "");
      if (number && number.slice(0, 2) === office) add("Other publication", number);
    }
  }
  return numbers.slice(0, 12);
}

export function mapSerpDetails(body: SerpDetails, requestedId: string): OfficialRecord | null {
  const id = cleanId(body.publication_number ?? "") || cleanId(requestedId);
  if (!id || !body.title) return null;
  const office = officeFromId(id);
  const claims = pickClaims(body.claims ?? []);
  const grant =
    (body.events ?? []).find((event) => /grant/i.test(event.type ?? "") || /granted|issued/i.test(event.title ?? ""))?.date ??
    "";
  const dates = [
    { label: "Priority", value: (body.priority_date ?? "").slice(0, 10) },
    { label: "Filing", value: (body.filing_date ?? "").slice(0, 10) },
    { label: "Publication", value: (body.publication_date ?? "").slice(0, 10) },
    { label: "Grant", value: grant.slice(0, 10) },
  ].filter((item) => item.value);

  const citations: Citation[] = [];
  for (const cite of body.patent_citations?.original ?? []) {
    const number = cleanId(cite.publication_number ?? "");
    if (!number) continue;
    citations.push({
      number,
      title: (cite.title ?? "").replace(/\s+/g, " ").trim(),
      assignee: (cite.assignee_original ?? "").replace(/\s+/g, " ").trim(),
    });
    if (citations.length >= 24) break;
  }

  const family: FamilyMember[] = [];
  let status = "";
  for (const year of Object.values(body.worldwide_applications ?? {})) {
    for (const app of year ?? []) {
      if (app.this_app && app.legal_status) status = app.legal_status;
      const number = cleanId(app.document_id ?? "");
      const country = (app.country_code ?? number.slice(0, 2)).toUpperCase();
      if (!country || country === office.code) continue;
      if (family.some((member) => member.country === country && member.number === number)) continue;
      family.push({ number, date: (app.filing_date ?? "").slice(0, 10), country });
      if (family.length >= 20) break;
    }
  }

  const inventors = (body.inventors ?? []).map((person) => (person.name ?? "").replace(/\s+/g, " ").trim()).filter(Boolean);
  const assignees = (body.assignees ?? [])
    .map((party) => partyName(party))
    .filter(Boolean)
    .slice(0, 8)
    .map((name) => ({ name, role: "Assignee" }));

  return {
    id,
    title: body.title.replace(/\s+/g, " ").trim(),
    status,
    inventors: inventors.slice(0, 12),
    assignees,
    abstract: (body.abstract ?? "").replace(/\s+/g, " ").trim(),
    claims,
    excerpt: "",
    dates,
    numbers: numbersFromSerp(body, id, office.code),
    officeCode: office.code,
    officeName: office.name,
    citations,
    family,
    related: [...relatedFrom(body.parent_applications, "Parent application"), ...relatedFrom(body.child_applications, "Child application")].slice(0, 16),
    classifications: pickClasses(body.classifications ?? []),
    keywords: (body.prior_art_keywords ?? []).map((word) => word.trim()).filter((word) => word.length > 3).slice(0, 8),
    language: "en",
    sourceNotes: ["SerpApi Google Patents"],
  };
}

async function readDescription(link: string, apiKey: string): Promise<string> {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return "";
  }
  if (url.protocol !== "https:") return "";
  if (url.hostname === "serpapi.com" || url.hostname.endsWith(".serpapi.com")) url.searchParams.set("api_key", apiKey);
  const response = await fetch(url, { signal: AbortSignal.timeout(12_000) });
  if (!response.ok) return "";
  return stripTags((await response.text()).slice(0, 180_000)).slice(0, 40_000);
}

export async function fetchSerpRecord(
  id: string,
  apiKey: string,
): Promise<{ record: OfficialRecord } | { note: string }> {
  const cached = detailsCache.get(id);
  const fresh = cached && Date.now() - cached.at < (cached.body.error ? 2 * 60 * 1000 : 30 * 60 * 1000);
  let body = fresh ? cached.body : null;
  if (!body) {
    const url = new URL("https://serpapi.com/search.json");
    url.searchParams.set("engine", "google_patents_details");
    url.searchParams.set("patent_id", `patent/${id}/en`);
    url.searchParams.set("api_key", apiKey);
    const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    body = (await response.json().catch(() => ({ error: "SerpApi returned an unreadable response" }))) as SerpDetails;
    if (!response.ok && !body.error) body = { ...body, error: `SerpApi returned ${response.status}` };
    if (detailsCache.size > 12) {
      const oldest = [...detailsCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) detailsCache.delete(oldest[0]);
    }
    detailsCache.set(id, { at: Date.now(), body });
  }
  if (body.error) {
    const quota = /run out|limit|quota/i.test(body.error);
    return { note: quota ? "SerpApi monthly limit reached; used the public page" : "SerpApi lookup unavailable; used the public page" };
  }
  const record = mapSerpDetails(body, id);
  if (!record) return { note: "SerpApi had no matching patent; used the public page" };
  const description = body.description_link ? await readDescription(body.description_link, apiKey).catch(() => "") : "";
  const claimText = record.claims.map((claim) => claim.text).join("\n");
  record.excerpt = [record.abstract, claimText, description].filter(Boolean).join("\n\n").slice(0, 70_000);
  return { record };
}
