/*
  Piano editoriale per il workflow ad alta fedeltà.

  L'LLM può scegliere soltanto valori grafici da enum e stili associati agli
  ID dei blocchi. Non restituisce mai il testo né codice Typst: il renderer
  locale applica il piano alla fonte canonica immutabile.
*/

import { geminiGenerate } from './gemini.js';
import { nvidiaChat } from './nvidia.js';
import { describeStrictBlocks } from './strict.js';

const ALLOWED = {
  font: new Set(['libertinus', 'newcm', 'ptserif', 'ptsans', 'dejavu']),
  headfont: new Set(['body', 'dejavu', 'ptsans', 'newcm', 'libertinus', 'ptserif']),
  paper: new Set(['a4', 'a5', 'letter']),
  textsize: new Set(['small', 'normal', 'large', 'xlarge']),
  orientation: new Set(['portrait', 'landscape']),
  margin: new Set(['wide', 'xwide', 'sym', 'narrow']),
  columns: new Set(['one', 'two', 'three']),
  headingalign: new Set(['left', 'center', 'right']),
  indent: new Set(['none', 'small', 'normal', 'deep']),
  align: new Set(['justify', 'ragged']),
  density: new Set(['airy', 'compact']),
  style: new Set(['quote', 'center', 'compact']),
};

function parseJson(text) {
  const cleaned = String(text || '').replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Il pianificatore non ha restituito JSON valido.');
  return JSON.parse(cleaned.slice(start, end + 1));
}

function validatePlan(value, descriptors) {
  const document = value?.document || {};
  const pick = (key, fallback) => ALLOWED[key].has(document[key]) ? document[key] : fallback;
  const known = new Set(descriptors.filter((b) => b.kind === 'prose').map((b) => b.id));
  const knownHeadings = new Set(descriptors.filter((b) => b.kind === 'heading').map((b) => b.id));
  const seen = new Set();
  const blocks = [];
  for (const item of Array.isArray(value?.blocks) ? value.blocks : []) {
    if (!known.has(item?.id) || seen.has(item.id) || !ALLOWED.style.has(item.style)) continue;
    seen.add(item.id);
    blocks.push({ id: item.id, style: item.style });
  }
  const headings = [];
  const headingSeen = new Set();
  for (const item of Array.isArray(value?.headings) ? value.headings : []) {
    const level = Number(item?.level);
    if (!knownHeadings.has(item?.id) || headingSeen.has(item.id) || !Number.isInteger(level)) continue;
    headingSeen.add(item.id);
    headings.push({ id: item.id, level: Math.max(1, Math.min(4, level)) });
  }
  return {
    document: {
      font: pick('font', 'libertinus'),
      headfont: pick('headfont', 'dejavu'),
      paper: pick('paper', 'a4'),
      textsize: pick('textsize', 'normal'),
      orientation: pick('orientation', 'portrait'),
      margin: pick('margin', 'wide'),
      headingalign: pick('headingalign', 'left'),
      indent: pick('indent', document.noindent ? 'none' : 'normal'),
      align: pick('align', 'justify'),
      density: pick('density', 'airy'),
      // Una colonna preserva ordine di lettura ed ampio spazio annotazioni.
      columns: pick('columns', 'one'),
      extras: document.noindent ? ['noindent'] : [],
    },
    blocks,
    headings,
  };
}

export async function requestStrictLayoutPlan({ settings, markdown, signal }) {
  const descriptors = describeStrictBlocks(markdown);
  // Per libri lunghi basta un campione distribuito per decidere il progetto
  // grafico; gli ID non inclusi mantengono automaticamente lo stile normale.
  const max = 120;
  const sample = descriptors.length <= max
    ? descriptors
    : Array.from({ length: max }, (_, i) => descriptors[Math.floor(i * descriptors.length / max)]);
  const system =
    'Sei un direttore editoriale. Progetta un layout molto leggibile e ' +
    'annotabile per un documento OCR. Non devi trascrivere, correggere, ' +
    'riassumere o restituire alcuna parte del testo. Rispondi solo con JSON.';
  const user =
    'Scegli un progetto grafico usando ESCLUSIVAMENTE questi valori:\n' +
    '- font: libertinus|newcm|ptserif|ptsans|dejavu\n' +
    '- headfont: body|dejavu|ptsans|newcm|libertinus|ptserif\n' +
    '- paper: a4|a5|letter\n' +
    '- textsize: small|normal|large|xlarge\n' +
    '- orientation: portrait|landscape\n' +
    '- margin: wide|xwide|sym|narrow (preferisci wide/xwide per annotazioni)\n' +
    '- columns: one|two|three (preferisci one per libri e annotazioni)\n' +
    '- headingalign: left|center|right\n' +
    '- indent: none|small|normal|deep\n' +
    '- align: justify|ragged\n' +
    '- density: airy|compact\n' +
    '- noindent: boolean\n' +
    'Classifica inoltre TUTTI i blocchi heading disponibili con level 1..4: ' +
    '1=titolo documento/parte, 2=capitolo, 3=sezione, 4=sottosezione. ' +
    'Usa numerazione, posizione e formulazione per mantenere una gerarchia ' +
    'coerente; le testatine ripetute non sono titoli e non dovrebbero essere presenti.\n' +
    'Puoi inoltre assegnare a pochi blocchi di prosa uno stile quote, center ' +
    'o compact usando soltanto il loro id. Non assegnare stili a titoli, ' +
    'tabelle, liste o figure. Non cambiare l’ordine e non inventare ID.\n\n' +
    'BLOCCHI (testo solo per capire la funzione editoriale):\n' +
    JSON.stringify(sample) +
    '\n\nFormato: {"document":{"font":"…","headfont":"…","paper":"…",' +
    '"textsize":"…","orientation":"…","margin":"…","columns":"…",' +
    '"headingalign":"…","indent":"…","align":"…","density":"…","noindent":false},' +
    '"blocks":[{"id":"b-1","style":"quote"}],' +
    '"headings":[{"id":"b-2","level":2}]}';

  let text;
  if (settings.typstEngine === 'nvidia') {
    text = await nvidiaChat({
      apiKey: settings.nvidiaApiKey,
      endpoint: settings.nvidiaEndpoint,
      model: settings.nvidiaTypstModel,
      system,
      user,
      temperature: 0,
      maxTokens: 2048,
      signal,
    });
  } else {
    text = await geminiGenerate({
      apiKey: settings.googleApiKey,
      model: settings.geminiTypstModel,
      system,
      user,
      temperature: 0,
      maxTokens: 2048,
      json: true,
      signal,
    });
  }
  return validatePlan(parseJson(text), descriptors);
}

/** L'LLM classifica soltanto coppie già localizzate; non può modificare testo. */
export async function requestStrictDifferenceReview({ settings, issues, signal }) {
  if (!issues?.length) return [];
  const system =
    'Sei un revisore di fedeltà documentale. Confronta una frase OCR canonica ' +
    'con il passaggio più simile estratto dal PDF. Non riscrivere il testo e ' +
    'non proporre correzioni: classifica soltanto la causa della discrepanza. ' +
    'Rispondi solo con JSON.';
  const user =
    'Per ogni coppia scegli una classe:\n' +
    '- real_omission: il passaggio PDF perde davvero contenuto della fonte;\n' +
    '- extraction_artifact: il contenuto sembra presente ma PDF.js lo spezza, ' +
    'sillaba o legge in ordine diverso;\n' +
    '- uncertain: non è possibile stabilirlo dal confronto.\n' +
    'Fornisci una spiegazione italiana di massimo 25 parole.\n\nCOPPIE:\n' +
    JSON.stringify(issues.map((i) => ({
      id: i.id,
      missing: i.missing,
      canonical: i.source,
      pdf: i.rendered,
    }))) +
    '\n\nFormato: {"items":[{"id":"diff-1","classification":"real_omission",' +
    '"explanation":"…"}]}';
  let text;
  if (settings.typstEngine === 'nvidia') {
    text = await nvidiaChat({
      apiKey: settings.nvidiaApiKey,
      endpoint: settings.nvidiaEndpoint,
      model: settings.nvidiaTypstModel,
      system,
      user,
      temperature: 0,
      maxTokens: 2048,
      signal,
    });
  } else {
    text = await geminiGenerate({
      apiKey: settings.googleApiKey,
      model: settings.geminiTypstModel,
      system,
      user,
      temperature: 0,
      maxTokens: 2048,
      json: true,
      signal,
    });
  }
  const parsed = parseJson(text);
  const allowedIds = new Set(issues.map((i) => i.id));
  const classes = new Set(['real_omission', 'extraction_artifact', 'uncertain']);
  return (Array.isArray(parsed?.items) ? parsed.items : [])
    .filter((i) => allowedIds.has(i?.id) && classes.has(i?.classification))
    .map((i) => ({
      id: i.id,
      classification: i.classification,
      explanation: String(i.explanation || '').slice(0, 240),
    }));
}

/** Rivede e, se necessario, ricostruisce una singola frase OCR/PDF. */
export async function requestStrictPassageRepair({ settings, issue, context, signal }) {
  const system =
    'Sei un revisore di trascrizioni OCR italiane. Devi preservare integralmente ' +
    'il significato e recuperare ogni parola disponibile. Rispondi solo con JSON.';
  const user =
    'Confronta la fonte OCR canonica con il passaggio estratto dal PDF. Scegli:\n' +
    '- artifact: il contenuto è presente e la differenza è solo spezzatura/ordine di estrazione;\n' +
    '- canonical: la fonte OCR è già il passaggio completo da ripristinare;\n' +
    '- proposal: la fonte OCR contiene refusi reali e proponi una versione completa corretta.\n' +
    'Non riassumere, non parafrasare, non abbreviare. Una proposal deve contenere ' +
    'l’intero passaggio, inclusi note, nomi, numeri e parole che nel PDF risultano omessi.\n\n' +
    `CONTESTO OCR:\n${String(context || '').slice(0, 2200)}\n\n` +
    `FONTE OCR CANONICA:\n${issue.source}\n\nPASSAGGIO PDF/TYPST:\n${issue.rendered}\n\n` +
    'Formato: {"choice":"artifact|canonical|proposal","text":"passaggio completo",' +
    '"explanation":"spiegazione breve"}';
  let text;
  if (settings.fixEngine === 'gemini') {
    text = await geminiGenerate({
      apiKey: settings.googleApiKey,
      model: settings.fixModel,
      system,
      user,
      temperature: 0,
      maxTokens: 4096,
      json: true,
      signal,
    });
  } else {
    text = await nvidiaChat({
      apiKey: settings.nvidiaApiKey,
      endpoint: settings.nvidiaEndpoint,
      model: settings.fixModel,
      system,
      user,
      temperature: 0,
      maxTokens: 4096,
      signal,
    });
  }
  const parsed = parseJson(text);
  const choice = ['artifact', 'canonical', 'proposal'].includes(parsed?.choice)
    ? parsed.choice
    : 'canonical';
  const selected = choice === 'proposal' ? String(parsed?.text || '') : issue.source;
  if (choice !== 'artifact' && !selected.trim()) throw new Error('L’IA non ha restituito un passaggio completo.');
  return {
    choice,
    text: selected,
    explanation: String(parsed?.explanation || '').slice(0, 500),
  };
}
