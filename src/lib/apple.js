/*
  Motore APPLE: il modello di Apple Intelligence integrato in macOS
  (Foundation Models), interrogato con il comando `fm` di macOS 27.

  Niente da scaricare, niente chiavi, niente rete: gira sul chip del Mac.
  Il browser non può eseguire comandi, quindi passa dall'app desktop
  (electron/main.cjs → `fm respond`). Su Windows e nel browser non esiste.
*/

/** True se l'app desktop sa interrogare il modello Apple. */
export function appleAvailable() {
  return typeof globalThis.window?.scanConverterDesktop?.appleRespond === 'function';
}

/**
 * @param {object} p
 * @param {string} [p.system]
 * @param {string} p.user
 * @param {boolean} [p.json]  chiede una risposta solo JSON
 * @param {string} [p.model]  'system' (sul Mac) oppure 'pcc' (Private Cloud Compute)
 * @param {AbortSignal} [p.signal]
 * @returns {Promise<string>}
 */
export async function appleChat({ system, user, json = false, model = 'system', signal }) {
  const bridge = globalThis.window?.scanConverterDesktop;
  if (typeof bridge?.appleRespond !== 'function') {
    const err = new Error(
      'Il modello Apple è disponibile solo nell’app desktop su un Mac con macOS 27 e Apple Intelligence attiva.',
    );
    err.local = true;
    throw err;
  }
  if (signal?.aborted) throw new DOMException('Annullato', 'AbortError');
  // `fm respond` prende un solo testo: istruzioni e contenuto vanno insieme.
  const prompt = [
    system ? `ISTRUZIONI:\n${system}` : '',
    json ? 'Rispondi SOLO con JSON valido, senza testo prima o dopo.' : '',
    user,
  ]
    .filter(Boolean)
    .join('\n\n');
  const res = await bridge.appleRespond({ prompt, model });
  if (signal?.aborted) throw new DOMException('Annullato', 'AbortError');
  if (!res?.ok) {
    const err = new Error(res?.error || 'Il modello Apple non ha risposto.');
    err.local = true;
    throw err;
  }
  const text = String(res.text || '').replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  if (!text) {
    const err = new Error('Il modello Apple ha restituito una risposta vuota.');
    err.local = true;
    throw err;
  }
  return text;
}
