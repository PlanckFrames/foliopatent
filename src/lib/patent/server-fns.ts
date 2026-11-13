import { createServerFn } from "@tanstack/react-start";
import { parseGooglePatent } from "./parse-google";
import { fetchSerpRecord } from "./serp";
import { firstSentences, displayClaimNumber, normalizePublicationId, publicationCandidates } from "./text";
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

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "over", "under", "than", "then", "such", "also", "only",
  "each", "any", "are", "was", "were", "been", "being", "have", "has", "had", "not", "but", "its", "their", "said",
  "wherein", "comprising", "according", "claim", "claims", "method", "use", "using", "which", "wherein",
]);

function contentWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 3 && !STOP_WORDS.has(word));
}

function tooClose(bullet: string, claim: string): boolean {
  const source = claim.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ");
  const flat = bullet.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  if (flat.length > 40 && source.includes(flat)) return true;
  const words = contentWords(bullet);
  if (words.length < 4) return false;
  const claimSet = new Set(contentWords(claim));
  const shared = words.filter((word) => claimSet.has(word)).length;
  return shared / words.length > 0.62;
}

function extractiveBrief(input: BriefInput): Brief {
  const abstractSummary = firstSentences(input.abstract, 5);
  const backgroundSummary = firstSentences(input.background, 5);
  const seed = [input.title ? `${input.title}.` : "", abstractSummary || backgroundSummary].filter(Boolean).join(" ");
  return {
    abstractSummary,
    backgroundSummary,
    patentSummary: firstSentences(seed, 5) || "The patent text that was read was too short to summarize.",
    claimNotes: input.claims.slice(0, 8).map((claim, index) => ({
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
    const bullets = raw.filter((item) => !tooClose(item, claim.text)).slice(0, 3).map((item) => item.slice(0, 280));
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
      max_tokens: 1800,
      messages: [
        {
          role: "system",
          content:
            "You explain patents to a general reader who is not a lawyer. Write in simple English even when the source is not English. Return only JSON with keys abstractSummary (string, at most 5 sentences, or empty if no abstract was provided), backgroundSummary (string, at most 5 sentences, or empty if no background was provided), patentSummary (string, at most 5 sentences on what the whole patent covers), claimNotes (array of {number, bullets}). Each claim gets 1 to 3 bullets that explain what the claim is about in everyday words. Do not quote the claim. Do not reuse any stretch of five or more source words. Replace legal and technical jargon with plain language; a short name in parentheses is allowed once. Do not invent features that are not in the source. Do not give legal advice.",
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
    claims: (input.claims ?? []).slice(0, 8).map((claim) => ({
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
        backgroundSummary: String(parsed.backgroundSummary ?? "").replace(/\s+/g, " ").trim().slice(0, 1400),
        patentSummary: String(parsed.patentSummary || fallback.patentSummary).replace(/\s+/g, " ").trim().slice(0, 1400),
        claimNotes: notes,
        source: parsed.abstractSummary || parsed.backgroundSummary || parsed.patentSummary ? "brief" : "extract",
      };
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
