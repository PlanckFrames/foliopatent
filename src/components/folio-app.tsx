import { useRef, useState, type ReactNode } from "react";
import {
  Calendar,
  FileUp,
  FlaskConical,
  Globe2,
  Hash,
  Layers,
  Link2,
  Loader2,
  Microscope,
  ScrollText,
  Search,
  Users,
  X,
} from "lucide-react";
import { describeClasses, lookupPatent, readPatentPages, translateClaims, translateOverview } from "@/lib/patent/server-fns";
import { biblioFromPdf, collectNumbers, collectParties, extractPdfText, findPublicationId, inventorColumns, titleFromPdf, type FaceParty } from "@/lib/patent/pdf";
import { absorbFindings, detectLanguage, scanText, type PageFinding } from "@/lib/patent/scan";
import { displayClaimNumber, documentHref, filingPlace, foreignLetters, grokUrl, patentUrl, readingChunksFromExcerpt, samePassage, selectReadingPages, wikiSearch, type ReadingPage } from "@/lib/patent/text";
import type { Brief, OfficialRecord, PatentNumber, Scan } from "@/lib/patent/types";

const SAMPLES = [
  { id: "US6285999B1", label: "PageRank" },
  { id: "US4683202A", label: "PCR" },
];

const SECTIONS = [
  { id: "numbers", title: "Patent numbers" },
  { id: "dates", title: "Dates" },
  { id: "applicant", title: "Applicant" },
  { id: "inventor", title: "Inventor" },
  { id: "assignee", title: "Assignee" },
  { id: "purpose", title: "Purpose" },
  { id: "claims", title: "Claims" },
  { id: "technologies", title: "Technologies" },
  { id: "classes", title: "Patent classifications" },
  { id: "chemicals", title: "Chemicals" },
  { id: "organisms", title: "Organisms" },
  { id: "citations", title: "Cited patents" },
  { id: "office", title: "Where filed" },
  { id: "family", title: "Filed elsewhere" },
  { id: "related", title: "Related cases" },
];

const FEATURES = [
  "Patent lookup",
  "Publication IDs",
  "Authors",
  "Owners",
  "Claims",
  "Chemical compounds",
  "Polymers",
  "Organisms",
  "Cited patents",
  "Filing dates",
  "Where it was filed",
  "Related cases",
  "Plain-language summaries",
  "Full English translation",
];

const USELESS_SUMMARY = /^(states what this claim protects|covers a mixture or formulation|covers a way of doing something|covers a device|covers a use of the invention|adds a further requirement)/i;

function stillForeign(text: string): boolean {
  return foreignLetters(text) >= 8;
}

function preferOriginal(...choices: string[]): string {
  const texts = choices.map((item) => item.replace(/\s+/g, " ").trim()).filter(Boolean);
  return texts.find((item) => foreignLetters(item) >= 8) || texts[0] || "";
}

function fieldNeedsTranslation(text: string): boolean {
  const sample = text.replace(/\s+/g, " ").trim();
  if (sample.length < 8) return false;
  if (/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\u0600-\u06ff\u0590-\u05ff\u0e00-\u0e7f\u0400-\u04ff\u0370-\u03ff]/.test(sample)) return true;
  if (sample.length < 80) return false;
  return detectLanguage(sample).code !== "en";
}

type ShownClaim = { number: string; text: string; original: string; independent: boolean; notes: string[] };

type Report = {
  record: OfficialRecord | null;
  scan: Scan;
  brief: Brief;
  note: string;
  numbers: PatentNumber[];
  writtenClaims: ShownClaim[];
  parties: Record<FaceParty["role"], FaceParty[]>;
  displayTitle: string;
  originalTitle: string;
  displayAbstract: string;
  originalAbstract: string;
  displayBackground: string;
  originalBackground: string;
  plainPoints: string[];
  frontTranslated: boolean;
  languageLabel: string;
  translatedPages: { page: number; english: string }[];
};

type Tab = {
  id: string;
  label: string;
  report: Report | null;
  phase: "working" | "ready" | "error";
  status: string;
  error: string;
};

const TAB_LIMIT = 10;

export function FolioApp() {
  const [publicationId, setPublicationId] = useState("");
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [banner, setBanner] = useState("");
  const tabSeq = useRef(0);
  const liveTabs = useRef(new Set<string>());
  const fileRef = useRef<HTMLInputElement>(null);
  const active = tabs.find((tab) => tab.id === activeId) ?? null;

  function patchTab(id: string, patch: Partial<Tab>) {
    if (!liveTabs.current.has(id)) return;
    setTabs((current) => current.map((tab) => (tab.id === id ? { ...tab, ...patch } : tab)));
  }

  function closeTab(id: string) {
    liveTabs.current.delete(id);
    setTabs((current) => {
      const index = current.findIndex((tab) => tab.id === id);
      const next = current.filter((tab) => tab.id !== id);
      setActiveId((open) => (open === id ? (next[Math.min(index, next.length - 1)]?.id ?? null) : open));
      return next;
    });
    setBanner("");
  }

  async function buildReport(options: { id?: string; file?: File }) {
    const typed = options.id?.trim() ?? "";
    if (!options.file && !typed) {
      setBanner("Enter a publication number or upload a patent PDF.");
      return;
    }
    if (options.file && options.file.size > 30 * 1024 * 1024) {
      setBanner("That PDF is over 30 MB. Try a smaller file.");
      return;
    }
    if (liveTabs.current.size >= TAB_LIMIT) {
      setBanner("Close a tab first. 10/10 are already open.");
      return;
    }
    const tabId = `tab-${++tabSeq.current}`;
    liveTabs.current.add(tabId);
    const fileLabel = options.file?.name.replace(/\.pdf$/i, "") ?? "";
    setBanner("");
    setTabs((current) => [
      ...current,
      {
        id: tabId,
        label: fileLabel || typed || "Patent",
        report: null,
        phase: "working",
        status: options.file ? "Reading the PDF in this browser…" : "Opening the public patent record…",
        error: "",
      },
    ]);
    setActiveId(tabId);
    try {
      let pdfText = "";
      let pdfNote = "";
      let pageTexts: string[] = [];
      let id = options.file ? "" : typed;
      if (options.file) {
        const extracted = await extractPdfText(options.file, (message) => {
          if (!liveTabs.current.has(tabId)) return;
          patchTab(tabId, { status: message });
        });
        if (!liveTabs.current.has(tabId)) return;
        pdfText = extracted.text;
        pageTexts = extracted.pageTexts;
        if (!pdfText.trim()) {
          throw new Error("This PDF could not be read. Type the publication number, or upload a clearer file.");
        }
        const where = extracted.scanned ? "scan" : "PDF";
        pdfNote = extracted.truncated
          ? `Read the first ${extracted.scanned ? 40 : 50} pages of the ${where} in this browser. The file was not uploaded.`
          : `Read the uploaded ${where} in this browser. The file was not uploaded.`;
        id = findPublicationId(pdfText);
      }

      let record: OfficialRecord | null = null;
      if (id) {
        patchTab(tabId, { status: "Opening the public patent record…", label: id });
        const looked = await lookupPatent({ data: { id } });
        if (!liveTabs.current.has(tabId)) return;
        if (looked.ok) record = looked.record;
        else if (!pdfText) throw new Error(looked.error);
        else pdfNote = `${pdfNote} The publication number in the file did not match a public record, so bibliographic fields come only from the PDF.`;
      } else if (!pdfText) {
        throw new Error("Enter a publication number or upload a patent PDF.");
      }

      const pdfBiblio = pdfText ? biblioFromPdf(pdfText) : { abstract: "", background: "", claims: [] };
      const excerptBiblio = record?.excerpt ? biblioFromPdf(record.excerpt) : { abstract: "", background: "", claims: [] };
      const abstract = preferOriginal(pdfBiblio.abstract, excerptBiblio.abstract, record?.abstract ?? "");
      const backgroundSource = preferOriginal(pdfBiblio.background, excerptBiblio.background, "");
      const background = samePassage(abstract, backgroundSource) ? "" : backgroundSource;
      const sourceTitle = preferOriginal(titleFromPdf(pdfText), record?.title ?? "", fileLabel || "Uploaded patent");
      const pdfClaimsForeign = pdfBiblio.claims.some((claim) => foreignLetters(claim.text) >= 12);
      const sourceClaims = pdfClaimsForeign
        ? pdfBiblio.claims.map((claim, index) => ({
            number: displayClaimNumber(claim.number || String(index + 1)),
            text: claim.text,
            independent: true,
          }))
        : record && record.claims.length > 0
          ? record.claims.map((claim) => ({
              number: displayClaimNumber(claim.number),
              text: claim.text,
              independent: claim.independent,
            }))
          : pdfBiblio.claims.map((claim, index) => ({
              number: displayClaimNumber(claim.number || String(index + 1)),
              text: claim.text,
              independent: true,
            }));
      const picked = pageTexts.length > 0 ? selectReadingPages(pageTexts) : readingChunksFromExcerpt(record?.excerpt || [abstract, background].filter(Boolean).join("\n"));
      let reading: ReadingPage[] = picked.pages;
      let examplesTruncated = picked.examplesTruncated;
      if (pageTexts.length > 0 && !reading.some((page) => page.example) && record?.excerpt) {
        const fromRecord = readingChunksFromExcerpt(record.excerpt);
        const examples = fromRecord.pages.filter((page) => page.example);
        if (examples.length > 0) {
          reading = [...reading.slice(0, 8), ...examples];
          examplesTruncated = fromRecord.examplesTruncated;
        }
      }
      const exampleCount = reading.filter((page) => page.example).length;
      const spoken = detectLanguage(
        (reading.filter((page) => page.example).map((page) => page.text).join("\n") || reading.map((page) => page.text).join("\n")).slice(0, 2500) ||
          abstract,
      );
      const fromRecord = !options.file;

      let displayTitle = sourceTitle;
      let displayAbstract = abstract;
      let displayBackground = background;
      let plainPoints: string[] = [];
      let writtenClaims: ShownClaim[] = sourceClaims.map((claim) => ({ ...claim, original: claim.text, text: "", notes: [] }));
      let frontTranslated = false;
      const frontLanguage = detectLanguage(
        sourceClaims.map((claim) => claim.text).join("\n").slice(0, 2500) || [sourceTitle, abstract, background].join("\n"),
      );
      if (sourceTitle || abstract || background) {
        patchTab(tabId, { status: "Translating the abstract and background…" });
        const overview = await translateOverview({
          data: { title: sourceTitle, abstract, background, languageLabel: frontLanguage.label },
        });
        if (!liveTabs.current.has(tabId)) return;
        if (overview.title && !stillForeign(overview.title)) displayTitle = overview.title;
        if (overview.abstract && !stillForeign(overview.abstract)) displayAbstract = overview.abstract;
        if (overview.background && !stillForeign(overview.background)) displayBackground = overview.background;
        plainPoints = overview.bullets;
        frontTranslated = displayTitle !== sourceTitle || displayAbstract !== abstract || displayBackground !== background || plainPoints.length > 0;
      }
      for (const claim of sourceClaims) {
        if (!liveTabs.current.has(tabId)) return;
        patchTab(tabId, { status: `Translating claim ${claim.number}…` });
        const part = await translateClaims({
          data: { languageLabel: frontLanguage.label, claims: [{ number: claim.number, text: claim.text }] },
        });
        if (!liveTabs.current.has(tabId)) return;
        const next = part.claims.find((item) => displayClaimNumber(item.number) === claim.number) ?? part.claims[0];
        if (!next?.english || stillForeign(next.english)) continue;
        frontTranslated = true;
        writtenClaims = writtenClaims.map((item) =>
          item.number === claim.number && item.original === claim.text ? { ...item, text: next.english, notes: next.bullets } : item,
        );
      }
      const missing = writtenClaims.filter((claim) => claim.original && !claim.text && fieldNeedsTranslation(claim.original));
      for (const claim of missing) {
        if (!liveTabs.current.has(tabId)) return;
        patchTab(tabId, { status: `Translating claim ${claim.number} again…` });
        const part = await translateClaims({
          data: { languageLabel: frontLanguage.label, claims: [{ number: claim.number, text: claim.original }] },
        });
        const next = part.claims[0];
        if (!next?.english || stillForeign(next.english)) continue;
        writtenClaims = writtenClaims.map((item) => (item.number === claim.number ? { ...item, text: next.english, notes: next.bullets } : item));
      }
      writtenClaims = writtenClaims.map((claim) => (claim.text || fieldNeedsTranslation(claim.original) ? claim : { ...claim, text: claim.original }));

      const findings: PageFinding = { chemicals: [], organisms: [], materials: [], technologies: [] };
      const translatedPages: { page: number; english: string }[] = [];
      const missed: number[] = [];
      let readerUnavailable = false;
      const unit = fromRecord ? "section" : "page";
      const batches: ReadingPage[][] = [];
      for (let index = 0; index < reading.length; ) {
        const size = reading[index]?.example ? 2 : 3;
        batches.push(reading.slice(index, index + size));
        index += size;
      }
      for (const batch of batches) {
        if (!liveTabs.current.has(tabId)) return;
        const start = batch[0]?.page ?? 0;
        const end = batch[batch.length - 1]?.page ?? start;
        const span = start === end ? `${unit} ${start}` : `${unit}s ${start}–${end}`;
        const exampleBatch = batch.every((page) => page.example);
        const batchLanguage = detectLanguage(batch.map((page) => page.text).join("\n").slice(0, 2500) || abstract);
        patchTab(tabId, {
          status:
            batchLanguage.code === "en"
              ? `Reading ${exampleBatch ? "experimental " : ""}${span} for technologies, chemicals, organisms, and materials…`
              : `Translating ${exampleBatch ? "experimental " : ""}${span}…`,
        });
        const part = await readPatentPages({
          data: {
            language: batchLanguage.code,
            languageLabel: batchLanguage.label,
            pages: batch.map((page) => ({ page: page.page, text: page.text, example: page.example })),
          },
        }).catch(() => null);
        if (!liveTabs.current.has(tabId)) return;
        if (!part || part.unavailable) {
          readerUnavailable = true;
          missed.push(...batch.map((page) => page.page));
          continue;
        }
        translatedPages.push(...part.pages);
        findings.chemicals.push(...part.chemicals);
        findings.organisms.push(...part.organisms);
        findings.materials.push(...part.materials);
        findings.technologies.push(...part.technologies);
      }

      const englishBody = translatedPages.map((page) => page.english).join("\n");
      const scanSource = [englishBody, pdfText, record?.excerpt ?? ""].filter(Boolean).join("\n").slice(0, 180_000);
      const glossary = scanText(scanSource, {
        classifications: record?.classifications,
        keywords: record?.keywords,
      });
      const scan = absorbFindings(glossary, findings);
      if (scan.classes.length > 0) {
        const described = await describeClasses({ data: { items: scan.classes } }).catch(() => null);
        if (described && described.length > 0) scan.classes = described;
      }
      let pageNote = pageReadingNote({
        pages: reading.length,
        translated: translatedPages.length,
        unavailable: readerUnavailable && findings.chemicals.length + findings.organisms.length + findings.materials.length + findings.technologies.length === 0,
        missed: missed.length,
        extra: examplesTruncated ? 1 : 0,
        examples: exampleCount,
        fromRecord,
        languageLabel: spoken.label,
      });

      const brief: Brief = {
        abstractSummary: "",
        backgroundSummary: "",
        patentSummary: "",
        claimNotes: writtenClaims.map((claim) => ({ number: claim.number, bullets: claim.notes })),
        source: plainPoints.length > 0 ? "brief" : "extract",
      };
      if (!liveTabs.current.has(tabId)) return;

      patchTab(tabId, {
        phase: "ready",
        status: "",
        label: record?.id || id || fileLabel || "Document",
        report: {
          record,
          scan,
          brief,
          note: [pdfNote, pageNote, ...(record?.sourceNotes ?? [])].filter(Boolean).join(" · "),
          numbers: collectNumbers(record, pdfText),
          writtenClaims,
          parties: collectParties(record, pdfText),
          displayTitle,
          originalTitle: sourceTitle,
          displayAbstract,
          originalAbstract: abstract,
          displayBackground,
          originalBackground: background,
          plainPoints,
          frontTranslated,
          languageLabel: frontLanguage.label,
          translatedPages,
        },
      });
      if (options.file) setPublicationId(record?.id || id || "");
      else if (record?.id) setPublicationId(record.id);
    } catch (caught) {
      if (!liveTabs.current.has(tabId)) return;
      patchTab(tabId, {
        phase: "error",
        status: "",
        error: caught instanceof Error ? caught.message : "The patent could not be read.",
      });
    }
  }

  return (
    <div className="min-h-screen bg-paper text-ink">
      <header className="sticky top-0 z-10 border-b border-line bg-paper">
        <div className="mx-auto flex max-w-6xl items-baseline justify-between gap-4 px-4 py-3">
          <p className="font-serif text-2xl leading-none tracking-tight">FolioPatent</p>
          <p className="text-sm text-muted">Up to ten open</p>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-8">
        <section className="max-w-3xl">
          <h1 className="font-serif text-4xl leading-tight tracking-tight sm:text-5xl">Full patent analysis</h1>
          <p className="mt-4 text-lg leading-relaxed text-muted">Analyze any patent. Features include:</p>
          <ul className="mt-4 flex flex-wrap gap-2">
            {FEATURES.map((feature) => (
              <li key={feature} className="rounded-full border border-line bg-card px-3 py-1.5 text-sm">
                {feature}
              </li>
            ))}
          </ul>
        </section>

        <form
          className="mt-8 grid gap-4 rounded-2xl border border-line bg-card p-4 sm:p-5"
          onSubmit={(event) => {
            event.preventDefault();
            void buildReport({ id: publicationId });
          }}
        >
          <label className="grid gap-2">
            <span className="text-sm font-semibold">Publication number</span>
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                value={publicationId}
                onChange={(event) => setPublicationId(event.target.value)}
                placeholder="US6285999B1"
                className="h-12 flex-1 rounded-xl border border-line bg-paper px-4 font-mono text-base"
              />
              <button
                type="submit"
                disabled={tabs.length >= TAB_LIMIT}
                className="inline-flex h-12 items-center justify-center gap-2 rounded-xl bg-copper px-5 font-semibold text-copper-ink disabled:opacity-60"
              >
                <Search className="size-4" />
                Analyze patent
              </button>
            </div>
          </label>

          <div className="flex flex-wrap gap-2">
            {SAMPLES.map((sample) => (
              <button
                key={sample.id}
                type="button"
                className="h-10 rounded-full border border-line bg-paper px-3 text-sm"
                onClick={() => {
                  setPublicationId(sample.id);
                  void buildReport({ id: sample.id });
                }}
              >
                {sample.label}
                <span className="ml-2 font-mono text-muted">{sample.id}</span>
              </button>
            ))}
          </div>

          <div className="grid gap-3 border-t border-line pt-4 sm:grid-cols-[1fr_auto] sm:items-center">
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="flex min-h-16 items-center gap-3 rounded-xl border border-dashed border-line bg-wash px-4 text-left"
            >
              <FileUp className="size-5 shrink-0" />
              <span>
                <span className="block font-semibold">Upload the PDF instead</span>
                <span className="block text-sm text-muted">The file stays in this browser. Scans are read here in the patent's own language, then the printed number is looked up.</span>
              </span>
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="application/pdf,.pdf"
              className="sr-only"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void buildReport({ file });
              }}
            />
          </div>
        </form>

        <div className="mt-6 flex items-end gap-3">
          <div className="flex min-w-0 flex-1 items-end gap-1 overflow-x-auto" role="tablist" aria-label="Open patents">
            {tabs.map((tab) => {
              const selected = tab.id === activeId;
              return (
                <div
                  key={tab.id}
                  className={`flex min-w-32 max-w-56 shrink-0 items-center rounded-t-xl border border-b-0 ${selected ? "border-line bg-card" : "border-transparent bg-wash"}`}
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    onClick={() => setActiveId(tab.id)}
                    className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left text-sm font-semibold"
                  >
                    {tab.phase === "working" ? <Loader2 className="size-3.5 shrink-0 animate-spin" /> : null}
                    <span className="truncate">{tab.label}</span>
                  </button>
                  <button
                    type="button"
                    aria-label={`Close ${tab.label}`}
                    onClick={() => closeTab(tab.id)}
                    className="mr-1 grid size-7 shrink-0 place-items-center rounded-md text-muted hover:bg-paper hover:text-ink"
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
              );
            })}
          </div>
          <p className="mb-2 shrink-0 font-mono text-sm text-muted" aria-live="polite">
            {tabs.length}/{TAB_LIMIT}
          </p>
        </div>

        {banner ? <p className="mt-4 rounded-xl border border-line bg-wash px-4 py-3 text-sm leading-relaxed">{banner}</p> : null}

        {active?.phase === "working" ? (
          <p className="mt-6 flex items-center gap-2 text-sm font-semibold">
            <Loader2 className="size-4 animate-spin" />
            {active.status}
          </p>
        ) : null}
        {active?.phase === "error" ? (
          <p className="mt-6 rounded-xl border border-line bg-wash px-4 py-3 text-sm leading-relaxed">{active.error}</p>
        ) : null}
        {active?.report ? <ReportView report={active.report} /> : null}

        <footer className="mt-16 border-t border-line pt-6 text-sm leading-relaxed text-muted">
          PDFs and scans stay on this device. Every page that is read is translated into English when it is not already
          English, including experimental and example sections. The title, abstract, and claims are translated in full.
          Technologies, chemicals, organisms, and materials are taken from those pages, including the examples. A
          plain-language brief follows the translation.
        </footer>
      </main>
    </div>
  );
}

function pageReadingNote(input: {
  pages: number;
  translated: number;
  unavailable: boolean;
  missed: number;
  extra: number;
  examples: number;
  fromRecord: boolean;
  languageLabel: string;
}): string {
  if (input.pages === 0) return "";
  const noun = input.fromRecord ? "section" : "page";
  if (input.unavailable) {
    return "The page-by-page reader was unavailable, so only names that can be recognized in the text are listed.";
  }
  const tail = [
    input.examples > 0
      ? `${input.examples} ${noun}${input.examples === 1 ? "" : "s"} of experimental examples were included.`
      : "",
    input.missed > 0 ? `${input.missed} ${noun}${input.missed === 1 ? "" : "s"} could not be read.` : "",
    input.extra > 0 ? "Later example pages were not all sent." : "",
  ]
    .filter(Boolean)
    .join(" ");
  const lead =
    input.translated > 0
      ? `Translated ${input.translated} ${input.translated === 1 ? noun : `${noun}s`} from ${input.languageLabel}. Technologies, chemicals, organisms, and materials are taken from that English text, including the examples.`
      : `Read ${input.pages} ${input.pages === 1 ? noun : `${noun}s`} and listed the technologies, chemicals, organisms, and materials named there, including any examples.`;
  return [lead, tail].filter(Boolean).join(" ");
}

function ReportView({ report }: { report: Report }) {
  const record = report.record;
  return (
    <article className="mt-10 lg:grid lg:grid-cols-[12.5rem_minmax(0,1fr)] lg:items-start lg:gap-8">
      <nav
        className="mb-6 flex flex-col gap-0.5 lg:sticky lg:top-16 lg:mb-0 lg:max-h-[calc(100vh-5rem)] lg:self-start lg:overflow-y-auto"
        aria-label="Report sections"
      >
        {SECTIONS.map((section, index) => (
          <a key={section.id} href={`#folio-${section.id}`} className="flex items-baseline gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-wash">
            <span className="w-6 shrink-0 font-mono text-xs text-copper">{String(index + 1).padStart(2, "0")}</span>
            {section.title}
          </a>
        ))}
      </nav>

      <div className="min-w-0">
      <h2 className="font-serif text-3xl leading-tight tracking-tight sm:text-4xl">
        {report.displayTitle || record?.title || "Text from the uploaded PDF"}
      </h2>
      {report.frontTranslated && report.originalTitle && report.originalTitle !== report.displayTitle ? (
        <p className="mt-2 text-sm leading-relaxed text-muted">Original title: {report.originalTitle}</p>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-muted">
        {report.frontTranslated ? (
          <span className="rounded-full bg-wash px-3 py-1 font-semibold text-ink">Translated from {report.languageLabel}</span>
        ) : null}
        {record?.status ? <span className="rounded-full bg-wash px-3 py-1 font-semibold text-ink">{record.status}</span> : null}
        {record ? (
          <a className="underline decoration-line underline-offset-4" href={patentUrl(record.id)} target="_blank" rel="noreferrer">
            Public record
          </a>
        ) : null}
      </div>
      {report.note ? <p className="mt-3 text-sm text-muted">{report.note}</p> : null}

      <div className="mt-6 grid gap-4">
        <Section n={sectionNumber("numbers")} id="numbers" title="Patent numbers" icon={<Hash className="size-4" />}>
          {report.numbers.length > 0 ? (
            <dl className="grid gap-2">
              {report.numbers.map((item) => (
                <div key={`${item.label}-${item.value}`} className="grid grid-cols-[8.5rem_minmax(0,1fr)] gap-3 border-b border-line py-2 sm:grid-cols-[11rem_minmax(0,1fr)]">
                  <dt className="text-sm text-muted">{item.label}</dt>
                  <dd className="break-all font-mono text-sm">
                    <a className="underline decoration-line underline-offset-4" href={documentHref(item.value)} target="_blank" rel="noreferrer">
                      {item.value}
                    </a>
                  </dd>
                </div>
              ))}
            </dl>
          ) : (
            <Empty>No publication, application, or priority number was found.</Empty>
          )}
        </Section>
        <Section n={sectionNumber("dates")} id="dates" title="Dates" icon={<Calendar className="size-4" />}>
          {record && record.dates.length > 0 ? (
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {record.dates.map((date) => (
                <div key={date.label} className="rounded-xl bg-wash px-3 py-3">
                  <dt className="text-sm text-muted">{date.label}</dt>
                  <dd className="mt-1 font-mono text-sm font-medium">{date.value}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <Empty>Filing, publication, and grant dates were not in the record.</Empty>
          )}
        </Section>
        <Section n={sectionNumber("applicant")} id="applicant" title="Applicant" icon={<Users className="size-4" />}>
          <PartyList items={report.parties.Applicant} empty="No applicant was listed separately from the assignee." />
        </Section>
        <Section n={sectionNumber("inventor")} id="inventor" title="Inventor" icon={<Users className="size-4" />}>
          <InventorTable items={report.parties.Inventor} />
        </Section>
        <Section n={sectionNumber("assignee")} id="assignee" title="Assignee" icon={<Layers className="size-4" />}>
          <PartyList items={report.parties.Assignee} empty="No assignee or patent holder was identified." />
        </Section>
        <Section n={sectionNumber("purpose")} id="purpose" title="Purpose" icon={<ScrollText className="size-4" />}>
          <FacingText label="Abstract" original={report.originalAbstract} english={report.displayAbstract} />
          <div className="mt-5">
            <FacingText label="Background" original={report.originalBackground} english={report.displayBackground} />
          </div>
          <p className="mt-5 text-sm font-semibold text-copper">In plain language</p>
          <ul className="mt-2 grid gap-2">
            {report.plainPoints.map((point) => (
              <li key={point} className="rounded-xl bg-wash px-3 py-2 leading-relaxed">
                {point}
              </li>
            ))}
          </ul>
        </Section>
        <Section n={sectionNumber("claims")} id="claims" title="Claims" icon={<ScrollText className="size-4" />}>
          {report.writtenClaims.length > 0 ? (
            <ol className="grid gap-5">
              {report.writtenClaims.map((claim) => {
                const bullets = claim.notes.filter((note) => note.trim().length > 11 && !USELESS_SUMMARY.test(note)).slice(0, 3);
                const original = claim.original || claim.text;
                return (
                  <li key={`${claim.number}-${original.slice(0, 24)}`} className="border-b border-line pb-4">
                    <p className="font-mono text-sm text-copper">{displayClaimNumber(claim.number)}</p>
                    <div className="mt-2 grid gap-3 lg:grid-cols-3">
                      <div>
                        <p className="text-sm font-semibold text-copper">Original</p>
                        <p className="mt-1 leading-relaxed">{original}</p>
                      </div>
                      <div>
                        <p className="text-sm font-semibold text-copper">English</p>
                        <p className="mt-1 leading-relaxed">{claim.text}</p>
                      </div>
                      <div>
                        <p className="text-sm font-semibold text-copper">Summary</p>
                        {bullets.length > 0 ? (
                          <ul className="mt-1 grid gap-2 text-sm leading-snug">
                            {bullets.map((note) => (
                              <li key={note} className="rounded-xl bg-wash px-3 py-2">
                                {note}
                              </li>
                            ))}
                          </ul>
                        ) : null}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ol>
          ) : (
            <Empty>No claims text was available.</Empty>
          )}
        </Section>
        <Section n={sectionNumber("technologies")} id="technologies" title="Technologies" icon={<Search className="size-4" />}>
          <TechList items={report.scan.technologies} empty="No named methods or instruments were found in the text that was read." />
        </Section>
        <Section n={sectionNumber("classes")} id="classes" title="Patent classifications" icon={<Hash className="size-4" />}>
          {report.scan.classes.length > 0 ? (
            <div className="grid gap-2">
              <div className="hidden gap-3 border-b border-line pb-2 text-sm font-semibold text-copper sm:grid sm:grid-cols-[8.5rem_6.5rem_minmax(0,1fr)]">
                <span>Code</span>
                <span>Type</span>
                <span>Meaning</span>
              </div>
              {report.scan.classes.map((item) => (
                <div key={`${item.scheme}-${item.code}`} className="grid gap-1 border-b border-line py-2 sm:grid-cols-[8.5rem_6.5rem_minmax(0,1fr)] sm:gap-3">
                  <a className="font-mono text-sm underline decoration-line underline-offset-4" href={`https://patents.google.com/?q=${encodeURIComponent(item.code)}`} target="_blank" rel="noreferrer">
                    {item.code}
                  </a>
                  <span className="text-sm">{item.scheme}</span>
                  <span>{item.description}</span>
                </div>
              ))}
            </div>
          ) : (
            <Empty>No IPC or CPC classification codes were found.</Empty>
          )}
        </Section>
        <Section n={sectionNumber("chemicals")} id="chemicals" title="Chemicals" icon={<FlaskConical className="size-4" />}>
          {report.scan.chemicals.length > 0 ? (
            <ul className="grid gap-4">
              {report.scan.chemicals.map((item) => (
                <li key={`${item.name}-${item.cas}`} className="border-b border-line pb-3">
                  <p className="font-semibold">{item.name}</p>
                  <p className="mt-1 font-mono text-sm text-muted">
                    {[item.formula && `Formula ${item.formula}`, item.smiles && `SMILES ${item.smiles}`, item.cas && `CAS ${item.cas}`]
                      .filter(Boolean)
                      .join(" · ") || "Name only"}
                  </p>
                  {item.note ? <p className="mt-1 text-sm text-muted">{item.note}</p> : null}
                  <p className="mt-2 flex flex-wrap gap-3 text-sm">
                    {item.links.map((link) => (
                      <a key={link.label} className="underline decoration-line underline-offset-4" href={link.href} target="_blank" rel="noreferrer">
                        {link.label}
                      </a>
                    ))}
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>No named substances, polymers, formulas, or CAS numbers were found in the text that was read.</Empty>
          )}
        </Section>
        <Section n={sectionNumber("organisms")} id="organisms" title="Organisms" icon={<Microscope className="size-4" />}>
          <LinkList items={report.scan.organisms} empty="No species, strains, cell lines, or viruses were identified in the text that was read." />
        </Section>
        <Section n={sectionNumber("citations")} id="citations" title="Cited patents" icon={<Link2 className="size-4" />}>
          {record && record.citations.length > 0 ? (
            <ul className="grid gap-3">
              {record.citations.map((citation) => (
                <li key={citation.number}>
                  <a className="font-mono text-sm underline decoration-line underline-offset-4" href={patentUrl(citation.number)} target="_blank" rel="noreferrer">
                    {citation.number}
                  </a>
                  <p className="leading-snug">{citation.title}</p>
                  {citation.assignee ? <p className="text-sm text-muted">{citation.assignee}</p> : null}
                </li>
              ))}
            </ul>
          ) : (
            <Empty>No backward patent citations were listed.</Empty>
          )}
        </Section>
        <Section n={sectionNumber("office")} id="office" title="Where it was filed" icon={<Globe2 className="size-4" />}>
          {record ? (
            <p className="text-lg">
              <span className="font-semibold">{filingPlace(record.officeCode).country}</span>
              <span className="text-muted"> · {filingPlace(record.officeCode).office}</span>
            </p>
          ) : (
            <Empty>The filing office is taken from the publication number, which this PDF did not yield.</Empty>
          )}
        </Section>
        <Section n={sectionNumber("family")} id="family" title="Filed elsewhere" icon={<Globe2 className="size-4" />}>
          {record && record.family.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[40rem] text-left text-sm">
                <thead>
                  <tr className="border-b border-line text-muted">
                    <th className="py-2 pr-3 font-semibold">Publication</th>
                    <th className="py-2 pr-3 font-semibold">Country</th>
                    <th className="py-2 pr-3 font-semibold">Patent office</th>
                    <th className="py-2 font-semibold">Date</th>
                  </tr>
                </thead>
                <tbody>
                  {record.family.map((member) => {
                    const place = filingPlace(member.country || member.number);
                    return (
                      <tr key={`${member.country}-${member.number}`} className="border-b border-line align-top">
                        <td className="py-2 pr-3 font-mono">
                          {member.number ? (
                            <a className="underline decoration-line underline-offset-4" href={patentUrl(member.number)} target="_blank" rel="noreferrer">
                              {member.number}
                            </a>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="py-2 pr-3">{place.country}</td>
                        <td className="py-2 pr-3">{place.office}</td>
                        <td className="py-2 font-mono">{member.date || "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty>No foreign family members were listed. This publication may exist only in one office.</Empty>
          )}
        </Section>
        <Section n={sectionNumber("related")} id="related" title="Related cases" icon={<Link2 className="size-4" />}>
          {record && record.related.length > 0 ? (
            <ul className="grid gap-3">
              {record.related.map((item) => (
                <li key={`${item.relationship}-${item.number}`}>
                  <p className="text-sm text-muted">{item.relationship}</p>
                  {item.number ? (
                    <a className="font-mono text-sm underline decoration-line underline-offset-4" href={patentUrl(item.number)} target="_blank" rel="noreferrer">
                      {item.number}
                    </a>
                  ) : null}
                  {item.title ? <p>{item.title}</p> : null}
                </li>
              ))}
            </ul>
          ) : (
            <Empty>No continuation, division, or later family application was listed.</Empty>
          )}
        </Section>
        {report.translatedPages.length > 0 ? (
          <details className="rounded-2xl border border-line bg-card p-4 sm:p-5">
            <summary className="cursor-pointer font-serif text-2xl tracking-tight">English text, page by page</summary>
            <div className="mt-4 grid gap-4">
              {report.translatedPages.map((page) => (
                <article key={page.page} className="border-t border-line pt-3">
                  <h4 className="font-mono text-sm text-copper">Page {page.page}</h4>
                  <p className="mt-2 whitespace-pre-wrap leading-relaxed">{page.english}</p>
                </article>
              ))}
            </div>
          </details>
        ) : null}
      </div>
      </div>
    </article>
  );
}

function FacingText({ label, original, english }: { label: string; original: string; english: string }) {
  if (!original.trim() && !english.trim()) return null;
  return (
    <div>
      <p className="text-sm font-semibold text-copper">{label}</p>
      <div className="mt-2 grid gap-4 lg:grid-cols-2">
        <div>
          <p className="text-sm font-semibold text-muted">Original</p>
          <p className="mt-1 leading-relaxed">{original}</p>
        </div>
        <div>
          <p className="text-sm font-semibold text-muted">English</p>
          <p className="mt-1 leading-relaxed">{english}</p>
        </div>
      </div>
    </div>
  );
}

function sectionNumber(id: string): number {
  return SECTIONS.findIndex((section) => section.id === id) + 1;
}

function Section({ n, id, title, icon, children }: { n: number; id: string; title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <section id={`folio-${id}`} className="scroll-mt-24 rounded-2xl border border-line bg-card p-4 sm:p-5">
      <h3 className="flex items-center gap-2 font-serif text-2xl tracking-tight">
        <span className="font-mono text-sm text-copper">{String(n).padStart(2, "0")}</span>
        <span className="text-copper">{icon}</span>
        {title}
      </h3>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function InventorTable({ items }: { items: FaceParty[] }) {
  const rows = inventorColumns(items);
  if (rows.length === 0) return <Empty>No inventor was listed on the public record or the PDF front page.</Empty>;
  return (
    <div className="overflow-x-auto">
      <div className="grid min-w-[22rem] grid-cols-2 gap-x-4 border-b border-line pb-2 text-sm text-muted">
        <span>On the PDF</span>
        <span>Translated</span>
      </div>
      <ul>
        {rows.map((row) => (
          <li key={`${row.printed}-${row.translated}`} className="grid min-w-[22rem] grid-cols-2 gap-x-4 border-b border-line py-2">
            <span>{row.printed}</span>
            <span className="font-semibold">{row.translated}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PartyList({ items, empty }: { items: FaceParty[]; empty: string }) {
  if (items.length === 0) return <Empty>{empty}</Empty>;
  return (
    <ul className="grid gap-2">
      {items.map((item) => (
        <li key={`${item.role}-${item.name}`} className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line py-2">
          <span className="font-semibold">{item.name}</span>
          {item.note ? <span className="text-sm text-muted">{item.note}</span> : null}
        </li>
      ))}
    </ul>
  );
}

function TechList({ items, empty }: { items: { name: string; href: string; note: string }[]; empty: string }) {
  if (items.length === 0) return <Empty>{empty}</Empty>;
  return (
    <ul className="grid gap-2">
      {items.map((item) => {
        const links = encyclopediaLinks(item);
        return (
          <li key={item.name} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-line py-2">
            <span>
              <span className="font-semibold">{item.name}</span>
              {item.note ? <span className="ml-2 text-sm text-muted">{item.note}</span> : null}
            </span>
            <span className="flex gap-3 text-sm">
              <a className="underline decoration-line underline-offset-4" href={links.wiki} target="_blank" rel="noreferrer">
                Wikipedia
              </a>
              <a className="underline decoration-line underline-offset-4" href={links.grok} target="_blank" rel="noreferrer">
                Grokipedia
              </a>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function encyclopediaLinks(item: { name: string; href: string }): { wiki: string; grok: string } {
  const slug = item.href.match(/\/wiki\/([^?#]+)/)?.[1];
  if (slug) {
    const title = decodeURIComponent(slug).replace(/_/g, " ");
    return { wiki: item.href, grok: grokUrl(title) };
  }
  const query = item.name.replace(/^[A-Z0-9/]+\s·\s/, "");
  return { wiki: wikiSearch(query), grok: grokUrl(query) };
}

function LinkList({ items, empty }: { items: { name: string; href: string; note: string }[]; empty: string }) {
  if (items.length === 0) return <Empty>{empty}</Empty>;
  return (
    <ul className="grid gap-2">
      {items.map((item) => (
        <li key={item.name} className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line py-2">
          <a className="font-semibold underline decoration-line underline-offset-4" href={item.href} target="_blank" rel="noreferrer">
            {item.name}
          </a>
          <span className="text-sm text-muted">{item.note}</span>
        </li>
      ))}
    </ul>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="text-muted">{children}</p>;
}
