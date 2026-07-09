import { useCallback, useEffect, useRef, useState, forwardRef } from 'react';
import { DEFAULTS } from '../lib/storage.js';
import { listGeminiModels } from '../lib/gemini.js';
import { listNvidiaModels } from '../lib/nvidia.js';
import { IconX, IconEye, IconEyeOff, IconKey, IconSpinner, IconRefresh } from './Icons.jsx';

/**
 * Modale di configurazione: chiavi API (NVIDIA, Google), motore per la
 * strutturazione Typst (Gemini o NVIDIA) e i relativi modelli — con elenchi
 * che si auto-aggiornano interrogando le API. Le chiavi restano nel
 * localStorage del browser. Il modale è giustificato qui: è una superficie di
 * configurazione, non un'interruzione del task.
 */
export default function SettingsModal({ open, initial, onClose, onSave }) {
  const [form, setForm] = useState(initial);
  const [showNvidia, setShowNvidia] = useState(false);
  const [showGoogle, setShowGoogle] = useState(false);
  const dialogRef = useRef(null);
  const firstFieldRef = useRef(null);

  // Elenchi modelli auto-aggiornanti. `{ list, loading, error }` per fornitore.
  const [gemini, setGemini] = useState({ list: [], loading: false, error: '' });
  const [nvidia, setNvidia] = useState({ list: [], loading: false, error: '' });

  useEffect(() => {
    if (open) {
      setForm(initial);
      requestAnimationFrame(() => firstFieldRef.current?.focus());
    }
  }, [open, initial]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const fetchGemini = useCallback(async (apiKey) => {
    if (!apiKey?.trim()) {
      setGemini({ list: [], loading: false, error: 'Inserisci la chiave Google.' });
      return;
    }
    setGemini((g) => ({ ...g, loading: true, error: '' }));
    try {
      const list = await listGeminiModels({ apiKey: apiKey.trim() });
      setGemini({ list, loading: false, error: '' });
    } catch (e) {
      setGemini({ list: [], loading: false, error: e.message || 'Errore nel recupero.' });
    }
  }, []);

  const fetchNvidia = useCallback(async (apiKey, endpoint) => {
    if (!apiKey?.trim()) {
      setNvidia({ list: [], loading: false, error: 'Inserisci la chiave NVIDIA.' });
      return;
    }
    setNvidia((n) => ({ ...n, loading: true, error: '' }));
    try {
      const list = await listNvidiaModels({
        apiKey: apiKey.trim(),
        endpoint: endpoint?.trim() || DEFAULTS.nvidiaEndpoint,
      });
      setNvidia({ list, loading: false, error: '' });
    } catch (e) {
      setNvidia({ list: [], loading: false, error: e.message || 'Errore nel recupero.' });
    }
  }, []);

  // All'apertura, prova a popolare gli elenchi con le chiavi già salvate.
  useEffect(() => {
    if (!open) return;
    if (initial.googleApiKey) fetchGemini(initial.googleApiKey);
    if (initial.nvidiaApiKey) fetchNvidia(initial.nvidiaApiKey, initial.nvidiaEndpoint);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  const update = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const setEngine = (typstEngine) => setForm((f) => ({ ...f, typstEngine }));

  const submit = (e) => {
    e.preventDefault();
    onSave(form);
    onClose();
  };

  const engineNvidia = form.typstEngine === 'nvidia';

  return (
    <div
      className="fixed inset-0 grid place-items-center p-4"
      style={{ zIndex: 'var(--z-modal)' }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-title"
    >
      <button
        aria-label="Chiudi"
        onClick={onClose}
        className="fixed inset-0 bg-black/60 backdrop-blur-[2px] cursor-default"
        style={{ zIndex: 'var(--z-backdrop)' }}
        tabIndex={-1}
      />
      <form
        ref={dialogRef}
        onSubmit={submit}
        className="card relative flex max-h-[90vh] w-full max-w-lg flex-col p-6 shadow-2xl"
        style={{ zIndex: 'var(--z-modal)' }}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="grid size-9 place-items-center rounded-lg bg-primary-soft text-primary">
              <IconKey />
            </span>
            <div>
              <h2 id="settings-title" className="text-lg font-semibold text-ink">
                Configurazione API
              </h2>
              <p className="text-sm text-muted">Salvate solo nel tuo browser.</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-muted hover:bg-surface-2 hover:text-ink transition-colors"
            aria-label="Chiudi impostazioni"
          >
            <IconX />
          </button>
        </div>

        <div className="mt-6 space-y-5 overflow-y-auto pr-1">
          <Field
            label="NVIDIA_API_KEY"
            hint="Per l'estrazione OCR con Nemotron-Parse (e, in opzione, per il Typst)."
            ref={firstFieldRef}
            type={showNvidia ? 'text' : 'password'}
            value={form.nvidiaApiKey}
            onChange={update('nvidiaApiKey')}
            onBlur={(e) => fetchNvidia(e.target.value, form.nvidiaEndpoint)}
            placeholder="nvapi-…"
            reveal={showNvidia}
            onToggle={() => setShowNvidia((v) => !v)}
            autoComplete="off"
          />
          <Field
            label="GOOGLE_API_KEY"
            hint="Per la conversione del testo in codice Typst con Gemini."
            type={showGoogle ? 'text' : 'password'}
            value={form.googleApiKey}
            onChange={update('googleApiKey')}
            onBlur={(e) => fetchGemini(e.target.value)}
            placeholder="AIza…"
            reveal={showGoogle}
            onToggle={() => setShowGoogle((v) => !v)}
            autoComplete="off"
          />

          {/* Motore per la strutturazione Typst (fase 2). */}
          <div>
            <span className="mb-1.5 block text-sm font-medium text-ink">
              Motore per il Typst
            </span>
            <span className="mb-2 block text-xs text-faint">
              Chi trasforma il testo estratto in codice Typst.
            </span>
            <div className="grid grid-cols-2 gap-2">
              <EngineButton
                active={!engineNvidia}
                onClick={() => setEngine('gemini')}
                title="Google Gemini"
                sub="veloce, ottimo layout"
              />
              <EngineButton
                active={engineNvidia}
                onClick={() => setEngine('nvidia')}
                title="Modello NVIDIA"
                sub="alternativa se Gemini è limitato"
              />
            </div>
          </div>

          {/* Modello del motore attivo, con elenco auto-aggiornante. */}
          {engineNvidia ? (
            <ModelSelect
              label="Modello NVIDIA per il Typst"
              hint="Consigliato un modello istruct generico (es. llama-3.3-70b-instruct)."
              value={form.nvidiaTypstModel}
              onChange={update('nvidiaTypstModel')}
              options={nvidia.list}
              loading={nvidia.loading}
              error={nvidia.error}
              onRefresh={() => fetchNvidia(form.nvidiaApiKey, form.nvidiaEndpoint)}
              placeholder={DEFAULTS.nvidiaTypstModel}
              listId="dl-nvidia-typst"
            />
          ) : (
            <ModelSelect
              label="Modello Gemini"
              hint="L'elenco si aggiorna dalla tua chiave Google."
              value={form.geminiModel}
              onChange={update('geminiModel')}
              options={gemini.list}
              loading={gemini.loading}
              error={gemini.error}
              onRefresh={() => fetchGemini(form.googleApiKey)}
              placeholder={DEFAULTS.geminiModel}
              listId="dl-gemini"
            />
          )}

          <details className="group rounded-lg border border-border bg-surface-2/60">
            <summary className="cursor-pointer select-none px-3.5 py-2.5 text-sm font-medium text-muted hover:text-ink transition-colors">
              Opzioni avanzate
            </summary>
            <div className="space-y-4 px-3.5 pb-4 pt-1">
              <Field
                label="Endpoint NVIDIA NIM"
                value={form.nvidiaEndpoint}
                onChange={update('nvidiaEndpoint')}
                placeholder={DEFAULTS.nvidiaEndpoint}
                mono
              />
              <ModelSelect
                label="Modello OCR NVIDIA"
                hint="nvidia/nemotron-parse è il modello di parsing consigliato."
                value={form.nvidiaModel}
                onChange={update('nvidiaModel')}
                options={nvidia.list}
                loading={nvidia.loading}
                error={nvidia.error}
                onRefresh={() => fetchNvidia(form.nvidiaApiKey, form.nvidiaEndpoint)}
                placeholder={DEFAULTS.nvidiaModel}
                listId="dl-nvidia-ocr"
              />
              {/* Se il motore Typst è Gemini, offri comunque il campo Gemini qui;
                  se è NVIDIA, offri il modello Gemini di riserva. */}
              {engineNvidia ? (
                <ModelSelect
                  label="Modello Gemini (riserva)"
                  value={form.geminiModel}
                  onChange={update('geminiModel')}
                  options={gemini.list}
                  loading={gemini.loading}
                  error={gemini.error}
                  onRefresh={() => fetchGemini(form.googleApiKey)}
                  placeholder={DEFAULTS.geminiModel}
                  listId="dl-gemini-adv"
                />
              ) : (
                <ModelSelect
                  label="Modello NVIDIA (riserva Typst)"
                  value={form.nvidiaTypstModel}
                  onChange={update('nvidiaTypstModel')}
                  options={nvidia.list}
                  loading={nvidia.loading}
                  error={nvidia.error}
                  onRefresh={() => fetchNvidia(form.nvidiaApiKey, form.nvidiaEndpoint)}
                  placeholder={DEFAULTS.nvidiaTypstModel}
                  listId="dl-nvidia-typst-adv"
                />
              )}
              <div className="grid grid-cols-2 gap-3">
                <Field
                  label="Max pagine PDF"
                  hint="Per caricamento (1–2000)."
                  type="number"
                  min={1}
                  max={2000}
                  value={form.maxPages}
                  onChange={update('maxPages')}
                  placeholder={String(DEFAULTS.maxPages)}
                  mono
                />
                <Field
                  label="Dimensione chunk"
                  hint="Caratteri per richiesta (1000–30000)."
                  type="number"
                  min={1000}
                  max={30000}
                  value={form.chunkSize}
                  onChange={update('chunkSize')}
                  placeholder={String(DEFAULTS.chunkSize)}
                  mono
                />
              </div>
            </div>
          </details>
        </div>

        <div className="mt-7 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-4 py-2 text-sm font-medium text-muted hover:bg-surface-2 hover:text-ink transition-colors"
          >
            Annulla
          </button>
          <button
            type="submit"
            className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-ink hover:bg-primary-strong transition-colors"
          >
            Salva configurazione
          </button>
        </div>
      </form>
    </div>
  );
}

function EngineButton({ active, onClick, title, sub }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-lg border px-3 py-2 text-left transition-colors ${
        active
          ? 'border-primary bg-primary-soft text-ink'
          : 'border-border bg-surface-2 text-muted hover:text-ink'
      }`}
    >
      <span className="block text-sm font-semibold">{title}</span>
      <span className="block text-xs text-faint">{sub}</span>
    </button>
  );
}

/**
 * Campo modello con datalist auto-aggiornante: l'utente può scegliere dagli
 * id recuperati dall'API oppure digitarne uno a mano. Il bottone ↻ ricarica.
 */
function ModelSelect({ label, hint, value, onChange, options, loading, error, onRefresh, placeholder, listId }) {
  return (
    <label className="block">
      <span className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-ink">{label}</span>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted hover:bg-surface-2 hover:text-ink transition-colors disabled:opacity-50"
          aria-label="Aggiorna elenco modelli"
        >
          {loading ? <IconSpinner width={12} height={12} /> : <IconRefresh width={12} height={12} />}
          {loading ? 'Aggiorno…' : options.length ? `${options.length} modelli` : 'Aggiorna'}
        </button>
      </span>
      {hint && <span className="mb-2 block text-xs text-faint">{hint}</span>}
      <input
        list={listId}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        className="w-full rounded-lg border border-border bg-surface-2 px-3.5 py-2.5 font-mono text-[13px] text-ink placeholder:text-faint transition-colors focus:border-primary focus:outline-none"
        autoComplete="off"
        spellCheck={false}
      />
      <datalist id={listId}>
        {options.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
      {error && <span className="mt-1.5 block text-xs text-danger">{error}</span>}
    </label>
  );
}

const Field = forwardRef(function Field(
  { label, hint, reveal, onToggle, mono, ...props },
  ref,
) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium text-ink">{label}</span>
      {hint && <span className="mb-2 block text-xs text-faint">{hint}</span>}
      <div className="relative">
        <input
          ref={ref}
          {...props}
          className={`w-full rounded-lg border border-border bg-surface-2 px-3.5 py-2.5 text-sm text-ink placeholder:text-faint transition-colors focus:border-primary focus:outline-none ${
            mono ? 'font-mono text-[13px]' : ''
          } ${onToggle ? 'pr-11' : ''}`}
        />
        {onToggle && (
          <button
            type="button"
            onClick={onToggle}
            aria-label={reveal ? 'Nascondi' : 'Mostra'}
            className="absolute inset-y-0 right-0 grid w-11 place-items-center text-muted hover:text-ink transition-colors"
          >
            {reveal ? <IconEyeOff /> : <IconEye />}
          </button>
        )}
      </div>
    </label>
  );
});
