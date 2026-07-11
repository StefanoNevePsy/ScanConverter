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
  margin: new Set(['wide', 'xwide', 'sym']),
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
  const seen = new Set();
  const blocks = [];
  for (const item of Array.isArray(value?.blocks) ? value.blocks : []) {
    if (!known.has(item?.id) || seen.has(item.id) || !ALLOWED.style.has(item.style)) continue;
    seen.add(item.id);
    blocks.push({ id: item.id, style: item.style });
  }
  return {
    document: {
      font: pick('font', 'libertinus'),
      headfont: pick('headfont', 'dejavu'),
      paper: pick('paper', 'a4'),
      margin: pick('margin', 'wide'),
      align: pick('align', 'justify'),
      density: pick('density', 'airy'),
      // Una colonna preserva ordine di lettura ed ampio spazio annotazioni.
      columns: 'one',
      extras: document.noindent ? ['noindent'] : [],
    },
    blocks,
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
    '- margin: wide|xwide|sym (preferisci wide/xwide per annotazioni)\n' +
    '- align: justify|ragged\n' +
    '- density: airy|compact\n' +
    '- noindent: boolean\n' +
    'Puoi inoltre assegnare a pochi blocchi di prosa uno stile quote, center ' +
    'o compact usando soltanto il loro id. Non assegnare stili a titoli, ' +
    'tabelle, liste o figure. Non cambiare l’ordine e non inventare ID.\n\n' +
    'BLOCCHI (testo solo per capire la funzione editoriale):\n' +
    JSON.stringify(sample) +
    '\n\nFormato: {"document":{"font":"…","headfont":"…","paper":"…",' +
    '"margin":"…","align":"…","density":"…","noindent":false},' +
    '"blocks":[{"id":"b-1","style":"quote"}]}';

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
