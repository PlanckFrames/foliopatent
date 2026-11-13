import { createServerFn } from "@tanstack/react-start";
import { parseGooglePatent } from "./parse-google";
import { fetchSerpRecord } from "./serp";
import { firstSentences, claimPoints, normalizePublicationId, publicationCandidates } from "./text";
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
  claims: BriefClaim[];
  context: string;
  language: string;
  targetLanguage: string;
};

const briefCache = new Map<string, Brief>();

function notesFor(claims: BriefClaim[]): ClaimNote[] {
  return claims.slice(0, 8).map((claim, index) => ({
    number: claim.number || String(index + 1),
    bullets: claimPoints(claim.text),
  }));
}

function extractiveBrief(input: BriefInput): Brief {
  const abstractSummary =
    firstSentences(input.abstract, 5) || "The document did not include an abstract that could be summarized.";
  const patentSummary =
    firstSentences([input.title ? `${input.title}.` : "", input.abstract].filter(Boolean).join(" "), 5) || abstractSummary;
  return {
    abstractSummary,
    patentSummary,
    claimNotes: notesFor(input.claims),
    translation: "",
    source: "extract",
  };
}

export const explainPatent = createServerFn({ method: "POST" })
  .validator((input: BriefInput) => ({
    title: (input.title ?? "").slice(0, 300),
    abstract: (input.abstract ?? "").slice(0, 3500),
    claims: (input.claims ?? []).slice(0, 8).map((claim) => ({
      number: String(claim.number ?? "").slice(0, 8),
      text: String(claim.text ?? "").slice(0, 900),
    })),
    context: (input.context ?? "").slice(0, 2500),
    language: (input.language ?? "en").slice(0, 12),
    targetLanguage: (input.targetLanguage ?? "").slice(0, 24),
  }))
  .handler(async ({ data }): Promise<Brief> => {
    const fallback = extractiveBrief(data);
    const apiKey = process.env.XAI_API_KEY;
    if (!apiKey || (!data.abstract && data.claims.length === 0)) return fallback;
    const cacheKey = `${data.targetLanguage}|${data.title}|${data.abstract.slice(0, 160)}|${data.claims.map((claim) => claim.number).join(",")}`;
    const cached = briefCache.get(cacheKey);
    if (cached) return cached;
    const target = data.targetLanguage
      ? `Also translate the abstract into ${data.targetLanguage}. Put that translation in translation.`
      : data.language !== "en"
        ? "The source may not be English. Include an English translation of the abstract in translation."
        : "If the source is already English, leave translation empty.";
    try {
      const response = await fetch("https://api.x.ai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: "grok-4.5",
          temperature: 0.2,
          max_tokens: 1600,
          messages: [
            {
              role: "system",
              content:
                "You explain patents to a general reader who is not a lawyer. Return only JSON with keys abstractSummary (string, at most 5 sentences), patentSummary (string, at most 5 sentences on what the whole patent covers), claimNotes (array of {number, bullets} where bullets has at most 3 short plain-language points per claim), translation (string). Do not quote the claims verbatim. Do not invent features that are not in the source. Do not give legal advice.",
            },
            {
              role: "user",
              content: `${target}\nTitle: ${data.title}\n\nAbstract:\n${data.abstract || "(none)"}\n\nDescription excerpt:\n${data.context || "(none)"}\n\nClaims:\n${data.claims.map((claim) => `${claim.number}. ${claim.text}`).join("\n\n")}`,
            },
          ],
        }),
        signal: AbortSignal.timeout(40_000),
      });
      if (!response.ok) return fallback;
      const body = (await response.json()) as { choices?: { message?: { content?: string } }[] };
      const raw = body.choices?.[0]?.message?.content ?? "";
      const jsonText = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
      const parsed = JSON.parse(jsonText) as {
        abstractSummary?: string;
        patentSummary?: string;
        claimNotes?: { number?: string; bullets?: unknown }[];
        translation?: string;
      };
      const claimNotes = data.claims.map((claim, index) => {
        const match = (parsed.claimNotes ?? []).find((note) => String(note.number ?? "") === claim.number) ?? parsed.claimNotes?.[index];
        const bullets = Array.isArray(match?.bullets) ? match.bullets.map((item) => String(item).trim()).filter(Boolean).slice(0, 3) : [];
        return {
          number: claim.number || String(index + 1),
          bullets: (bullets.length > 0 ? bullets : claimPoints(claim.text)).map((item) => item.slice(0, 220)),
        };
      });
      const brief: Brief = {
        abstractSummary: String(parsed.abstractSummary || fallback.abstractSummary).slice(0, 1400),
        patentSummary: String(parsed.patentSummary || fallback.patentSummary).slice(0, 1400),
        claimNotes,
        translation: String(parsed.translation ?? "").slice(0, 2000),
        source: parsed.abstractSummary ? "brief" : "extract",
      };
      if (briefCache.size > 24) briefCache.clear();
      briefCache.set(cacheKey, brief);
      return brief;
    } catch {
      return fallback;
    }
  });
