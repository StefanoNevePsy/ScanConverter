import { useCallback, useEffect, useState } from 'react';
import {
  COMPONENTS,
  buildCommand,
  chooseFolder,
  detectPlatform,
  healthUrl,
  modelsUrl,
  probe,
  readLocalSetup,
  suggestedRoot,
} from '../lib/localSetup.js';

/*
  Installazione degli accessori locali.

  Il pannello non finge di installare: dice chiaramente che il comando va
  eseguito fuori, e in cambio non lascia niente da indovinare — il percorso
  scelto è già dentro al comando, e la prova di funzionamento è a un clic.

  L'ordine segue la decisione: prima DOVE (è la domanda che il progetto pone,
  e su un portatile col disco pieno è quella che conta), poi COSA, poi il
  comando, poi la verifica.
*/

export default function LocalSetupPanel({ localEndpoint, localOcrEndpoint, onApplySetup }) {
  const platform = detectPlatform();
  const [root, setRoot] = useState(() => suggestedRoot(platform));
  const [picked, setPicked] = useState(() => COMPONENTS.filter((c) => c.default).map((c) => c.id));
  const [copied, setCopied] = useState(false);
  const [setup, setSetup] = useState(null);
  const [checks, setChecks] = useState(null);
  const [checking, setChecking] = useState(false);

  // Sul desktop lo script lascia un esito: se c'è, il percorso è già quello
  // giusto e non va ridigitato.
  useEffect(() => {
    let alive = true;
    readLocalSetup().then((found) => {
      if (!alive || !found?.found) return;
      setSetup(found);
      if (found.root) setRoot(found.root);
    });
    return () => { alive = false; };
  }, []);

  const { shell, command, note } = buildCommand({ root, components: picked, platform });

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      /* clipboard negata: il comando resta selezionabile a mano */
    }
  }, [command]);

  const browse = useCallback(async () => {
    const chosen = await chooseFolder();
    if (chosen) setRoot(chosen);
  }, []);

  const verify = useCallback(async () => {
    setChecking(true);
    const [llm, ocr] = await Promise.all([
      probe(modelsUrl(localEndpoint)),
      picked.includes('sidecar') ? probe(healthUrl(localOcrEndpoint)) : Promise.resolve(null),
    ]);
    setChecks({ llm, ocr });
    setChecking(false);
  }, [localEndpoint, localOcrEndpoint, picked]);

  const toggle = (id) =>
    setPicked((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs leading-relaxed text-faint">
        L’app non può installare programmi da sé: gira in una finestra del browser. Quello che
        può fare è preparare il comando esatto — con il percorso che scegli qui già dentro — e
        poi verificare che abbia funzionato.
      </p>

      {setup?.found && (
        <div
          className={`rounded-lg border px-3 py-2 text-xs ${
            setup.rootAvailable
              ? 'border-success/30 bg-success/10 text-muted'
              : 'border-warning/40 bg-warning/10 text-ink'
          }`}
        >
          {setup.rootAvailable ? (
            <>Installazione trovata in <code className="font-mono">{setup.root}</code>
              {setup.model ? ` · modello ${setup.model}` : ''}.</>
          ) : (
            <>Gli accessori risultano installati in <code className="font-mono">{setup.root}</code>,
              che ora non è raggiungibile. Se è un disco esterno, collegalo; se ha cambiato
              lettera, rilancia il comando qui sotto con quella nuova.</>
          )}
        </div>
      )}

      <div>
        <span className="mb-1.5 block text-sm font-medium text-ink">Dove installare</span>
        <span className="mb-2 block text-xs text-faint">
          Una cartella sola, anche su un disco esterno: modelli e cache sono la parte pesante e
          non devono stare per forza sul disco di sistema.
        </span>
        <div className="flex gap-2">
          <input
            value={root}
            onChange={(e) => setRoot(e.target.value)}
            spellCheck={false}
            className="w-full rounded-lg border border-border bg-surface-2 px-3.5 py-2.5 font-mono text-sm text-ink transition-colors focus:border-primary focus:outline-none"
            placeholder={suggestedRoot(platform)}
          />
          {typeof globalThis.window?.scanConverterDesktop?.chooseFolder === 'function' && (
            <button type="button" onClick={browse} className="button-secondary shrink-0">
              Sfoglia…
            </button>
          )}
        </div>
      </div>

      <div>
        <span className="mb-2 block text-sm font-medium text-ink">Cosa installare</span>
        <div className="flex flex-col gap-2">
          {COMPONENTS.map((component) => (
            <label key={component.id} className="flex cursor-pointer items-start gap-3 py-0.5">
              <input
                type="checkbox"
                checked={picked.includes(component.id)}
                onChange={() => toggle(component.id)}
                className="mt-0.5 accent-primary"
              />
              <span>
                <span className="block text-sm text-ink">{component.label}</span>
                <span className="block text-xs text-faint">{component.note}</span>
              </span>
            </label>
          ))}
        </div>
      </div>

      <div>
        <span className="mb-1.5 flex items-center justify-between gap-2">
          <span className="text-sm font-medium text-ink">Comando da eseguire ({shell})</span>
          <button
            type="button"
            onClick={copy}
            disabled={!picked.length || !root.trim()}
            className="rounded-md px-1.5 py-0.5 text-xs text-muted hover:bg-surface-2 hover:text-ink transition-colors disabled:opacity-50"
          >
            {copied ? 'Copiato' : 'Copia'}
          </button>
        </span>
        <pre className="overflow-x-auto rounded-lg border border-border bg-surface-2 px-3 py-2.5 font-mono text-xs text-ink">
          {picked.length ? command : 'Scegli almeno un componente.'}
        </pre>
        <span className="mt-1.5 block text-xs text-faint">{note}</span>
      </div>

      <div>
        <span className="mb-1.5 flex items-center justify-between gap-2">
          <span className="text-sm font-medium text-ink">Verifica</span>
          <button
            type="button"
            onClick={verify}
            disabled={checking}
            className="rounded-md px-1.5 py-0.5 text-xs text-muted hover:bg-surface-2 hover:text-ink transition-colors disabled:opacity-50"
          >
            {checking ? 'Controllo…' : 'Prova adesso'}
          </button>
        </span>
        {checks ? (
          <ul className="flex flex-col gap-1 text-xs">
            <CheckLine label="Modello linguistico" result={checks.llm} />
            {checks.ocr && <CheckLine label="Sidecar OCR" result={checks.ocr} />}
          </ul>
        ) : (
          <span className="block text-xs text-faint">
            Dopo l’installazione, riavvia i servizi e premi «Prova adesso»: è l’unico modo di
            sapere che sono davvero in ascolto.
          </span>
        )}
      </div>

      {setup?.found && setup.rootAvailable && onApplySetup && (
        <button
          type="button"
          className="button-secondary w-full"
          onClick={() => onApplySetup(setup)}
        >
          Usa gli indirizzi dell’installazione trovata
        </button>
      )}
    </div>
  );
}

function CheckLine({ label, result }) {
  return (
    <li className="flex items-baseline gap-2">
      <span className={result.ok ? 'text-success' : 'text-warning'}>{result.ok ? '●' : '○'}</span>
      <span className="text-ink">{label}</span>
      <span className="text-faint">{result.detail}</span>
    </li>
  );
}
