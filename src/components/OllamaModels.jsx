import { useCallback, useEffect, useState } from 'react';
import { listLocalModels } from '../lib/local.js';
import { RECOMMENDED_MODELS, pullOllamaModel } from '../lib/ollamaModels.js';

/*
  Modelli consigliati per Ollama, installabili con un pulsante.

  L'app chiede a Ollama di scaricarli (API /api/pull) e mostra l'avanzamento:
  niente terminale. Dopo l'installazione un clic li assegna alla fase giusta.
*/

export default function OllamaModels({ endpoint, onUse, root }) {
  const bridge = globalThis.window?.scanConverterDesktop;
  const [setup, setSetup] = useState(null);
  const [installed, setInstalled] = useState([]);
  const [progress, setProgress] = useState({});
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try {
      setInstalled(await listLocalModels(endpoint));
      setError('');
    } catch (e) {
      setError('Ollama non risponde: avvialo (o installalo qui sopra) per scaricare i modelli.');
    }
  }, [endpoint]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const has = (name) => installed.some((m) => m === name || m === `${name}:latest`);

  const install = async (name) => {
    setProgress((p) => ({ ...p, [name]: { text: 'Avvio download…' } }));
    try {
      await pullOllamaModel({
        endpoint,
        model: name,
        onProgress: (text, pct) => setProgress((p) => ({ ...p, [name]: { text, pct } })),
      });
      setProgress((p) => ({ ...p, [name]: { text: 'Installato.', pct: 100 } }));
      await refresh();
    } catch (e) {
      setProgress((p) => ({ ...p, [name]: { text: e.message, error: true } }));
    }
  };

  return (
    <div>
      <span className="mb-1.5 block text-sm font-medium text-ink">Modelli consigliati</span>
      <span className="mb-2 block text-xs text-faint">
        Si scaricano con un clic (serve Ollama acceso). Per la rilettura contano velocità e
        italiano; i modelli più piccoli sono i più veloci.
      </span>
      {error && <p className="mb-2 text-xs text-warning">{error}</p>}
      {error && typeof bridge?.ollamaInstall === 'function' && (
        <div className="mb-3 flex flex-col gap-2">
          <button
            type="button"
            className="button-secondary self-start"
            disabled={setup?.busy}
            onClick={async () => {
              setSetup({ busy: true, log: '' });
              const off = bridge.onPaddleLog?.((line) =>
                setSetup((s) => ({ ...s, log: `${s?.log || ''}${line}`.slice(-6000) })));
              try {
                const res = await bridge.ollamaInstall({ root });
                setSetup((s) => ({
                  ...s,
                  busy: false,
                  done: res?.ok,
                  log: `${s?.log || ''}\n${res?.ok ? '✔ Ollama installato.' : `✘ ${res?.error || 'Installazione non riuscita.'}`}`,
                }));
                // Il server impiega qualche secondo ad accendersi.
                for (let i = 0; i < 10 && res?.ok; i++) {
                  await new Promise((r) => setTimeout(r, 2000));
                  try {
                    setInstalled(await listLocalModels(endpoint));
                    setError('');
                    break;
                  } catch {
                    /* non ancora pronto */
                  }
                }
              } finally {
                off?.();
              }
            }}
          >
            {setup?.busy ? 'Installazione di Ollama…' : `Installa Ollama in ${root}`}
          </button>
          {setup?.log && (
            <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-lg border border-border bg-surface-2 px-3 py-2 font-mono text-[11px] text-muted">
              {setup.log}
            </pre>
          )}
        </div>
      )}
      <ul className="flex flex-col gap-2">
        {RECOMMENDED_MODELS.map((m) => {
          const state = progress[m.name];
          const ready = has(m.name);
          return (
            <li key={m.name} className="rounded-lg border border-border bg-surface-2/40 px-3 py-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  <span className="block text-sm text-ink">
                    {m.label} <span className="font-mono text-xs text-faint">{m.name}</span>
                  </span>
                  <span className="block text-xs text-faint">{m.note}</span>
                </span>
                <span className="flex shrink-0 gap-1.5">
                  {ready ? (
                    m.phases.map((phase) => (
                      <button
                        key={phase}
                        type="button"
                        className="button-secondary"
                        onClick={() => onUse?.(phase, m.name)}
                      >
                        {PHASE_BUTTON[phase]}
                      </button>
                    ))
                  ) : (
                    <button
                      type="button"
                      className="button-secondary"
                      disabled={state && !state.error && state.pct !== 100}
                      onClick={() => install(m.name)}
                    >
                      Installa ({m.size})
                    </button>
                  )}
                </span>
              </div>
              {state && !ready && (
                <div className="mt-1.5 text-xs">
                  {Number.isFinite(state.pct) && !state.error && (
                    <div className="mb-1 h-1.5 overflow-hidden rounded bg-surface-2">
                      <div className="h-full bg-primary" style={{ width: `${state.pct}%` }} />
                    </div>
                  )}
                  <span className={state.error ? 'text-warning' : 'text-faint'}>{state.text}</span>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const PHASE_BUTTON = {
  proof: 'Usa per rilettura',
  fix: 'Usa per riparazione',
  translate: 'Usa per traduzione',
  ocr: 'Usa per OCR',
};
