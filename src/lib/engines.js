/*
  Dispatcher dei motori testuali.

  Gli stessi tre rami (Gemini / NVIDIA / locale) servivano a cinque chiamate
  diverse — correzione errori di compilazione, rilettura contestuale, correzione
  ortografica — ciascuna con la propria copia della scelta. Concentrarli qui
  significa che aggiungere un motore si fa in un punto solo, e che ogni
  funzione riceve automaticamente la stessa scelta.

  Ogni motore ha il suo campo modello dedicato nelle impostazioni: si può
  puntare Gemini per una fase e un modello locale per un'altra senza che le
  scelte si sovrascrivano a vicenda.
*/

import { nvidiaChat, buildTypstUser } from './nvidia.js';
import { geminiGenerate, SYSTEM_PROMPT, unwrapCodeBlock } from './gemini.js';
import { localChat, DEFAULT_LOCAL_ENDPOINT, DEFAULT_LOCAL_MODEL } from './local.js';
import { phaseConfig } from './phases.js';

/**
 * Blocco di contesto da anteporre ai prompt.
 *
 * Senza, i modelli trattano il lessico specialistico come refuso: «parenti-
 * ficazione», «ipercircolarità», «cibernetica di secondo ordine» somigliano a
 * errori di scansione, e la correzione automatica rischia di appiattirli su
 * parole comuni. Dichiarare il dominio in una frase li rende attesi.
 *
 * @param {object} settings
 * @returns {string} blocco pronto da concatenare, o stringa vuota
 */
export function contextBlock(settings) {
  const note = (settings?.docContext || '').trim();
  if (!note) return '';
  return (
    'CONTESTO DEL DOCUMENTO (usalo per riconoscere il lessico specialistico e ' +
    'NON scambiarlo per un refuso; non aggiunge nulla al testo, serve solo a ' +
    'capirlo): ' +
    note.slice(0, 600)
  );
}

/** Motori ammessi per le fasi testuali. */
export const TEXT_ENGINES = ['gemini', 'nvidia', 'local'];

/**
 * Esegue una richiesta di chat per una FASE, uniformando i parametri.
 *
 * Il chiamante dice cosa sta facendo (`phase`), non con chi: motore e modello
 * escono da `phaseConfig`. `engine`/`model` restano accettati per i pochi casi
 * in cui la scelta è imposta dal contesto e non dall'utente.
 *
 * @param {object} p
 * @param {object} p.settings
 * @param {string} [p.phase]      'ocr'|'typst'|'translate'|'proof'|'fix'
 * @param {'gemini'|'nvidia'|'local'} [p.engine] forza il motore
 * @param {string} [p.model]      forza il modello
 * @param {string} [p.system]
 * @param {string} p.user
 * @param {number} [p.temperature]
 * @param {number} [p.maxTokens]
 * @param {boolean} [p.json]      chiede JSON quando il motore lo supporta
 * @param {AbortSignal} [p.signal]
 * @returns {Promise<string>} testo della risposta
 */
export async function engineChat({
  settings,
  phase,
  engine,
  model,
  system,
  user,
  temperature = 0.1,
  maxTokens = 4096,
  json = false,
  signal,
}) {
  const configured = phase ? phaseConfig(settings, phase) : null;
  const candidate = engine || configured?.engine;
  const chosen = TEXT_ENGINES.includes(candidate) ? candidate : 'nvidia';
  // Il modello configurato vale solo se il motore è quello configurato:
  // forzare il motore senza il modello non deve pescare il modello di un altro.
  const resolved =
    model?.trim() ||
    (configured && configured.engine === chosen ? configured.model : '') ||
    (chosen === 'local' ? DEFAULT_LOCAL_MODEL : '');
  if (!resolved) throw new Error(`Nessun modello configurato per la fase «${phase || chosen}».`);

  if (chosen === 'local') {
    return localChat({
      endpoint: settings.localEndpoint?.trim() || DEFAULT_LOCAL_ENDPOINT,
      model: resolved,
      system,
      user,
      temperature,
      maxTokens,
      json,
      signal,
    });
  }

  if (chosen === 'gemini') {
    return geminiGenerate({
      apiKey: settings.googleApiKey,
      model: resolved,
      system,
      user,
      temperature,
      maxTokens,
      json,
      signal,
    });
  }

  return nvidiaChat({
    apiKey: settings.nvidiaApiKey,
    endpoint: settings.nvidiaEndpoint,
    model: resolved,
    system,
    user,
    temperature,
    maxTokens,
    signal,
  });
}

/**
 * Fase 2 con il modello LOCALE: stesso prompt e stesse istruzioni degli altri
 * motori (`buildTypstUser`), così cambiare modello non cambia il risultato
 * atteso — cambia solo chi lo produce.
 * @returns {Promise<string>} codice Typst
 */
export async function toTypstLocal({
  settings,
  rawText,
  styleHint,
  continuation,
  fidelityNote,
  fixTypos,
  signal,
}) {
  if (!rawText?.trim()) throw new Error('Nessun testo da formattare.');
  const text = await localChat({
    endpoint: settings.localEndpoint?.trim() || DEFAULT_LOCAL_ENDPOINT,
    model: phaseConfig(settings, 'typst').model || DEFAULT_LOCAL_MODEL,
    system: SYSTEM_PROMPT,
    user: buildTypstUser({
      rawText,
      styleHint,
      continuation,
      fidelityNote,
      fixTypos,
      docContext: settings.docContext,
    }),
    temperature: 0.2,
    maxTokens: 8192,
    signal,
  });
  return unwrapCodeBlock(text);
}
