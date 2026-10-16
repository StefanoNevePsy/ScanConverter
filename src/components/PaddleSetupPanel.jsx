import { useCallback, useEffect, useRef, useState } from 'react';
import { buildCommand, chooseFolder, detectPlatform, probe, readLocalSetup, suggestedRoot } from '../lib/localSetup.js';
import { paddleHealthUrl } from '../lib/paddle.js';
import { pullOllamaModel } from '../lib/ollamaModels.js';

/*
  PaddleOCR-VL: scelta fra servizio online gratuito e installazione locale.

  Sul desktop il pulsante «Scarica e installa» fa tutto da sé (lo script di
  setup gira in background e il suo registro scorre qui sotto), e «Avvia»
  accende il server. Nel browser l'app non può installare programmi: mostra
  il comando esatto da incollare, come per gli altri accessori locali.
*/

const inputClass =
  'w-full rounded-lg border border-border bg-surface-2 px-3.5 py-2.5 font-mono text-[13px] text-ink placeholder:text-faint transition-colors focus:border-primary focus:outline-none';

export default function PaddleSetupPanel({ form, setForm, defaults }) {
  const mode = ['local', 'ollama'].includes(form.paddleMode) ? form.paddleMode : 'online';
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-2 sm:grid-cols-3">
        <ModeButton
          active={mode === 'ollama'}
          onClick={() => setForm((f) => ({ ...f, paddleMode: 'ollama' }))}
          title="Con Ollama"
          sub="sul tuo computer, Windows e Mac"
        />
        <ModeButton
          active={mode === 'online'}
          onClick={() => setForm((f) => ({ ...f, paddleMode: 'online' }))}
          title="Online (gratuito)"
          sub="Baidu AI Studio · serve un token"
        />
        <ModeButton
          active={mode === 'local'}
          onClick={() => setForm((f) => ({ ...f, paddleMode: 'local' }))}
          title="Server Paddle"
          sub="solo Windows/Linux con GPU NVIDIA"
        />
      </div>

      {mode === 'ollama' ? (
        <OllamaFields form={form} set={set} defaults={defaults} />
      ) : mode === 'online' ? (
        <OnlineFields form={form} set={set} />
      ) : (
        <LocalInstall form={form} set={set} setForm={setForm} defaults={defaults} />
      )}
    </div>
  );
}

function OllamaFields({ form, set, defaults }) {
  const model = (form.paddleOllamaModel || defaults.paddleOllamaModel || '').trim();
  const [state, setState] = useState(null);
  const install = async () => {
    setState({ text: 'Avvio download…' });
    try {
      await pullOllamaModel({
        endpoint: form.localEndpoint,
        model,
        onProgress: (text, pct) => setState({ text, pct }),
      });
      setState({ text: 'Installato: puoi usarlo.', pct: 100 });
    } catch (e) {
      setState({ text: e.message, error: true });
    }
  };
  return (
    <>
      <p className="text-xs leading-relaxed text-faint">
        Usa Ollama, lo stesso programma dei modelli locali: funziona con la scheda video su
        Windows e con i chip Apple sul Mac.
      </p>
      <label className="flex cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          checked={form.paddleLayout !== false}
          onChange={(e) => set('paddleLayout')({ target: { value: e.target.checked } })}
          className="mt-0.5 size-4 accent-primary"
        />
        <span>
          <span className="block text-sm font-medium text-ink">Riconosci prima l’impaginazione</span>
          <span className="block text-xs leading-relaxed text-faint">
            Un piccolo modello (65 MB, scaricato una volta) trova titoli, paragrafi, note e figure;
            poi ogni zona viene letta da sola. Gerarchia più affidabile, testatine scartate,
            figure ritagliate. Consigliato.
          </span>
        </span>
      </label>
      <label className="block">
        <span className="mb-1.5 block text-sm font-medium text-ink">Modello</span>
        <span className="mb-2 block text-xs text-faint">
          PaddleOCR-VL legge il testo con più precisione. In alternativa un modello di visione
          generico (es. gemma4:e4b o qwen3.5:9b) marca da sé i titoli, ma è più lento.
        </span>
        <input
          value={form.paddleOllamaModel || ''}
          onChange={set('paddleOllamaModel')}
          placeholder={defaults.paddleOllamaModel}
          spellCheck={false}
          className={inputClass}
        />
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="button-secondary"
          disabled={Boolean(state && !state.error && state.pct !== 100)}
          onClick={install}
        >
          Installa il modello in Ollama
        </button>
        {state && (
          <span className={`text-xs ${state.error ? 'text-warning' : 'text-faint'}`}>{state.text}</span>
        )}
      </div>
      {state && Number.isFinite(state.pct) && !state.error && (
        <div className="h-1.5 overflow-hidden rounded bg-surface-2">
          <div className="h-full bg-primary" style={{ width: `${state.pct}%` }} />
        </div>
      )}
      <span className="block text-xs text-faint">
        Serve Ollama in esecuzione. L’indirizzo di Ollama si cambia nella scheda «Sul computer».
      </span>
    </>
  );
}

function OnlineFields({ form, set }) {
  const [reveal, setReveal] = useState(false);
  return (
    <>
      <ol className="list-decimal space-y-1 pl-5 text-xs leading-relaxed text-faint">
        <li>
          Apri{' '}
          <a
            href="https://aistudio.baidu.com/paddleocr"
            target="_blank"
            rel="noreferrer"
            className="text-primary underline"
          >
            aistudio.baidu.com/paddleocr
          </a>{' '}
          e accedi (registrazione gratuita).
        </li>
        <li>Nella sezione «API» del modello PaddleOCR-VL copia l’indirizzo (API_URL) e il token (TOKEN).</li>
        <li>Incollali qui sotto. Le pagine vengono inviate al servizio di Baidu.</li>
      </ol>
      <label className="block">
        <span className="mb-1.5 block text-sm font-medium text-ink">Indirizzo API</span>
        <input
          value={form.paddleUrl || ''}
          onChange={set('paddleUrl')}
          placeholder="https://…aistudio-app.com/layout-parsing"
          spellCheck={false}
          className={inputClass}
        />
      </label>
      <label className="block">
        <span className="mb-1.5 flex items-center justify-between text-sm font-medium text-ink">
          Token
          <button
            type="button"
            onClick={() => setReveal((v) => !v)}
            className="rounded-md px-1.5 py-0.5 text-xs text-muted hover:bg-surface-2 hover:text-ink"
          >
            {reveal ? 'Nascondi' : 'Mostra'}
          </button>
        </span>
        <input
          type={reveal ? 'text' : 'password'}
          value={form.paddleToken || ''}
          onChange={set('paddleToken')}
          autoComplete="off"
          spellCheck={false}
          className={inputClass}
        />
      </label>
    </>
  );
}

function LocalInstall({ form, set, setForm, defaults }) {
  const bridge = globalThis.window?.scanConverterDesktop;
  const canInstall = typeof bridge?.paddleInstall === 'function';
  const platform = detectPlatform();
  // La cartella scelta si ricorda: prima ripartiva sempre dal suggerimento
  // (D:\…) anche dopo aver installato altrove.
  const [root, setRootState] = useState(() => {
    try {
      return localStorage.getItem('sc.paddleRoot') || suggestedRoot(platform);
    } catch {
      return suggestedRoot(platform);
    }
  });
  const setRoot = (value) => {
    setRootState(value);
    try {
      localStorage.setItem('sc.paddleRoot', value);
    } catch {
      /* solo in memoria */
    }
  };
  const [log, setLog] = useState('');
  const [busy, setBusy] = useState('');
  const [check, setCheck] = useState(null);
  const [copied, setCopied] = useState(false);
  const logRef = useRef(null);

  useEffect(() => {
    let alive = true;
    readLocalSetup().then((found) => {
      let saved = null;
      try {
        saved = localStorage.getItem('sc.paddleRoot');
      } catch {
        /* niente */
      }
      if (alive && !saved && found?.found && found.root) setRoot(found.root);
    });
    const off = bridge?.onPaddleLog?.((line) => setLog((prev) => (prev + line).slice(-20000)));
    return () => {
      alive = false;
      off?.();
    };
  }, [bridge]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  const verify = useCallback(async () => {
    setCheck(null);
    const url = paddleHealthUrl(form.paddleLocalEndpoint);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
      const info = await res.json();
      const gpu = String(info?.device || '').startsWith('gpu');
      setCheck({
        ok: res.ok && gpu,
        detail: gpu
          ? 'Il server risponde e usa la scheda video NVIDIA.'
          : 'Il server risponde ma usa il PROCESSORE, non la scheda video: sarà lentissimo e può fallire. Rilancia «Scarica e installa».',
      });
    } catch {
      setCheck(await probe(url));
    }
  }, [form.paddleLocalEndpoint]);

  const install = async () => {
    setBusy('install');
    setLog('');
    try {
      const res = await bridge.paddleInstall({ root });
      setLog((prev) => prev + (res?.ok ? '\n✔ Installazione completata.\n' : `\n✘ ${res?.error || 'Installazione non riuscita.'}\n`));
      if (res?.ok) setForm((f) => ({ ...f, paddleLocalEndpoint: defaults.paddleLocalEndpoint }));
    } finally {
      setBusy('');
    }
  };

  const start = async () => {
    setBusy('start');
    try {
      const res = await bridge.paddleStart({ root });
      setLog((prev) => prev + `\n${res?.ok ? '▶' : '✘'} ${res?.detail || ''}\n`);
      if (res?.ok) await verify();
    } finally {
      setBusy('');
    }
  };

  const { shell, command, note } = buildCommand({ root, components: ['paddle'], platform });
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      /* il comando resta selezionabile a mano */
    }
  };

  return (
    <>
      <p className="text-xs leading-relaxed text-faint">
        Scarica PaddleOCR-VL (circa 2–3 GB fra programma e modello) e lo esegue sul tuo
        computer. Con una scheda video NVIDIA è veloce; senza funziona lo stesso, ma una pagina
        può richiedere da qualche secondo a un minuto.
      </p>
      {platform === 'macos' && (
        <p className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-ink">
          Sui Mac con chip Apple (M1–M5) PaddleOCR-VL in locale non è supportato ufficialmente e
          la lettura delle pagine può fallire. Su Mac conviene la modalità Online.
        </p>
      )}

      <div>
        <span className="mb-1.5 block text-sm font-medium text-ink">Dove installare</span>
        <div className="flex gap-2">
          <input value={root} onChange={(e) => setRoot(e.target.value)} spellCheck={false} className={inputClass} />
          {typeof bridge?.chooseFolder === 'function' && (
            <button
              type="button"
              className="button-secondary shrink-0"
              onClick={async () => {
                const chosen = await chooseFolder();
                if (chosen) setRoot(chosen);
              }}
            >
              Sfoglia…
            </button>
          )}
        </div>
      </div>

      {canInstall ? (
        <div className="flex flex-wrap gap-2">
          <button type="button" className="button-secondary" disabled={!!busy || !root.trim()} onClick={install}>
            {busy === 'install' ? 'Installazione in corso…' : 'Scarica e installa PaddleOCR'}
          </button>
          <button type="button" className="button-secondary" disabled={!!busy} onClick={start}>
            {busy === 'start' ? 'Avvio…' : 'Avvia il server'}
          </button>
        </div>
      ) : (
        <div>
          <span className="mb-1.5 flex items-center justify-between gap-2">
            <span className="text-sm font-medium text-ink">Comando da eseguire ({shell})</span>
            <button
              type="button"
              onClick={copy}
              className="rounded-md px-1.5 py-0.5 text-xs text-muted hover:bg-surface-2 hover:text-ink"
            >
              {copied ? 'Copiato' : 'Copia'}
            </button>
          </span>
          <pre className="overflow-x-auto rounded-lg border border-border bg-surface-2 px-3 py-2.5 font-mono text-xs text-ink">
            {command}
          </pre>
          <span className="mt-1.5 block text-xs text-faint">
            {note} Nel browser l’app non può installare programmi: nell’app desktop basta un
            pulsante. Dopo l’installazione avvia il server con lo script «start-paddle-ocr» nella
            cartella paddle-ocr.
          </span>
        </div>
      )}

      {log && (
        <pre
          ref={logRef}
          className="max-h-48 overflow-y-auto whitespace-pre-wrap rounded-lg border border-border bg-surface-2 px-3 py-2 font-mono text-[11px] text-muted"
        >
          {log}
        </pre>
      )}

      <label className="block">
        <span className="mb-1.5 block text-sm font-medium text-ink">Indirizzo del server locale</span>
        <input
          value={form.paddleLocalEndpoint || ''}
          onChange={set('paddleLocalEndpoint')}
          placeholder={defaults.paddleLocalEndpoint}
          spellCheck={false}
          className={inputClass}
        />
      </label>

      <div className="flex items-center gap-3 text-xs">
        <button
          type="button"
          onClick={verify}
          className="rounded-md px-1.5 py-0.5 text-muted hover:bg-surface-2 hover:text-ink"
        >
          Prova adesso
        </button>
        {check && (
          <span className={check.ok ? 'text-success' : 'text-warning'}>
            {check.ok ? `● ${check.detail}` : `○ ${check.detail}`}
          </span>
        )}
      </div>
    </>
  );
}

function ModeButton({ active, onClick, title, sub }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-lg border px-3 py-2 text-left transition-colors ${
        active ? 'border-primary bg-primary-soft text-ink' : 'border-border bg-surface-2 text-muted hover:text-ink'
      }`}
    >
      <span className="block text-sm font-semibold">{title}</span>
      <span className="block text-xs text-faint">{sub}</span>
    </button>
  );
}
