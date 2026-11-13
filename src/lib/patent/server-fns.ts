import { createServerFn } from "@tanstack/react-start";
import { parseGooglePatent } from "./parse-google";
import { fetchSerpRecord } from "./serp";
import { firstSentences, displayClaimNumber, normalizePublicationId, publicationCandidates, samePassage } from "./text";
import type { Brief, ClaimNote, LookupInput, OfficialRecord } from "./types";

const pageCache = new Map<string, { at: number; html: string }>();

function readKey(...names: string[]): string {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return "";
}

async function fetchPatentPage(id: string): Promise<string | null> {
  const cached = pageCache.get(id);
  if (cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.html;
  const response = await fetch(`https://patents.google.com/patent/${encodeURIComponent(id)}/en`, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      Accept: "text/html",
      "Accept-Language": "en",
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) return null;
  const html = await response.text();
  if (html.length < 5_000 || /Error 404 \(Not Found\)/i.test(html.slice(0, 600))) return null;
  if (pageCache.size > 3) {
    const oldest = [...pageCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) pageCache.delete(oldest[0]);
  }
  pageCache.set(id, { at: Date.now(), html });
  return html;
}

async function enrichUspto(record: OfficialRecord, apiKey: string) {
  if (!apiKey || !record.id.startsWith("US")) return;
  const digits = record.id.replace(/\D/g, "");
  const response = await fetch("https://api.uspto.gov/api/v1/patent/applications/search", {
    method: "POST",
    headers: {
      "X-API-KEY": apiKey,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      q: `applicationMetaData.patentNumber:${digits}`,
      pagination: { offset: 0, limit: 1 },
    }),
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) {
    record.sourceNotes.push("USPTO record unavailable");
    return;
  }
  const body = (await response.json()) as {
    patentFileWrapperDataBag?: {
      applicationMetaData?: {
        inventionTitle?: string;
        filingDate?: string;
        grantDate?: string;
        earliestPublicationDate?: string;
        applicationStatusDescriptionText?: string;
        applicationNumberText?: string;
        inventorBag?: { inventorNameText?: string; firstName?: string; lastName?: string }[];
        applicantBag?: { applicantNameText?: string }[];
      };
      parentContinuityBag?: { parentApplicationNumberText?: string; claimParentageTypeCodeDescriptionText?: string }[];
      childContinuityBag?: { childApplicationNumberText?: string; claimParentageTypeCodeDescriptionText?: string }[];
    }[];
  };
  const meta = body.patentFileWrapperDataBag?.[0]?.applicationMetaData;
  if (!meta) {
    record.sourceNotes.push("USPTO had no matching application");
    return;
  }
  if (meta.inventionTitle) record.title = meta.inventionTitle;
  if (meta.applicationStatusDescriptionText) record.status = meta.applicationStatusDescriptionText;
  const inventors = (meta.inventorBag ?? [])
    .map((person) => person.inventorNameText || [person.firstName, person.lastName].filter(Boolean).join(" "))
    .filter(Boolean);
  if (inventors.length > 0) record.inventors = inventors;
  const applicants = (meta.applicantBag ?? []).map((item) => item.applicantNameText).filter((name): name is string => Boolean(name));
  if (applicants.length > 0) {
    record.assignees = [
      ...applicants.map((name) => ({ name, role: "Applicant (USPTO)" })),
      ...record.assignees.filter((party) => party.role === "Current assignee"),
    ];
  }
  const putDate = (label: string, value?: string) => {
    if (!value) return;
    const existing = record.dates.find((item) => item.label === label);
    if (existing) existing.value = value.slice(0, 10);
    else record.dates.push({ label, value: value.slice(0, 10) });
  };
  putDate("Filing", meta.filingDate);
  putDate("Publication", meta.earliestPublicationDate);
  putDate("Grant", meta.grantDate);
  if (meta.applicationNumberText && !(record.numbers ?? []).some((item) => item.label === "Application")) {
    record.numbers = [...(record.numbers ?? []), { label: "Application", value: meta.applicationNumberText }];
  }
  const wrapper = body.patentFileWrapperDataBag?.[0];
  for (const parent of wrapper?.parentContinuityBag ?? []) {
    if (!parent.parentApplicationNumberText) continue;
    record.related.unshift({
      number: parent.parentApplicationNumberText,
      relationship: parent.claimParentageTypeCodeDescriptionText || "Parent application",
      title: "",
    });
  }
  record.sourceNotes.unshift("USPTO Open Data Portal");
}

async function epoToken(key: string, secret: string): Promise<string | null> {
  const response = await fetch("https://ops.epo.org/3.2/auth/accesstoken", {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${key}:${secret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) return null;
  const body = (await response.json()) as { access_token?: string };
  return body.access_token ?? null;
}

async function enrichEpo(record: OfficialRecord, key: string, secret: string) {
  if (!key || !secret) return;
  const token = await epoToken(key, secret);
  if (!token) {
    record.sourceNotes.push("EPO credentials were rejected");
    return;
  }
  const response = await fetch(
    `https://ops.epo.org/3.2/rest-services/family/publication/epodoc/${encodeURIComponent(record.id)}`,
    {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/xml" },
      signal: AbortSignal.timeout(12_000),
    },
  );
  if (!response.ok) {
    record.sourceNotes.push("EPO family lookup unavailable");
    return;
  }
  const xml = await response.text();
  const numbers = [
    ...xml.matchAll(/<country>([A-Z]{2})<\/country>\s*<doc-number>(\d+)<\/doc-number>\s*<kind>([A-Z]\d?)<\/kind>/gi),
  ].map((match) => `${match[1]}${match[2]}${match[3]}`);
  for (const number of numbers) {
    const country = number.slice(0, 2);
    if (country === record.officeCode || number === record.id) continue;
    if (record.family.some((member) => member.number === number)) continue;
    record.family.push({ number, date: "", country });
    if (record.family.length >= 20) break;
  }
  record.sourceNotes.unshift("EPO Open Patent Services");
}

export const lookupPatent = createServerFn({ method: "POST" })
  .validator((input: LookupInput) => {
    const id = input.id?.trim() ?? "";
    if (id.length < 4 || id.length > 40) throw new Error("Enter a publication number such as US6285999B1.");
    return { id };
  })
  .handler(async ({ data }): Promise<{ ok: true; record: OfficialRecord } | { ok: false; error: string }> => {
    try {
      const candidates = publicationCandidates(data.id);
      if (candidates.length === 0) {
        return { ok: false, error: "That doesn't look like a publication number. Try US6285999B1, or upload the PDF." };
      }
      const typed = normalizePublicationId(data.id);
      const exact = /^[A-Z]{2}\d{4,14}[A-Z]\d?$/.test(typed) ? typed : "";
      const serpKey = readKey("SERPAPI_API_KEY", "SERPAPI_KEY");
      let record: OfficialRecord | null = null;
      let serpNote = "";
      if (serpKey && exact) {
        const serp = await fetchSerpRecord(exact, serpKey).catch(() => ({ note: "SerpApi lookup unavailable; used the public page" }));
        if ("record" in serp) record = serp.record;
        else serpNote = serp.note;
      }
      if (!record) {
        for (const candidate of candidates) {
          const html = await fetchPatentPage(candidate);
          if (!html) continue;
          record = parseGooglePatent(html, candidate);
          if (record) break;
        }
      }
      if (!record) {
        return {
          ok: false,
          error: "No public record matched that number. Check the publication number, or upload the PDF.",
        };
      }
      if (serpNote) record.sourceNotes.push(serpNote);
      const usptoKey = readKey("USPTO_API_KEY", "ODP_API_KEY");
      const epoKey = readKey("EPO_CONSUMER_KEY", "EPO_OPS_KEY");
      const epoSecret = readKey("EPO_CONSUMER_SECRET", "EPO_OPS_SECRET");
      await enrichUspto(record, usptoKey).catch(() => {
        record?.sourceNotes.push("USPTO lookup failed");
      });
      await enrichEpo(record, epoKey, epoSecret).catch(() => {
        record?.sourceNotes.push("EPO lookup failed");
      });
      return { ok: true, record };
    } catch {
      return { ok: false, error: "The public patent record could not be read. Upload the PDF to analyze the document itself." };
    }
  });

type BriefClaim = { number: string; text: string };

type BriefInput = {
  title: string;
  abstract: string;
  background: string;
  claims: BriefClaim[];
  context: string;
  language: string;
};

const briefCache = new Map<string, Brief>();

function copiesSource(summary: string, source: string): boolean {
  if (!summary.trim() || !source.trim()) return false;
  if (samePassage(summary, source)) return true;
  const flat = summary.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  const base = source.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ");
  const words = flat.split(" ").filter(Boolean);
  let hits = 0;
  let windows = 0;
  for (let index = 0; index + 10 <= words.length; index += 1) {
    windows += 1;
    if (base.includes(words.slice(index, index + 10).join(" "))) hits += 1;
  }
  return windows > 0 && hits / windows > 0.34;
}

function usefulBullet(bullet: string, claim: string): boolean {
  const clean = bullet.replace(/\s+/g, " ").trim();
  if (clean.length < 12) return false;
  if (/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(clean)) return false;
  if (/^(states what this claim protects|covers a mixture or formulation|covers a way of doing something|covers a device|covers a use of the invention|adds a further requirement)/i.test(clean)) {
    return false;
  }
  return !tooClose(clean, claim);
}

function tooClose(bullet: string, claim: string): boolean {
  const source = claim.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ");
  const flat = bullet.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  if (!flat) return true;
  if (flat.length > 40 && source.includes(flat)) return true;
  const words = flat.split(" ").filter(Boolean);
  for (let index = 0; index + 8 <= words.length; index += 1) {
    if (source.includes(words.slice(index, index + 8).join(" "))) return true;
  }
  return false;
}

function extractiveBrief(input: BriefInput): Brief {
  const abstractSummary = firstSentences(input.abstract, 5);
  const backgroundSummary = samePassage(input.background, input.abstract) ? "" : firstSentences(input.background, 5);
  return {
    abstractSummary,
    backgroundSummary,
    patentSummary: "",
    claimNotes: input.claims.slice(0, 16).map((claim, index) => ({
      number: displayClaimNumber(claim.number || String(index + 1)),
      bullets: [],
    })),
    source: "extract",
  };
}

type ModelBrief = {
  abstractSummary?: string;
  backgroundSummary?: string;
  patentSummary?: string;
  claimNotes?: { number?: string; bullets?: unknown }[];
};

function acceptNotes(claims: BriefClaim[], parsed: ModelBrief): { notes: ClaimNote[]; quoted: number } {
  let quoted = 0;
  const notes = claims.map((claim, index) => {
    const wanted = displayClaimNumber(claim.number || String(index + 1));
    const match =
      (parsed.claimNotes ?? []).find((note) => displayClaimNumber(String(note.number ?? "")) === wanted) ??
      parsed.claimNotes?.[index];
    const raw = Array.isArray(match?.bullets) ? match.bullets.map((item) => String(item).trim()).filter(Boolean) : [];
    const bullets = raw.filter((item) => usefulBullet(item, claim.text)).slice(0, 3).map((item) => item.slice(0, 280));
    if (raw.length > 0 && bullets.length === 0) quoted += 1;
    return { number: wanted, bullets };
  });
  return { notes, quoted };
}

async function askModel(apiKey: string, data: BriefInput, stricter: boolean): Promise<ModelBrief | null> {
  const response = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "grok-4.5",
      temperature: stricter ? 0.4 : 0.2,
      max_tokens: 3200,
      messages: [
        {
          role: "system",
          content:
            "You explain patents to a general reader who is not a lawyer. Write in simple English even when the source is not English. Return only JSON with keys abstractSummary (string, at most 5 sentences, or empty if no abstract was provided), backgroundSummary (string, at most 5 sentences, or empty if no background was provided), patentSummary (string, at most 5 sentences on what the whole patent covers), claimNotes (array of {number, bullets}). If the background says (none), backgroundSummary must be an empty string. Never copy the abstract into the background or into patentSummary. patentSummary must use new sentences; if a sentence could be found in the abstract, do not write it. Each claim gets 1 to 3 English bullets that explain the point for a non-expert. Do not quote the claim in any language. Do not reuse any stretch of five or more source words. Do not write filler such as 'States what this claim protects', 'Covers a mixture', or 'Adds a further requirement'. If you cannot explain a claim without quoting it, return an empty bullets array for that claim. Do not invent features. Do not give legal advice.",
        },
        {
          role: "user",
          content: `${stricter ? "The previous bullets copied the claim. Rewrite every bullet so a high-school reader understands the point without seeing the claim.\n" : ""}Source language: ${data.language || "unknown"}
Title: ${data.title}

Abstract:
${data.abstract || "(none)"}

Background:
${data.background || "(none)"}

Description excerpt:
${data.context || "(none)"}

Claims:
${data.claims.map((claim) => `${displayClaimNumber(claim.number)}. ${claim.text}`).join("\n\n")}`,
        },
      ],
    }),
    signal: AbortSignal.timeout(40_000),
  });
  if (!response.ok) return null;
  const body = (await response.json()) as { choices?: { message?: { content?: string } }[] };
  const raw = body.choices?.[0]?.message?.content ?? "";
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  return JSON.parse(raw.slice(start, end + 1)) as ModelBrief;
}

export const explainPatent = createServerFn({ method: "POST" })
  .validator((input: BriefInput) => ({
    title: (input.title ?? "").slice(0, 300),
    abstract: (input.abstract ?? "").slice(0, 3500),
    background: (input.background ?? "").slice(0, 3500),
    claims: (input.claims ?? []).slice(0, 16).map((claim) => ({
      number: String(claim.number ?? "").slice(0, 8),
      text: String(claim.text ?? "").slice(0, 900),
    })),
    context: (input.context ?? "").slice(0, 1800),
    language: (input.language ?? "en").slice(0, 12),
  }))
  .handler(async ({ data }): Promise<Brief> => {
    const fallback = extractiveBrief(data);
    const apiKey = process.env.XAI_API_KEY;
    if (!apiKey || (!data.abstract && !data.background && data.claims.length === 0)) return fallback;
    const cacheKey = `${data.title}|${data.abstract.slice(0, 120)}|${data.background.slice(0, 120)}|${data.claims.map((claim) => claim.number).join(",")}`;
    const cached = briefCache.get(cacheKey);
    if (cached) return cached;
    try {
      const parsed = await askModel(apiKey, data, false);
      if (!parsed) return fallback;
      let { notes, quoted } = acceptNotes(data.claims, parsed);
      const missing = notes.filter((note) => note.bullets.length === 0).length;
      if (data.claims.length > 0 && (quoted > 0 || missing * 2 >= data.claims.length)) {
        const again = await askModel(apiKey, data, true).catch(() => null);
        if (again) {
          const retried = acceptNotes(data.claims, again);
          notes = notes.map((note, index) => {
            const next = retried.notes[index];
            if (note.bullets.length === 0 && next && next.bullets.length > 0) return next;
            return note;
          });
        }
      }
      const brief: Brief = {
        abstractSummary: String(parsed.abstractSummary ?? "").replace(/\s+/g, " ").trim().slice(0, 1400),
        backgroundSummary: samePassage(String(parsed.backgroundSummary ?? ""), data.abstract)
          ? ""
          : String(parsed.backgroundSummary ?? "").replace(/\s+/g, " ").trim().slice(0, 1400),
        patentSummary: copiesSource(String(parsed.patentSummary ?? ""), data.abstract) || /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(String(parsed.patentSummary ?? ""))
          ? ""
          : String(parsed.patentSummary ?? "").replace(/\s+/g, " ").trim().slice(0, 1400),
        claimNotes: notes,
        source: parsed.abstractSummary || parsed.backgroundSummary || parsed.patentSummary ? "brief" : "extract",
      };
      if (!brief.patentSummary) {
        const again = await askModel(apiKey, data, true).catch(() => null);
        const rewritten = String(again?.patentSummary ?? "").replace(/\s+/g, " ").trim();
        if (rewritten && !copiesSource(rewritten, data.abstract)) brief.patentSummary = rewritten.slice(0, 1400);
      }
      if (!brief.abstractSummary && !brief.backgroundSummary) {
        brief.abstractSummary = fallback.abstractSummary;
        brief.backgroundSummary = fallback.backgroundSummary;
      }
      if (briefCache.size > 24) briefCache.clear();
      briefCache.set(cacheKey, brief);
      return brief;
    } catch {
      return fallback;
    }
  });

type FrontClaim = { number: string; text: string };

type FrontInput = {
  language: string;
  languageLabel: string;
  title: string;
  abstract: string;
  claims: FrontClaim[];
};

export type FrontTranslation = {
  title: string;
  abstract: string;
  claims: FrontClaim[];
  translated: boolean;
};

type PageInput = {
  language: string;
  languageLabel: string;
  pages: { page: number; text: string; example?: boolean }[];
};

export type PageReading = {
  pages: { page: number; english: string }[];
  chemicals: { name: string; formula: string; cas: string; note: string }[];
  organisms: { name: string; note: string }[];
  materials: { name: string; note: string }[];
  technologies: { name: string; note: string }[];
  translated: boolean;
  unavailable: boolean;
};

const translationCache = new Map<string, unknown>();

function parseJsonObject(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function askJson(apiKey: string, system: string, user: string, maxTokens: number): Promise<Record<string, unknown> | null> {
  for (const jsonMode of [true, false]) {
    try {
      const response = await fetch("https://api.x.ai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: "grok-4.5",
          temperature: 0.1,
          max_tokens: maxTokens,
          ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        }),
        signal: AbortSignal.timeout(55_000),
      });
      if (!response.ok) continue;
      const body = (await response.json()) as { choices?: { message?: { content?: string } }[] };
      const parsed = parseJsonObject(body.choices?.[0]?.message?.content ?? "");
      if (parsed) return parsed;
    } catch {
      return null;
    }
  }
  return null;
}

function cacheGet<T>(key: string): T | null {
  return translationCache.has(key) ? (translationCache.get(key) as T) : null;
}

function cacheSet(key: string, value: unknown) {
  if (translationCache.size > 40) translationCache.clear();
  translationCache.set(key, value);
}

function asText(value: unknown, max: number): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

export const translateFrontMatter = createServerFn({ method: "POST" })
  .validator((input: FrontInput): FrontInput => ({
    language: (input.language ?? "en").slice(0, 12),
    languageLabel: (input.languageLabel ?? "the source language").slice(0, 40),
    title: (input.title ?? "").slice(0, 400),
    abstract: (input.abstract ?? "").slice(0, 5000),
    claims: (input.claims ?? []).slice(0, 6).map((claim) => ({
      number: String(claim.number ?? "").slice(0, 8),
      text: String(claim.text ?? "").slice(0, 2200),
    })),
  }))
  .handler(async ({ data }): Promise<FrontTranslation> => {
    const original: FrontTranslation = {
      title: data.title,
      abstract: data.abstract,
      claims: data.claims,
      translated: false,
    };
    if (data.language === "en" || (!data.title && !data.abstract && data.claims.length === 0)) return original;
    const apiKey = process.env.XAI_API_KEY;
    if (!apiKey) return original;
    const key = `front|${data.language}|${data.title}|${data.abstract.slice(0, 80)}|${data.claims.map((claim) => claim.number + claim.text.length).join(",")}`;
    const cached = cacheGet<FrontTranslation>(key);
    if (cached) return cached;
    const parsed = await askJson(
      apiKey,
      "You translate patents into English. Translate completely. Do not summarize, shorten, or drop clauses, numerals, chemical names, or reference numbers. Return only JSON.",
      `Source language: ${data.languageLabel}
Title: ${data.title || "(none)"}

Abstract:
${data.abstract || "(none)"}

Claims:
${data.claims.map((claim) => `${displayClaimNumber(claim.number)}. ${claim.text}`).join("\n\n") || "(none)"}

Return {"title":"","abstract":"","claims":[{"number":"1","text":""}]}.
If a field was empty, return an empty string. Keep every claim number. If the text is already English, copy it unchanged.`,
      4500,
    );
    if (!parsed) return original;
    const claims = Array.isArray(parsed.claims) ? parsed.claims : [];
    const translatedClaims = data.claims.map((claim, index) => {
      const wanted = displayClaimNumber(claim.number || String(index + 1));
      const match =
        claims.find((item) => {
          const row = item as { number?: unknown };
          return displayClaimNumber(String(row.number ?? "")) === wanted;
        }) ?? claims[index];
      const row = (match ?? {}) as { text?: unknown };
      const text = asText(row.text, 4000);
      return { number: wanted, text: text.length > 20 ? text : claim.text };
    });
    const result: FrontTranslation = {
      title: asText(parsed.title, 400) || data.title,
      abstract: asText(parsed.abstract, 5000) || data.abstract,
      claims: translatedClaims,
      translated: true,
    };
    cacheSet(key, result);
    return result;
  });

function findingList(value: unknown, kind: "chemical" | "name"): { name: string; formula: string; cas: string; note: string }[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const row = (item ?? {}) as { name?: unknown; formula?: unknown; cas?: unknown; note?: unknown };
      return {
        name: asText(row.name, kind === "chemical" ? 160 : 80),
        formula: kind === "chemical" ? asText(row.formula, 40) : "",
        cas: kind === "chemical" ? asText(row.cas, 20) : "",
        note: asText(row.note, 80),
      };
    })
    .filter((item) => item.name.length > 2);
}

export const readPatentPages = createServerFn({ method: "POST" })
  .validator((input: PageInput): PageInput => ({
    language: (input.language ?? "en").slice(0, 12),
    languageLabel: (input.languageLabel ?? "the source language").slice(0, 40),
    pages: (input.pages ?? [])
      .slice(0, 3)
      .map((page) => ({
        page: Number.isFinite(Number(page.page)) ? Number(page.page) : 0,
        text: String(page.text ?? "").slice(0, 5500),
        example: Boolean(page.example),
      }))
      .filter((page) => page.text.trim().length > 40),
  }))
  .handler(async ({ data }): Promise<PageReading> => {
    const empty: PageReading = {
      pages: [],
      chemicals: [],
      organisms: [],
      materials: [],
      technologies: [],
      translated: false,
      unavailable: false,
    };
    if (data.pages.length === 0) return empty;
    const apiKey = process.env.XAI_API_KEY;
    if (!apiKey) return { ...empty, unavailable: true };
    const key = `pages|${data.language}|${data.pages.map((page) => `${page.page}:${page.example ? "x" : ""}:${page.text.length}:${page.text.slice(0, 48)}`).join("|")}`;
    const cached = cacheGet<PageReading>(key);
    if (cached) return cached;
    const english = data.language === "en";
    const examples = data.pages.some((page) => page.example);
    const body = data.pages.map((page) => `--- page ${page.page}${page.example ? " (experimental example)" : ""} ---\n${page.text}`).join("\n\n");
    const lists = `Return {"pages":${english ? "[]" : '[{"page":1,"english":""}]'},"chemicals":[{"name":"","formula":"","cas":"","note":""}],"organisms":[{"name":"","note":""}],"materials":[{"name":"","note":""}],"technologies":[{"name":"","note":""}]}.
A chemical is any named substance, drug, reagent, solvent, catalyst, polymer, salt, peptide, or element printed in the text, not only well-known ones, including every compound prepared or tested in an example. An organism is any species, strain, cell line, or virus, including binomial names that are not household species. A material is a named composite, alloy, resin, ceramic, fibre, or construction material. A technology is a named method, instrument, assay, or process used in the work, such as HPLC, NMR, lyophilization, or spray drying. In an experimental or example section, list every one of these, not a sample. Skip vague words such as solution, compound, or cells. formula and cas stay empty unless printed. note is "example" when the name comes from an example, otherwise the page number.`;
    const parsed = await askJson(
      apiKey,
      english
        ? "You list every specific chemical, organism, material, and technology named in patent text, especially in experimental examples. Do not invent names, formulas, or CAS numbers. Return only JSON."
        : "You translate each patent page into complete English, including every experimental example, then list every specific chemical, organism, material, and technology named on it. Do not summarize an example. Do not invent names, formulas, or CAS numbers. Return only JSON.",
      english
        ? `${body}

These pages are already English. Do not repeat them.
${examples ? "These pages are experimental examples. List every compound, reagent, organism, material, and technique they use.\n" : ""}${lists}`
        : `Source language: ${data.languageLabel}

${body}

${lists}
english must be the full translation of that page, with every sentence of any example kept. Do not shorten it.`,
      english ? (examples ? 3600 : 2200) : 5000,
    );
    if (!parsed) return { ...empty, unavailable: true };
    const pageRows = Array.isArray(parsed.pages) ? parsed.pages : [];
    const pages = english
      ? []
      : data.pages.map((page) => {
          const match =
            pageRows.find((item) => Number((item as { page?: unknown }).page) === page.page) ??
            pageRows[data.pages.indexOf(page)];
          const englishText = String((match as { english?: unknown } | undefined)?.english ?? "").trim();
          return { page: page.page, english: englishText.slice(0, 8000) };
        }).filter((page) => page.english.length > 40);
    const result: PageReading = {
      pages,
      chemicals: findingList(parsed.chemicals, "chemical"),
      organisms: findingList(parsed.organisms, "name").map((item) => ({ name: item.name, note: item.note })),
      materials: findingList(parsed.materials, "name").map((item) => ({ name: item.name, note: item.note })),
      technologies: findingList(parsed.technologies, "name").map((item) => ({ name: item.name, note: item.note })),
      translated: pages.length > 0,
      unavailable: false,
    };
    cacheSet(key, result);
    return result;
  });
