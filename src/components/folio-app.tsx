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
import { describeClasses, lookupPatent } from "@/lib/patent/server-fns";
import { biblioFromPdf, cleanTitle, collectNumbers, collectParties, extractPdfText, findPublicationId, titleFromPdf, type FaceParty } from "@/lib/patent/pdf";
import { notEnglish, scanText } from "@/lib/patent/scan";
import { displayClaimNumber, documentHref, filingPlace, grokUrl, patentUrl, samePassage, wikiSearch } from "@/lib/patent/text";
import type { OfficialRecord, PatentNumber, Scan } from "@/lib/patent/types";

const SAMPLES = [
  { id: "US6285999B1", label: "PageRank" },
  { id: "US4683202A", label: "PCR" },
];

const SECTIONS = [
  { id: "title", title: "Title" },
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
  "English patents only",
  "Patent lookup",
  "Publication IDs",
  "Applicant, inventor, assignee",
  "Claims",
  "Chemical compounds",
  "Organisms",
  "Cited patents",
  "Filing dates",
  "Where it was filed",
  "Related cases",
];

function assertEnglish(sample: string) {
  const label = notEnglish(sample);
  if (label) throw new Error(`FolioPatent only reads English patents. This one is in ${label}.`);
}

type ShownClaim = { number: string; text: string; independent: boolean };

type Report = {
  record: OfficialRecord | null;
  scan: Scan;
  note: string;
  numbers: PatentNumber[];
  claims: ShownClaim[];
  parties: Record<FaceParty["role"], FaceParty[]>;
  title: string;
  abstract: string;
  background: string;
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
      setBanner("Enter a publication number or upload an English patent PDF.");
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
      let id = options.file ? "" : typed;
      if (options.file) {
        const extracted = await extractPdfText(options.file, (message) => {
          if (!liveTabs.current.has(tabId)) return;
          patchTab(tabId, { status: message });
        });
        if (!liveTabs.current.has(tabId)) return;
        pdfText = extracted.text;
        if (!pdfText.trim()) {
          throw new Error("This PDF could not be read. Type the publication number, or upload a clearer English file.");
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
        throw new Error("Enter a publication number or upload an English patent PDF.");
      }

      const pdfBiblio = pdfText ? biblioFromPdf(pdfText) : { abstract: "", background: "", claims: [] };
      const excerptBiblio = record?.excerpt ? biblioFromPdf(record.excerpt) : { abstract: "", background: "", claims: [] };
      const abstract = pdfBiblio.abstract || record?.abstract || excerptBiblio.abstract;
      const backgroundSource = pdfBiblio.background || excerptBiblio.background;
      const background = samePassage(abstract, backgroundSource) ? "" : backgroundSource;
      const title = cleanTitle(titleFromPdf(pdfText) || record?.title || fileLabel || "Uploaded patent");
      const claims: ShownClaim[] =
        pdfBiblio.claims.length > 0
          ? pdfBiblio.claims.map((claim, index) => ({
              number: displayClaimNumber(claim.number || String(index + 1)),
              text: claim.text,
              independent: true,
            }))
          : (record?.claims ?? []).map((claim) => ({
              number: displayClaimNumber(claim.number),
              text: claim.text,
              independent: claim.independent,
            }));
      assertEnglish([pdfText.slice(0, 6000), title, abstract, claims.slice(0, 2).map((claim) => claim.text).join("\n")].join("\n"));
      if (!liveTabs.current.has(tabId)) return;

      patchTab(tabId, { status: "Reading technologies, chemicals, organisms, and classifications…" });
      const scan = scanText([pdfText, record?.excerpt ?? "", abstract, background].filter(Boolean).join("\n").slice(0, 180_000), {
        classifications: record?.classifications,
        keywords: record?.keywords,
      });
      if (scan.classes.length > 0) {
        const described = await describeClasses({ data: { items: scan.classes } }).catch(() => null);
        if (described && described.length > 0) scan.classes = described;
      }
      if (!liveTabs.current.has(tabId)) return;

      patchTab(tabId, {
        phase: "ready",
        status: "",
        label: record?.id || id || fileLabel || "Document",
        report: {
          record,
          scan,
          note: [pdfNote, ...(record?.sourceNotes ?? [])].filter(Boolean).join(" · "),
          numbers: collectNumbers(record, pdfText),
          claims,
          parties: collectParties(record, pdfText),
          title,
          abstract,
          background,
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
          <p className="text-sm font-semibold text-copper">English patents only</p>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-8">
        <section className="max-w-3xl">
          <h1 className="font-serif text-4xl leading-tight tracking-tight sm:text-5xl">Patent analysis</h1>
          <p className="mt-4 text-lg leading-relaxed">
            This app reads English patents only. It does not translate. A patent in any other language is refused.
          </p>
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
                <span className="block font-semibold">Upload an English PDF</span>
                <span className="block text-sm text-muted">The file stays in this browser. Patents that are not in English are not read.</span>
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
          English patents only. FolioPatent does not translate. PDFs stay on this device.
        </footer>
      </main>
    </div>
  );
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
        <h2 className="font-serif text-3xl leading-tight tracking-tight sm:text-4xl">{report.title || record?.title || "Text from the uploaded PDF"}</h2>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-muted">
          <span className="rounded-full bg-wash px-3 py-1 font-semibold text-ink">English</span>
          {record?.status ? <span className="rounded-full bg-wash px-3 py-1 font-semibold text-ink">{record.status}</span> : null}
          {record ? (
            <a className="underline decoration-line underline-offset-4" href={patentUrl(record.id)} target="_blank" rel="noreferrer">
              Public record
            </a>
          ) : null}
        </div>
        {report.note ? <p className="mt-3 text-sm text-muted">{report.note}</p> : null}

        <div className="mt-6 grid gap-4">
          <Section n={sectionNumber("title")} id="title" title="Title" icon={<ScrollText className="size-4" />}>
            <p className="leading-relaxed">{report.title || "No title was found."}</p>
          </Section>
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
            <PartyList items={report.parties.Inventor} empty="No inventor was listed." />
          </Section>
          <Section n={sectionNumber("assignee")} id="assignee" title="Assignee" icon={<Layers className="size-4" />}>
            <PartyList items={report.parties.Assignee} empty="No assignee or patent holder was identified." />
          </Section>
          <Section n={sectionNumber("purpose")} id="purpose" title="Purpose" icon={<ScrollText className="size-4" />}>
            <p className="text-sm font-semibold text-copper">Abstract</p>
            <p className="mt-1 leading-relaxed">{report.abstract || "No abstract was found."}</p>
            <p className="mt-5 text-sm font-semibold text-copper">Background</p>
            <p className="mt-1 leading-relaxed">{report.background || "No background section was found apart from the abstract."}</p>
          </Section>
          <Section n={sectionNumber("claims")} id="claims" title="Claims" icon={<ScrollText className="size-4" />}>
            {report.claims.length > 0 ? (
              <ol className="grid gap-5">
                {report.claims.map((claim) => (
                  <li key={`${claim.number}-${claim.text.slice(0, 24)}`} className="border-b border-line pb-4">
                    <p className="font-mono text-sm text-copper">{displayClaimNumber(claim.number)}</p>
                    <p className="mt-2 leading-relaxed">{claim.text}</p>
                  </li>
                ))}
              </ol>
            ) : (
              <Empty>No claims text was available.</Empty>
            )}
          </Section>
          <Section n={sectionNumber("technologies")} id="technologies" title="Technologies" icon={<Search className="size-4" />}>
            <TechList items={report.scan.technologies} empty="No named methods or instruments were found in the text." />
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
              <Empty>No named substances, polymers, formulas, or CAS numbers were found in the text.</Empty>
            )}
          </Section>
          <Section n={sectionNumber("organisms")} id="organisms" title="Organisms" icon={<Microscope className="size-4" />}>
            <LinkList items={report.scan.organisms} empty="No species, strains, cell lines, or viruses were identified in the text." />
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
        </div>
      </div>
    </article>
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
