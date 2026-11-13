import type { ChemicalHit, NamedLink, Scan } from "./types";
import { escapeRegExp, wikiSearch, wikiUrl } from "./text";

type Chemical = {
  name: string;
  formula?: string;
  smiles?: string;
  cas?: string;
  wiki: string;
};

type Term = { name: string; wiki: string; acronym?: boolean };

const CHEMICALS: Chemical[] = [
  { name: "acetylsalicylic acid", wiki: "Aspirin", formula: "C9H8O4", smiles: "CC(=O)Oc1ccccc1C(=O)O", cas: "50-78-2" },
  { name: "aspirin", wiki: "Aspirin", formula: "C9H8O4", smiles: "CC(=O)Oc1ccccc1C(=O)O", cas: "50-78-2" },
  { name: "ibuprofen", wiki: "Ibuprofen", formula: "C13H18O2", smiles: "CC(C)Cc1ccc(cc1)C(C)C(=O)O", cas: "15687-27-1" },
  { name: "paracetamol", wiki: "Paracetamol", formula: "C8H9NO2", smiles: "CC(=O)Nc1ccc(O)cc1", cas: "103-90-2" },
  { name: "acetaminophen", wiki: "Paracetamol", formula: "C8H9NO2", smiles: "CC(=O)Nc1ccc(O)cc1", cas: "103-90-2" },
  { name: "caffeine", wiki: "Caffeine", formula: "C8H10N4O2", smiles: "Cn1c(=O)c2c(ncn2C)n(C)c1=O", cas: "58-08-2" },
  { name: "paclitaxel", wiki: "Paclitaxel", formula: "C47H51NO14", cas: "33069-62-4" },
  { name: "doxorubicin", wiki: "Doxorubicin", formula: "C27H29NO11", cas: "23214-92-8" },
  { name: "cisplatin", wiki: "Cisplatin", formula: "Pt(NH3)2Cl2", cas: "15663-27-1" },
  { name: "glucose", wiki: "Glucose", formula: "C6H12O6", cas: "50-99-7" },
  { name: "ethanol", wiki: "Ethanol", formula: "C2H6O", smiles: "CCO", cas: "64-17-5" },
  { name: "methanol", wiki: "Methanol", formula: "CH4O", smiles: "CO", cas: "67-56-1" },
  { name: "acetone", wiki: "Acetone", formula: "C3H6O", smiles: "CC(=O)C", cas: "67-64-1" },
  { name: "ethylene carbonate", wiki: "Ethylene carbonate", formula: "C3H4O3", smiles: "C1COC(=O)O1", cas: "96-49-1" },
  { name: "dimethyl carbonate", wiki: "Dimethyl carbonate", formula: "C3H6O3", smiles: "COC(=O)OC", cas: "616-38-6" },
  { name: "lithium carbonate", wiki: "Lithium carbonate", formula: "Li2CO3", cas: "554-13-2" },
  { name: "lithium cobalt oxide", wiki: "Lithium cobalt oxide", formula: "LiCoO2", cas: "12190-79-3" },
  { name: "lithium iron phosphate", wiki: "Lithium iron phosphate", formula: "LiFePO4", cas: "15365-14-7" },
  { name: "polyethylene glycol", wiki: "Polyethylene glycol", cas: "25322-68-3" },
  { name: "sodium chloride", wiki: "Sodium chloride", formula: "NaCl", cas: "7647-14-5" },
  { name: "magnesium chloride", wiki: "Magnesium chloride", formula: "MgCl2", cas: "7786-30-3" },
  { name: "silicon dioxide", wiki: "Silicon dioxide", formula: "SiO2", cas: "7631-86-9" },
  { name: "titanium dioxide", wiki: "Titanium dioxide", formula: "TiO2", cas: "13463-67-7" },
  { name: "graphene", wiki: "Graphene" },
  { name: "carbon nanotube", wiki: "Carbon nanotube" },
  { name: "heparin", wiki: "Heparin", cas: "9005-49-6" },
  { name: "insulin", wiki: "Insulin" },
  { name: "oligonucleotide", wiki: "Oligonucleotide" },
  { name: "deoxyribonucleotide", wiki: "Nucleotide" },
  { name: "nucleotide", wiki: "Nucleotide" },
  { name: "Taq polymerase", wiki: "Taq polymerase" },
  { name: "DNA polymerase", wiki: "DNA polymerase" },
];

const ORGANISMS: Term[] = [
  { name: "Escherichia coli", wiki: "Escherichia coli" },
  { name: "Saccharomyces cerevisiae", wiki: "Saccharomyces cerevisiae" },
  { name: "Staphylococcus aureus", wiki: "Staphylococcus aureus" },
  { name: "Bacillus subtilis", wiki: "Bacillus subtilis" },
  { name: "Pseudomonas aeruginosa", wiki: "Pseudomonas aeruginosa" },
  { name: "Thermus aquaticus", wiki: "Thermus aquaticus" },
  { name: "Mycobacterium tuberculosis", wiki: "Mycobacterium tuberculosis" },
  { name: "Salmonella enterica", wiki: "Salmonella enterica" },
  { name: "Helicobacter pylori", wiki: "Helicobacter pylori" },
  { name: "Streptococcus pneumoniae", wiki: "Streptococcus pneumoniae" },
  { name: "Lactobacillus acidophilus", wiki: "Lactobacillus acidophilus" },
  { name: "Homo sapiens", wiki: "Human" },
  { name: "Mus musculus", wiki: "House mouse" },
  { name: "Arabidopsis thaliana", wiki: "Arabidopsis thaliana" },
  { name: "Cannabis sativa", wiki: "Cannabis sativa" },
  { name: "Plasmodium falciparum", wiki: "Plasmodium falciparum" },
  { name: "SARS-CoV-2", wiki: "SARS-CoV-2" },
  { name: "HIV-1", wiki: "HIV", acronym: true },
  { name: "influenza virus", wiki: "Influenza virus" },
  { name: "hepatitis B virus", wiki: "Hepatitis B virus" },
  { name: "hepatitis C virus", wiki: "Hepatitis C virus" },
  { name: "human papillomavirus", wiki: "Human papillomavirus" },
  { name: "herpes simplex virus", wiki: "Herpes simplex virus" },
  { name: "adenovirus", wiki: "Adenoviridae" },
  { name: "bacteriophage", wiki: "Bacteriophage" },
];

const EPITHET_STOP = new Set([
  "responsible",
  "method",
  "process",
  "which",
  "wherein",
  "comprising",
  "sequence",
  "nucleic",
  "acid",
  "using",
  "from",
  "with",
  "that",
  "this",
  "into",
  "such",
  "under",
  "after",
  "before",
  "between",
  "within",
  "without",
  "during",
  "about",
  "their",
  "there",
  "these",
  "those",
  "other",
  "first",
  "second",
  "having",
  "being",
  "including",
  "according",
  "following",
  "present",
  "invention",
  "polymerase",
  "virus",
  "bacteria",
  "species",
  "strain",
]);

const GENERA = new Set(ORGANISMS.map((item) => item.name.split(" ")[0]).filter((word) => /^[A-Z][a-z]+$/.test(word)));

const MATERIALS: Term[] = [
  { name: "epoxy resin", wiki: "Epoxy" },
  { name: "carbon fiber", wiki: "Carbon-fiber reinforced polymer" },
  { name: "carbon-fiber", wiki: "Carbon-fiber reinforced polymer" },
  { name: "glass fiber", wiki: "Glass fiber" },
  { name: "fiberglass", wiki: "Fiberglass" },
  { name: "aramid", wiki: "Aramid" },
  { name: "Kevlar", wiki: "Kevlar" },
  { name: "polyurethane", wiki: "Polyurethane" },
  { name: "polycarbonate", wiki: "Polycarbonate" },
  { name: "polyethylene terephthalate", wiki: "Polyethylene terephthalate" },
  { name: "polyvinyl chloride", wiki: "Polyvinyl chloride" },
  { name: "polyethylene", wiki: "Polyethylene" },
  { name: "polypropylene", wiki: "Polypropylene" },
  { name: "stainless steel", wiki: "Stainless steel" },
  { name: "aluminum alloy", wiki: "Aluminium alloy" },
  { name: "concrete", wiki: "Concrete" },
  { name: "Portland cement", wiki: "Portland cement" },
  { name: "ceramic", wiki: "Ceramic" },
  { name: "silicone rubber", wiki: "Silicone rubber" },
  { name: "plywood", wiki: "Plywood" },
  { name: "gypsum", wiki: "Gypsum" },
];

const TECHNOLOGIES: Term[] = [
  { name: "polymerase chain reaction", wiki: "Polymerase chain reaction" },
  { name: "PCR", wiki: "Polymerase chain reaction", acronym: true },
  { name: "CRISPR", wiki: "CRISPR", acronym: true },
  { name: "CRISPR-Cas9", wiki: "CRISPR gene editing" },
  { name: "monoclonal antibody", wiki: "Monoclonal antibody" },
  { name: "mRNA vaccine", wiki: "mRNA vaccine" },
  { name: "lithium-ion battery", wiki: "Lithium-ion battery" },
  { name: "lithium ion battery", wiki: "Lithium-ion battery" },
  { name: "solid-state battery", wiki: "Solid-state battery" },
  { name: "solar cell", wiki: "Solar cell" },
  { name: "photovoltaic", wiki: "Photovoltaics" },
  { name: "perovskite", wiki: "Perovskite solar cell" },
  { name: "fuel cell", wiki: "Fuel cell" },
  { name: "medical device", wiki: "Medical device" },
  { name: "stent", wiki: "Stent" },
  { name: "catheter", wiki: "Catheter" },
  { name: "pacemaker", wiki: "Artificial cardiac pacemaker" },
  { name: "biosensor", wiki: "Biosensor" },
  { name: "immunoassay", wiki: "Immunoassay" },
  { name: "neural network", wiki: "Neural network (machine learning)" },
  { name: "machine learning", wiki: "Machine learning" },
  { name: "semiconductor", wiki: "Semiconductor" },
  { name: "transistor", wiki: "Transistor" },
  { name: "OLED", wiki: "OLED", acronym: true },
  { name: "lidar", wiki: "Lidar" },
  { name: "quantum computing", wiki: "Quantum computing" },
  { name: "microfluidic", wiki: "Microfluidics" },
  { name: "nanoparticle", wiki: "Nanoparticle" },
  { name: "drug delivery", wiki: "Drug delivery" },
  { name: "additive manufacturing", wiki: "3D printing" },
  { name: "carbon capture", wiki: "Carbon capture and storage" },
  { name: "wind turbine", wiki: "Wind turbine" },
];

function mentioned(text: string, term: string, acronym = false): boolean {
  if (acronym) return new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(term)}(?![A-Za-z0-9])`).test(text);
  return new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(term)}(?![A-Za-z0-9])`, "i").test(text);
}

function linkFor(name: string, wiki: string, note = ""): NamedLink {
  return { name, href: wikiUrl(wiki), note };
}

function chemicalLinks(item: Chemical): ChemicalHit["links"] {
  const links = [
    { label: "Wikipedia", href: wikiUrl(item.wiki) },
    { label: "PubChem", href: `https://pubchem.ncbi.nlm.nih.gov/#query=${encodeURIComponent(item.name)}` },
    { label: "ChemSpider", href: `https://www.chemspider.com/Search.aspx?q=${encodeURIComponent(item.name)}` },
  ];
  if (item.cas) links.push({ label: "CAS", href: `https://commonchemistry.cas.org/detail?cas_rn=${item.cas}` });
  return links;
}

function explicitSmiles(text: string): string[] {
  return uniqueStrings(
    [...text.matchAll(/\bSMILES[:\s]+([A-Za-z0-9@+\-\[\]()\\/=#$.]{3,80})/g)].map((match) => match[1] ?? ""),
  );
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export function scanText(text: string, extras?: { classifications?: { code: string; description: string }[]; keywords?: string[] }): Scan {
  const chemicals: ChemicalHit[] = [];
  const seenChem = new Set<string>();
  for (const item of CHEMICALS) {
    if (!mentioned(text, item.name)) continue;
    const key = item.wiki.toLowerCase();
    if (seenChem.has(key)) continue;
    seenChem.add(key);
    chemicals.push({
      name: item.name,
      formula: item.formula ?? "",
      smiles: item.smiles ?? "",
      cas: item.cas ?? "",
      links: chemicalLinks(item),
    });
  }

  for (const cas of uniqueStrings([...text.matchAll(/\b(\d{2,7}-\d{2}-\d)\b/g)].map((match) => match[1] ?? ""))) {
    if (chemicals.some((item) => item.cas === cas)) continue;
    chemicals.push({
      name: `CAS ${cas}`,
      formula: "",
      smiles: "",
      cas,
      links: [
        { label: "CAS", href: `https://commonchemistry.cas.org/detail?cas_rn=${cas}` },
        { label: "PubChem", href: `https://pubchem.ncbi.nlm.nih.gov/#query=${encodeURIComponent(cas)}` },
      ],
    });
  }

  const labeledSmiles = explicitSmiles(text);
  if (labeledSmiles.length > 0 && chemicals.length === 0) {
    for (const smiles of labeledSmiles.slice(0, 6)) {
      chemicals.push({
        name: "SMILES string in the text",
        formula: "",
        smiles,
        cas: "",
        links: [{ label: "PubChem", href: `https://pubchem.ncbi.nlm.nih.gov/#query=${encodeURIComponent(smiles)}` }],
      });
    }
  } else if (labeledSmiles.length > 0) {
    chemicals[0] = { ...chemicals[0], smiles: chemicals[0].smiles || labeledSmiles[0] };
  }

  const organisms: NamedLink[] = [];
  const seenOrg = new Set<string>();
  for (const item of ORGANISMS) {
    if (!mentioned(text, item.name, item.acronym)) continue;
    const key = item.wiki.toLowerCase();
    if (seenOrg.has(key)) continue;
    seenOrg.add(key);
    organisms.push(linkFor(item.name, item.wiki, "Named in the text"));
  }
  for (const match of text.matchAll(/\b([A-Z][a-z]{3,})\s+([a-z]{4,})\b/g)) {
    const genus = match[1] ?? "";
    const species = match[2] ?? "";
    if (!GENERA.has(genus) || EPITHET_STOP.has(species)) continue;
    const name = `${genus} ${species}`;
    if (seenOrg.has(name.toLowerCase())) continue;
    seenOrg.add(name.toLowerCase());
    organisms.push({ name, href: wikiSearch(name), note: "Binomial in the text" });
  }

  const materials = MATERIALS.filter((item) => mentioned(text, item.name)).map((item) =>
    linkFor(item.name, item.wiki, "Named in the text"),
  );

  const technologies: NamedLink[] = [];
  const seenTech = new Set<string>();
  const pushTech = (item: NamedLink) => {
    const key = item.name.toLowerCase();
    if (seenTech.has(key)) return;
    seenTech.add(key);
    technologies.push(item);
  };
  for (const item of TECHNOLOGIES) {
    if (mentioned(text, item.name, item.acronym)) pushTech(linkFor(item.name, item.wiki, "Named in the text"));
  }
  for (const keyword of extras?.keywords ?? []) {
    const known = TECHNOLOGIES.find((item) => item.name.toLowerCase() === keyword.toLowerCase());
    if (known) pushTech(linkFor(known.name, known.wiki, "Indexing keyword"));
  }
  for (const classification of extras?.classifications ?? []) {
    pushTech({
      name: `${classification.code} · ${toTitle(classification.description)}`,
      href: wikiSearch(classification.description),
      note: "Patent classification",
    });
  }

  return {
    technologies: technologies.slice(0, 12),
    chemicals: chemicals.slice(0, 16),
    organisms: organisms.slice(0, 12),
    materials: materials.slice(0, 12),
  };
}

function toTitle(value: string): string {
  const lower = value.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

type LatinHint = { code: string; tess: string; label: string; pattern: string };

const LATIN_HINTS: LatinHint[] = [
  { code: "da", tess: "dan", label: "Danish", pattern: "opfinder|patenthaver|ansøger|ansoeger|fremgangsmåde|fremgangsmade|kendetegnet|opfindelsen" },
  { code: "nl", tess: "nld", label: "Dutch", pattern: "octrooi|aanvrager|uitvinder|werkwijze|gekenmerkt|inrichting|octrooiaanvrage" },
  { code: "de", tess: "deu", label: "German", pattern: "vorrichtung|dadurch|gekennzeichnet|erfinder|anmelder|patentinhaber|anspruch|erfindung" },
  { code: "fr", tess: "fra", label: "French", pattern: "procédé|procede|dispositif|caractérisé|caracterise|inventeur|demandeur|revendication|invention" },
  { code: "es", tess: "spa", label: "Spanish", pattern: "dispositivo|caracterizado|reivindicación|reivindicacion|invención|invencion|solicitante|método|metodo" },
  { code: "pt", tess: "por", label: "Portuguese", pattern: "caracterizado|reivindicação|reivindicacao|dispositivo|invenção|invencao|requerente|compreendendo" },
  { code: "it", tess: "ita", label: "Italian", pattern: "caratterizzato|rivendicazione|dispositivo|invenzione|richiedente|comprendente|procedimento" },
  { code: "sv", tess: "swe", label: "Swedish", pattern: "kännetecknad|kannetecknad|uppfinning|anordning|förfarande|forfarande|patentkrav|sökande|sokande" },
  { code: "no", tess: "nor", label: "Norwegian", pattern: "kjennetegnet|oppfinnelse|anordning|oppfinner|patentkrav|søker|soker" },
  { code: "fi", tess: "fin", label: "Finnish", pattern: "tunnettu|keksintö|keksinto|menetelmä|menetelma|patenttivaatimus|laitteisto" },
  { code: "pl", tess: "pol", label: "Polish", pattern: "znamienny|wynalazek|urządzenie|urzadzenie|zastrzeżenie|zastrzezenie|wynalazca|zgłaszający|zglaszajacy" },
  { code: "ro", tess: "ron", label: "Romanian", pattern: "caracterizat|invenție|inventie|revendicare|dispozitiv|solicitant|procedeul" },
  { code: "tr", tess: "tur", label: "Turkish", pattern: "buluş|bulus|istem|cihaz|yöntem|yontem|başvuru|basvuru|mucit" },
  { code: "lt", tess: "lit", label: "Lithuanian", pattern: "išradimas|isradimas|įrenginys|irenginys|apibrėžtas|apibreztas|išradėjas|isradejas" },
  { code: "lv", tess: "lav", label: "Latvian", pattern: "izgudrojums|ierīce|ierice|paņēmiens|panemiens|pretenzija|izgudrotājs|izgudrotajs" },
  { code: "af", tess: "afr", label: "Afrikaans", pattern: "uitvinding|werkwyse|gekenmerk|toestel|aansoeker|uitvinder" },
  { code: "id", tess: "ind", label: "Indonesian", pattern: "penemuan|perangkat|dicirikan|pemohon|penemu" },
  { code: "ms", tess: "msa", label: "Malay", pattern: "ciptaan|peranti|kaedah|dicirikan|pemohon|pereka" },
  { code: "vi", tess: "vie", label: "Vietnamese", pattern: "sáng chế|sang che|thiết bị|thiet bi|phương pháp|phuong phap" },
  { code: "fil", tess: "fil", label: "Filipino", pattern: "imbensyon|pamamaraan|imbentor" },
  { code: "sw", tess: "swa", label: "Swahili", pattern: "uvumbuzi|kifaa|mvumbuzi" },
  { code: "en", tess: "eng", label: "English", pattern: "comprising|wherein|invention|assignee|applicant|claim|device|method" },
];

function countTerms(sample: string, pattern: string): number {
  const re = new RegExp(`(?:^|[^\\p{L}\\p{N}])(?:${pattern})(?![\\p{L}\\p{N}])`, "giu");
  return sample.match(re)?.length ?? 0;
}

function scriptLanguage(sample: string): { code: string; label: string } | null {
  if (/[\u3040-\u30ff]/.test(sample)) return { code: "ja", label: "Japanese" };
  if (/[\uac00-\ud7af]/.test(sample)) return { code: "ko", label: "Korean" };
  if (/[\u4e00-\u9fff]/.test(sample)) return { code: "zh", label: "Chinese" };
  if (/[\u0590-\u05ff]/.test(sample)) return { code: "he", label: "Hebrew" };
  if (/[\u0600-\u06ff]/.test(sample)) return { code: "ar", label: "Arabic" };
  if (/[\u0e00-\u0e7f]/.test(sample)) return { code: "th", label: "Thai" };
  if (/[\u0900-\u097f]/.test(sample)) return { code: "hi", label: "Hindi" };
  if (/[\u0370-\u03ff]/.test(sample)) return { code: "el", label: "Greek" };
  if (/[\u1780-\u17ff]/.test(sample)) return { code: "km", label: "Khmer" };
  if (/[\u0400-\u04ff]/.test(sample)) {
    if (/[ъьюя]/.test(sample.toLowerCase()) && /[щыэ]/.test(sample.toLowerCase()) === false && /\b(изобретение|устройство|заявител)\b/i.test(sample)) {
      return { code: "bg", label: "Bulgarian" };
    }
    if (/\b(изобретение|заявител|претенц)\b/i.test(sample)) return { code: "bg", label: "Bulgarian" };
    return { code: "ru", label: "Russian" };
  }
  return null;
}

function latinHits(sample: string): { hint: LatinHint; hits: number }[] {
  return LATIN_HINTS.map((hint) => ({ hint, hits: countTerms(sample, hint.pattern) })).sort((a, b) => b.hits - a.hits);
}

export function detectLanguage(text: string): { code: string; label: string } {
  const sample = text.slice(0, 2500);
  const script = scriptLanguage(sample);
  if (script) return script;
  const ranked = latinHits(sample);
  const best = ranked[0];
  if (!best || best.hits < 3) return { code: "en", label: "English" };
  return { code: best.hint.code, label: best.hint.label };
}

export function detectScanLanguage(text: string): { tess: string; label: string } | null {
  const sample = text.slice(0, 2500);
  if (scriptLanguage(sample)) return null;
  const ranked = latinHits(sample);
  const english = ranked.find((item) => item.hint.tess === "eng")?.hits ?? 0;
  const other = ranked.find((item) => item.hint.tess !== "eng");
  if (!other || other.hits < 3 || other.hits < english) return null;
  return { tess: other.hint.tess, label: other.hint.label };
}
