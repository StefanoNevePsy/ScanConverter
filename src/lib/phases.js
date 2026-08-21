/*
  Registro delle FASI del documento e del motore che le esegue.

  Prima ogni fase teneva la propria coppia motore/modello in campi sparsi
  (`ocrEngine` + `geminiOcrModel` + `nvidiaModel`, `typstEngine` +
  `geminiTypstModel` + `nvidiaTypstModel`, `fixEngine` + `fixModel`…). Erano
  cinque convenzioni diverse per la stessa decisione, e aggiungere una fase
  significava inventarne una sesta.

  Qui la decisione è una sola, ripetuta per fase: quale motore, e con quale
  modello. Il modello è memorizzato PER MOTORE, non per fase: cambiando motore
  la scelta precedente non viene persa, e tornando indietro si ritrova quella
  di prima. È il comportamento che i campi separati davano per caso; qui è
  esplicito.
*/

/** Ordine di presentazione: è anche l'ordine in cui le fasi si susseguono. */
export const PHASES = ['ocr', 'typst', 'translate', 'proof', 'fix'];

/**
 * Ogni fase dichiara cosa fa e quali motori sa usare.
 *
 * `vision` marca le fasi che leggono immagini: lì «locale» non significa un
 * modello linguistico su Ollama ma il sidecar OCR, che sceglie da sé il
 * proprio modello — per questo `localModel` è false e l'interfaccia mostra
 * l'endpoint invece del nome del modello.
 */
export const PHASE_META = {
  ocr: {
    label: 'Lettura (OCR)',
    hint: 'Dall’immagine di pagina al testo. È l’unica fase che vede la scansione.',
    engines: ['nvidia', 'gemini', 'local'],
    vision: true,
    localModel: false,
  },
  typst: {
    label: 'Struttura Typst',
    hint: 'Dal testo OCR al codice del documento: titoli, elenchi, figure.',
    engines: ['gemini', 'nvidia', 'local'],
  },
  translate: {
    label: 'Traduzione',
    hint: 'Fase separata e facoltativa: produce un secondo documento, non tocca l’originale.',
    engines: ['gemini', 'nvidia', 'local'],
  },
  proof: {
    label: 'Rilettura e ortografia',
    hint: 'Accenti, parole troncate, refusi. È la fase con più chiamate.',
    engines: ['nvidia', 'gemini', 'local'],
  },
  fix: {
    label: 'Riparazione Typst',
    hint: 'Solo quando la correzione deterministica non basta a far compilare.',
    engines: ['nvidia', 'gemini', 'local'],
  },
};

/**
 * Modello preselezionato per ogni coppia fase/motore.
 *
 * Non sono scelte intercambiabili: l'OCR NVIDIA vuole un parser di documenti,
 * la riparazione vuole un modello forte sul codice, la traduzione vuole un
 * modello economico perché le chiamate sono tante. I default riproducono
 * esattamente le combinazioni che erano codificate nei vecchi campi.
 */
export const PHASE_DEFAULTS = {
  ocr: {
    engine: 'nvidia',
    models: { nvidia: 'nvidia/nemotron-parse', gemini: 'gemini-flash-latest', local: '' },
  },
  typst: {
    engine: 'gemini',
    models: { nvidia: 'meta/llama-3.3-70b-instruct', gemini: 'gemini-flash-latest', local: 'qwen3:8b' },
  },
  translate: {
    engine: 'gemini',
    models: { nvidia: 'z-ai/glm-5.2', gemini: 'gemini-flash-lite-latest', local: 'translategemma:4b' },
  },
  proof: {
    engine: 'nvidia',
    models: { nvidia: 'z-ai/glm-5.2', gemini: 'gemini-flash-latest', local: 'qwen3:8b' },
  },
  fix: {
    engine: 'nvidia',
    models: { nvidia: 'z-ai/glm-5.2', gemini: 'gemini-flash-latest', local: 'qwen3:8b' },
  },
};

/** Motori validi in assoluto (una fase può però ammetterne un sottoinsieme). */
export const ENGINES = ['gemini', 'nvidia', 'local'];

export const ENGINE_LABELS = {
  gemini: 'Gemini',
  nvidia: 'NVIDIA',
  local: 'Locale',
};

/** Motore ammesso per la fase, con ripiego sul default della fase. */
export function normalizeEngine(phase, engine) {
  const allowed = PHASE_META[phase]?.engines || ENGINES;
  return allowed.includes(engine) ? engine : PHASE_DEFAULTS[phase].engine;
}

/**
 * Motore e modello effettivi di una fase.
 *
 * Unico punto in cui si risolve la scelta: chiamanti e interfaccia leggono da
 * qui, così non possono divergere.
 *
 * @param {object} settings
 * @param {string} phase
 * @returns {{engine:string, model:string}}
 */
export function phaseConfig(settings, phase) {
  const fallback = PHASE_DEFAULTS[phase] || PHASE_DEFAULTS.typst;
  const stored = settings?.phases?.[phase];
  const engine = normalizeEngine(phase, stored?.engine || fallback.engine);
  const model = String(stored?.models?.[engine] || fallback.models[engine] || '').trim();
  return { engine, model };
}

/** True se una qualsiasi fase fra quelle indicate usa il motore dato. */
export function usesEngine(settings, engine, phases = PHASES) {
  return phases.some((phase) => phaseConfig(settings, phase).engine === engine);
}

/**
 * Quali chiavi API servono davvero con questa configurazione.
 *
 * Non tutte le fasi partono da sole: OCR e struttura sì, sempre; la rilettura
 * solo se la correzione automatica è attiva; riparazione e traduzione solo
 * quando l'utente le chiede, e a quel punto è la fase stessa a segnalare la
 * chiave mancante. Chiedere subito una chiave per una fase che potrebbe non
 * essere mai eseguita bloccherebbe l'app senza motivo.
 *
 * @returns {{google:boolean, nvidia:boolean}}
 */
export function requiredKeys(settings) {
  const automatic = ['ocr', 'typst'];
  if (settings?.formatWorkflow === 'strict' && settings?.fixTypos) automatic.push('proof');
  // Il confronto fra motori OCR interroga entrambi i servizi in rete.
  const bothForComparison = settings?.formatWorkflow === 'strict' && !!settings?.compareOcr;
  // Il riparsing delle tabelle è vision e passa sempre da Gemini.
  const geminiForTables = !!settings?.refineTables;
  return {
    google: bothForComparison || geminiForTables || usesEngine(settings, 'gemini', automatic),
    nvidia: bothForComparison || usesEngine(settings, 'nvidia', automatic),
  };
}

/** Copia delle impostazioni con motore o modello di una fase aggiornati. */
export function withPhase(settings, phase, patch) {
  const current = settings.phases?.[phase] || PHASE_DEFAULTS[phase];
  const engine = patch.engine ? normalizeEngine(phase, patch.engine) : current.engine;
  const models = { ...PHASE_DEFAULTS[phase].models, ...current.models };
  if (patch.model !== undefined) models[patch.engine || current.engine] = patch.model;
  return { ...settings, phases: { ...settings.phases, [phase]: { engine, models } } };
}
