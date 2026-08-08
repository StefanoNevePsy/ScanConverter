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

          <div>
            <span className="mb-1.5 block text-sm font-medium text-ink">
              Workflow di formattazione
            </span>
            <span className="mb-2 block text-xs text-faint">
              Il workflow ad alta fedeltà conserva il testo OCR come fonte
              canonica e genera il layout senza farlo riscrivere al modello.
            </span>
            <div className="grid grid-cols-2 gap-2">
              <EngineButton
                active={form.formatWorkflow !== 'strict'}
                onClick={() => setForm((f) => ({ ...f, formatWorkflow: 'legacy' }))}
                title="Attuale"
                sub="layout generato dal modello"
              />
              <EngineButton
                active={form.formatWorkflow === 'strict'}
                onClick={() => setForm((f) => ({ ...f, formatWorkflow: 'strict' }))}
                title="Fedeltà massima"
                sub="testo immutabile e verificato"
              />
            </div>
          </div>
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

          {/* Motore OCR (fase 1: immagine → testo). */}
          <div>
            <span className="mb-1.5 block text-sm font-medium text-ink">
              Motore OCR
            </span>
            <span className="mb-2 block text-xs text-faint">
              Chi legge il testo dalle immagini scansionate.
            </span>
            <div className="grid grid-cols-2 gap-2">
              <EngineButton
                active={form.ocrEngine !== 'gemini'}
                onClick={() => setForm((f) => ({ ...f, ocrEngine: 'nvidia' }))}
                title="NVIDIA Nemotron-Parse"
                sub="estrae anche figure e tabelle"
              />
              <EngineButton
                active={form.ocrEngine === 'gemini'}
                onClick={() => setForm((f) => ({ ...f, ocrEngine: 'gemini' }))}
                title="Google Gemini"
                sub="più robusto su scansioni pessime"
              />
            </div>
            {form.ocrEngine === 'gemini' && (
              <div className="mt-3">
                <ModelSelect
                  label="Modello Gemini per OCR"
                  hint="Legge l’immagine intera; non separa le figure per la revisione."
                  value={form.geminiOcrModel}
                  onChange={update('geminiOcrModel')}
                  options={gemini.list}
                  loading={gemini.loading}
                  error={gemini.error}
                  onRefresh={() => fetchGemini(form.googleApiKey)}
                  placeholder={DEFAULTS.geminiOcrModel}
                  listId="dl-gemini-ocr"
                />
              </div>
            )}
            {form.formatWorkflow === 'strict' && (
              <div className="mt-3">
                <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border bg-surface-2 px-3 py-2.5">
                  <input
                    type="checkbox"
                    checked={!!form.compareOcr}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, compareOcr: e.target.checked }))
                    }
                    className="mt-0.5 accent-primary"
                  />
                  <span>
                    <span className="block text-sm font-medium text-ink">
                      Confronta con un secondo OCR
                    </span>
                    <span className="block text-xs text-faint">
                      Esegue anche l’altro motore (Gemini/NVIDIA) sulla stessa
                      pagina e segnala le divergenze. Richiede entrambe le chiavi
                      e raddoppia il costo OCR.
                    </span>
                  </span>
                </label>
              </div>
            )}
            {form.ocrEngine !== 'gemini' && (
              <div className="mt-3">
                <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border bg-surface-2 px-3 py-2.5">
                  <input
                    type="checkbox"
                    checked={!!form.refineTables}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, refineTables: e.target.checked }))
                    }
                    className="mt-0.5 accent-primary"
                  />
                  <span>
                    <span className="block text-sm font-medium text-ink">
                      Ricostruisci le tabelle dall’immagine
                    </span>
                    <span className="block text-xs text-faint">
                      Ritaglia ogni tabella rilevata e la rimanda a Gemini:
                      righe e colonne si recuperano solo dall’immagine, non dal
                      testo appiattito dall’OCR. Una cella inventata viene
                      scartata e si tiene l’originale. Richiede la chiave Google.
                    </span>
                  </span>
                </label>
              </div>
            )}
          </div>

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
          {form.formatWorkflow === 'strict' && (
            <div className="rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-xs text-muted">
              Nel workflow «Fedeltà massima» questo modello sceglie soltanto
              il piano editoriale (font, margini, densità e stili dei blocchi).
              Il testo e il codice Typst sono prodotti localmente e non possono
              essere riscritti dal modello.
            </div>
          )}
          {engineNvidia ? (
            <ModelSelect
              label={form.formatWorkflow === 'strict' ? 'Modello NVIDIA per il piano editoriale' : 'Modello NVIDIA per il Typst'}
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
              label={form.formatWorkflow === 'strict' ? 'Modello Gemini per il piano editoriale' : 'Modello Gemini per il Typst'}
              hint="L'elenco si aggiorna dalla tua chiave Google."
              value={form.geminiTypstModel}
              onChange={update('geminiTypstModel')}
              options={gemini.list}
              loading={gemini.loading}
              error={gemini.error}
              onRefresh={() => fetchGemini(form.googleApiKey)}
              placeholder={DEFAULTS.geminiTypstModel}
              listId="dl-gemini-typst"
            />
          )}

          {/* Correzione conservativa dei refusi OCR durante la strutturazione. */}
          <div>
            <span className="mb-1.5 block text-sm font-medium text-ink">
              Correggi i refusi durante la strutturazione
            </span>
            <span className="mb-2 block text-xs text-faint">
              Il modello che genera il Typst corregge anche accenti («è/e»),
              parole saltate e virgolette, usando il contesto della frase. In
              caso di dubbio lascia il testo invariato. Non intacca la verifica
              di fedeltà (che ignora gli accenti).
            </span>
            <div className="grid grid-cols-2 gap-2">
              <EngineButton
                active={form.fixTypos !== false}
                onClick={() => setForm((f) => ({ ...f, fixTypos: true }))}
                title="Attiva"
                sub="consigliato su scansioni pessime"
              />
              <EngineButton
                active={form.fixTypos === false}
                onClick={() => setForm((f) => ({ ...f, fixTypos: false }))}
                title="Disattiva"
                sub="trascrizione letterale dell’OCR"
              />
            </div>
          </div>

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
                  value={form.geminiTypstModel}
                  onChange={update('geminiTypstModel')}
                  options={gemini.list}
                  loading={gemini.loading}
                  error={gemini.error}
                  onRefresh={() => fetchGemini(form.googleApiKey)}
                  placeholder={DEFAULTS.geminiTypstModel}
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
              {/* Correzione AI degli errori di compilazione. */}
              <div>
                <span className="mb-1.5 block text-sm font-medium text-ink">
                  Correzioni AI (errori di compilazione)
                </span>
                <span className="mb-2 block text-xs text-faint">
                  Modello forte per il tasto «Correggi con AI»: riceve errore e
                  codice, restituisce sostituzioni puntiformi.
                </span>
                <div className="mb-3 grid grid-cols-2 gap-2">
                  <EngineButton
                    active={form.fixEngine !== 'gemini'}
                    onClick={() => setForm((f) => ({ ...f, fixEngine: 'nvidia' }))}
                    title="Modello NVIDIA"
                    sub="es. DeepSeek, GLM, Qwen"
                  />
                  <EngineButton
                    active={form.fixEngine === 'gemini'}
                    onClick={() => setForm((f) => ({ ...f, fixEngine: 'gemini' }))}
                    title="Google Gemini"
                    sub="es. gemini-pro di livello alto"
                  />
                </div>
                <ModelSelect
                  label="Modello per le correzioni"
                  value={form.fixModel}
                  onChange={update('fixModel')}
                  options={form.fixEngine === 'gemini' ? gemini.list : nvidia.list}
                  loading={form.fixEngine === 'gemini' ? gemini.loading : nvidia.loading}
                  error={form.fixEngine === 'gemini' ? gemini.error : nvidia.error}
                  onRefresh={() =>
                    form.fixEngine === 'gemini'
                      ? fetchGemini(form.googleApiKey)
                      : fetchNvidia(form.nvidiaApiKey, form.nvidiaEndpoint)
                  }
                  placeholder={DEFAULTS.fixModel}
                  listId="dl-fix"
                />
              </div>
              {/* Ingestione dei PDF con testo (vettoriali / già OCR'd). */}
              <div>
                <span className="mb-1.5 block text-sm font-medium text-ink">
                  PDF con testo già presente
                </span>
                <span className="mb-2 block text-xs text-faint">
                  Molti PDF (vettoriali o già passati per un OCR) hanno un layer
                  di testo esatto: usarlo salta l’OCR NVIDIA ed è più fedele, ma
                  non estrae figure/tabelle.
                </span>
                <div className="grid grid-cols-2 gap-2">
                  <EngineButton
                    active={form.pdfTextMode !== 'ocr'}
                    onClick={() => setForm((f) => ({ ...f, pdfTextMode: 'auto' }))}
                    title="Automatico"
                    sub="usa il testo se c’è, altrimenti OCR"
                  />
                  <EngineButton
                    active={form.pdfTextMode === 'ocr'}
                    onClick={() => setForm((f) => ({ ...f, pdfTextMode: 'ocr' }))}
                    title="Sempre OCR"
                    sub="rasterizza e usa Nemotron-Parse"
                  />
                </div>
              </div>
              {/* Risoluzione di rasterizzazione per l'OCR (solo PDF). */}
              <div>
                <span className="mb-1.5 block text-sm font-medium text-ink">
                  Risoluzione OCR (PDF)
                </span>
                <span className="mb-2 block text-xs text-faint">
                  Più alta = OCR più accurato sulle scansioni difficili, ma
                  pagine più pesanti e lente. Non incide sulle immagini caricate
                  direttamente.
                </span>
                <select
                  value={String(form.ocrLongSide ?? DEFAULTS.ocrLongSide)}
                  onChange={(e) => setForm((f) => ({ ...f, ocrLongSide: parseInt(e.target.value, 10) }))}
                  className="w-full rounded-lg border border-border bg-surface-2 px-3.5 py-2.5 text-sm text-ink transition-colors focus:border-primary focus:outline-none"
                >
                  <option value="2048">Standard · ~250 DPI (2048 px)</option>
                  <option value="2600">Alta · ~320 DPI (2600 px)</option>
                  <option value="3200">Molto alta · ~390 DPI (3200 px)</option>
                  <option value="4000">Massima · ~490 DPI (4000 px)</option>
                </select>
              </div>
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

function EngineButton({ active, onClick, title, sub, disabled = false }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={`rounded-lg border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed ${
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
 * Campo modello con elenco a discesa PROPRIO (non il datalist nativo, che su
 * macOS non scorre): l'utente digita per filtrare o sceglie dalla lista, che
 * scorre autonomamente (max-height + overflow) ed è renderizzata nel flusso
 * così il contenitore scrollabile del modale non la taglia. Il bottone ↻
 * ricarica gli id dall'API. Si può sempre digitare un id a mano.
 */
function ModelSelect({ label, hint, value, onChange, options, loading, error, onRefresh, placeholder }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const boxRef = useRef(null);
  const listRef = useRef(null);

  // Chiudi la tendina cliccando fuori dal campo.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => {
      if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const q = (value || '').trim().toLowerCase();
  const filtered = q ? options.filter((m) => m.toLowerCase().includes(q)) : options;
  const list = filtered.length ? filtered : options; // filtro a vuoto → mostra tutto

  const commit = (m) => {
    onChange({ target: { value: m } });
    setOpen(false);
  };

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActive((a) => Math.min(list.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter' && open && list[active]) {
      e.preventDefault();
      commit(list[active]);
    } else if (e.key === 'Escape' && open) {
      e.preventDefault();
      setOpen(false);
    }
  };

  // Tieni l'elemento evidenziato nella parte visibile durante la navigazione.
  useEffect(() => {
    if (open && listRef.current) listRef.current.children[active]?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  return (
    <div className="block" ref={boxRef}>
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
      <div className="relative">
        <input
          value={value}
          onChange={(e) => {
            onChange(e);
            setOpen(true);
            setActive(0);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          className="w-full rounded-lg border border-border bg-surface-2 px-3.5 py-2.5 pr-9 font-mono text-[13px] text-ink placeholder:text-faint transition-colors focus:border-primary focus:outline-none"
          autoComplete="off"
          spellCheck={false}
          role="combobox"
          aria-expanded={open}
        />
        <button
          type="button"
          tabIndex={-1}
          onClick={() => setOpen((v) => !v)}
          aria-label={open ? 'Nascondi elenco' : 'Mostra elenco'}
          className="absolute inset-y-0 right-0 grid w-9 place-items-center text-muted hover:text-ink transition-colors"
        >
          <span className={`text-[10px] transition-transform ${open ? 'rotate-180' : ''}`}>▼</span>
        </button>
      </div>
      {open && list.length > 0 && (
        <ul
          ref={listRef}
          className="mt-1 max-h-52 overflow-y-auto rounded-lg border border-border bg-surface-2 py-1 shadow-lg"
        >
          {list.map((m, i) => (
            <li key={m}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()} // non perdere il focus dell'input
                onMouseEnter={() => setActive(i)}
                onClick={() => commit(m)}
                className={`block w-full truncate px-3 py-1.5 text-left font-mono text-[13px] transition-colors ${
                  i === active ? 'bg-primary-soft text-ink' : 'text-muted hover:text-ink'
                }`}
              >
                {m}
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <span className="mt-1.5 block text-xs text-danger">{error}</span>}
    </div>
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
