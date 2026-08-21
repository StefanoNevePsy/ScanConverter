import { useCallback, useEffect, useRef, useState, forwardRef } from 'react';
import { DEFAULTS } from '../lib/storage.js';
import { PHASES, PHASE_META, PHASE_DEFAULTS, phaseConfig, withPhase } from '../lib/phases.js';
import { listGeminiModels } from '../lib/gemini.js';
import { listNvidiaModels } from '../lib/nvidia.js';
import { listLocalModels } from '../lib/local.js';
import LocalSetupPanel from './LocalSetupPanel.jsx';
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
  const [local, setLocal] = useState({ list: [], loading: false, error: '' });

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

  // I modelli locali si elencano dallo stesso endpoint della chat: nessuna
  // chiave, e l'utente sceglie fra quelli che ha davvero scaricato invece di
  // ricordarsi a memoria tag come «qwen3:8b».
  const fetchLocal = useCallback(async (endpoint) => {
    setLocal((l) => ({ ...l, loading: true, error: '' }));
    try {
      setLocal({ list: await listLocalModels(endpoint), loading: false, error: '' });
    } catch (e) {
      setLocal({ list: [], loading: false, error: e.message || 'Server locale non raggiungibile.' });
    }
  }, []);

  // All'apertura, prova a popolare gli elenchi con le chiavi già salvate.
  useEffect(() => {
    if (!open) return;
    if (initial.googleApiKey) fetchGemini(initial.googleApiKey);
    if (initial.nvidiaApiKey) fetchNvidia(initial.nvidiaApiKey, initial.nvidiaEndpoint);
    if (PHASES.some((phase) => phaseConfig(initial, phase).engine === 'local')) {
      fetchLocal(initial.localEndpoint);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  const update = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  // Ogni riga di fase modifica soltanto la propria voce; `withPhase` conserva
  // i modelli degli altri motori, così tornare indietro non costa nulla.
  const setPhaseEngine = (phase, engine) => setForm((f) => withPhase(f, phase, { engine }));
  const setPhaseModel = (phase, engine, model) =>
    setForm((f) => withPhase(f, phase, { engine, model }));

  const ocrEngine = phaseConfig(form, 'ocr').engine;
  const usesLocal = PHASES.some((phase) => phaseConfig(form, phase).engine === 'local');

  const providers = {
    gemini: {
      ...gemini,
      refresh: () => fetchGemini(form.googleApiKey),
    },
    nvidia: {
      ...nvidia,
      refresh: () => fetchNvidia(form.nvidiaApiKey, form.nvidiaEndpoint),
    },
    local: { ...local, refresh: () => fetchLocal(form.localEndpoint) },
  };

  const submit = (e) => {
    e.preventDefault();
    onSave(form);
    onClose();
  };

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
        className="card relative flex max-h-[90vh] w-full max-w-2xl flex-col p-6 shadow-2xl sm:p-7"
        style={{ zIndex: 'var(--z-modal)' }}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="grid size-9 place-items-center rounded-lg bg-primary-soft text-primary">
              <IconKey />
            </span>
            <div>
              <h2 id="settings-title" className="text-lg font-semibold text-ink">
                Impostazioni
              </h2>
              <p className="text-sm text-muted">Motori, qualità e chiavi.</p>
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

        <div className="mt-7 space-y-8 overflow-y-auto pr-1">
          {/* Le due chiavi stanno insieme: sono la stessa decisione, e prima
              erano separate da un'impostazione che non c'entra. */}
          <Section title="Chiavi API" note="Restano solo in questo browser.">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="NVIDIA_API_KEY"
                hint="OCR con Nemotron-Parse."
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
                hint="Gemini: OCR e conversione in Typst."
                type={showGoogle ? 'text' : 'password'}
                value={form.googleApiKey}
                onChange={update('googleApiKey')}
                onBlur={(e) => fetchGemini(e.target.value)}
                placeholder="AIza…"
                reveal={showGoogle}
                onToggle={() => setShowGoogle((v) => !v)}
                autoComplete="off"
              />
            </div>
          </Section>

          <Section title="Contesto del documento" note="Facoltativo, ma cambia molto.">
            <label className="block">
              <span className="mb-2 block text-xs leading-relaxed text-faint">
                Una frase su cosa stai digitalizzando. Senza, i modelli
                trattano il lessico specialistico come un refuso: «parenti&shy;ficazione»
                o «ipercircolarità» somigliano a errori di scansione e
                rischiano di essere “corretti”. Dichiarare il dominio li rende
                attesi — e vale per l’ortografia, la rilettura e la conversione.
              </span>
              <textarea
                value={form.docContext || ''}
                onChange={update('docContext')}
                rows={2}
                placeholder="Es. Libro di psicoterapia sistemica (scuola di Milano): cibernetica di secondo ordine, parentificazione, doppio legame, ipotizzazione."
                className="w-full resize-y rounded-lg border border-border bg-surface-2 px-3.5 py-2.5 text-sm leading-relaxed text-ink placeholder:text-faint transition-colors focus:border-primary focus:outline-none"
              />
            </label>
          </Section>

          {/* Una riga per fase: motore e modello. Prima la stessa decisione
              era ripetuta con cinque convenzioni diverse, sparse fra la
              sezione principale e le opzioni avanzate. */}
          <Section
            title="Motori per fase"
            note="Ogni fase è indipendente: locale dove conviene, in rete dove serve."
          >
            {PHASES.map((phase) => (
              <PhaseRow
                key={phase}
                phase={phase}
                form={form}
                providers={providers}
                onEngine={setPhaseEngine}
                onModel={setPhaseModel}
              />
            ))}
          </Section>

          <Section title="Come viene ricostruito il documento">
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

          <div>
            {form.formatWorkflow === 'strict' && (
              <div className="mt-3">
                <label className="flex cursor-pointer items-start gap-3 py-0.5">
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
            {ocrEngine !== 'gemini' && (
              <div className="mt-3">
                <label className="flex cursor-pointer items-start gap-3 py-0.5">
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
                      Righe e colonne si recuperano solo dall’immagine, non dal
                      testo appiattito dall’OCR. Una cella inventata viene
                      scartata. Richiede la chiave Google.
                    </span>
                  </span>
                </label>
              </div>
            )}
          </div>

          {form.formatWorkflow === 'strict' && (
            <div className="rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-xs text-muted">
              Nel workflow «Fedeltà massima» il modello della fase Typst sceglie
              soltanto il piano editoriale (font, margini, densità e stili dei
              blocchi). Il testo e il codice sono prodotti localmente e non
              possono essere riscritti dal modello.
            </div>
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
          </Section>

          {/* Pipeline locale: compare solo se almeno una fase la usa, così non
              ingombra chi lavora solo con le API. I MODELLI ora stanno nelle
              righe di fase; qui restano i due indirizzi, che sono di macchina
              e non di fase. */}
          {usesLocal && (
            <Section title="Pipeline locale" note="Nessuna chiave, nessuna quota.">
              <p className="text-xs leading-relaxed text-faint">
                L’OCR locale riconosce i glifi velocissimo ma non capisce la
                lingua: è il modello locale a rimettere gli accenti e le parole
                troncate, con gli stessi guard usati per Gemini. Serve Ollama in
                esecuzione (e il sidecar OCR, se scegli l’OCR locale).
              </p>
              <LocalSetupPanel
                localEndpoint={form.localEndpoint}
                localOcrEndpoint={form.localOcrEndpoint}
                onApplySetup={(setup) =>
                  setForm((f) => ({
                    ...f,
                    localEndpoint: setup.localEndpoint || f.localEndpoint,
                    localOcrEndpoint: setup.localOcrEndpoint || f.localOcrEndpoint,
                  }))
                }
              />
              <Field
                label="Endpoint LLM locale"
                hint="Ollama espone l’API compatibile OpenAI su questa porta."
                value={form.localEndpoint}
                onChange={update('localEndpoint')}
                placeholder={DEFAULTS.localEndpoint}
                mono
              />
              {ocrEngine === 'local' && (
                <Field
                  label="Endpoint sidecar OCR"
                  hint="Il servizio Python che incapsula Nemotron OCR v2 (vedi tools/local-ocr)."
                  value={form.localOcrEndpoint}
                  onChange={update('localOcrEndpoint')}
                  placeholder={DEFAULTS.localOcrEndpoint}
                  mono
                />
              )}
            </Section>
          )}

          <details className="group border-t border-border pt-5">
            <summary className="cursor-pointer select-none text-sm font-medium text-muted hover:text-ink transition-colors">
              Opzioni avanzate
            </summary>
            <div className="space-y-5 pt-4">
              <Field
                label="Endpoint NVIDIA NIM"
                value={form.nvidiaEndpoint}
                onChange={update('nvidiaEndpoint')}
                placeholder={DEFAULTS.nvidiaEndpoint}
                mono
              />
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
              <Field
                label="Contesto della traduzione"
                hint={
                  'Frasi passate prima e dopo ogni passaggio, come contesto non ' +
                  'traducibile: danno al modello gli antecedenti dei pronomi e la ' +
                  'resa già scelta per i termini ricorrenti (0–6).'
                }
                type="number"
                min={0}
                max={6}
                value={form.translateOverlap}
                onChange={update('translateOverlap')}
                placeholder={String(DEFAULTS.translateOverlap)}
                mono
              />
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

/**
 * Una fase, con il suo motore e il suo modello.
 *
 * Motore e modello stanno sulla stessa riga perché sono una decisione sola:
 * separarli — com'era prima, con i motori in alto e i modelli fra le opzioni
 * avanzate — costringeva a scorrere avanti e indietro per capire cosa stesse
 * effettivamente girando in quella fase.
 */
function PhaseRow({ phase, form, providers, onEngine, onModel }) {
  const meta = PHASE_META[phase];
  const { engine, model } = phaseConfig(form, phase);
  const provider = providers[engine];
  // L'OCR locale è un sidecar che sceglie da sé il proprio modello: qui non
  // c'è niente da scegliere, e fingere il contrario confonderebbe.
  const pickable = engine !== 'local' || meta.localModel !== false;

  return (
    <div className="rounded-lg border border-border bg-surface-2/40 p-3">
      <span className="block text-sm font-medium text-ink">{meta.label}</span>
      <span className="mb-2.5 block text-xs text-faint">{meta.hint}</span>
      {/* Classe statica: Tailwind non vede le stringhe costruite a runtime,
          e una `grid-cols-${n}` dinamica non finirebbe nel CSS generato. */}
      <div className="grid gap-2 sm:grid-cols-3">
        {meta.engines.map((option) => (
          <EngineButton
            key={option}
            active={engine === option}
            onClick={() => onEngine(phase, option)}
            title={ENGINE_TITLES[option]}
            sub={ENGINE_SUBS[phase]?.[option] || ENGINE_SUBS.default[option]}
          />
        ))}
      </div>
      {pickable && (
        <div className="mt-3">
          <ModelSelect
            label={`Modello (${ENGINE_TITLES[engine]})`}
            value={model}
            onChange={(e) => onModel(phase, engine, e.target.value)}
            options={provider.list}
            loading={provider.loading}
            error={provider.error}
            onRefresh={provider.refresh}
            placeholder={PHASE_DEFAULTS[phase].models[engine]}
            listId={`dl-${phase}-${engine}`}
          />
        </div>
      )}
      {!pickable && (
        <p className="mt-2.5 text-xs text-faint">
          Il modello lo sceglie il sidecar: qui basta il suo indirizzo, più sotto.
        </p>
      )}
    </div>
  );
}

const ENGINE_TITLES = {
  gemini: 'Google Gemini',
  nvidia: 'NVIDIA',
  local: 'Locale',
};

// Il sottotitolo dice cosa cambia SCEGLIENDO quel motore per QUELLA fase: è
// l'informazione che serve a decidere, e cambia da fase a fase.
const ENGINE_SUBS = {
  default: {
    gemini: 'in rete, chiave Google',
    nvidia: 'in rete, chiave NVIDIA',
    local: 'sulla tua macchina',
  },
  ocr: {
    nvidia: 'estrae figure e tabelle',
    gemini: 'regge le scansioni peggiori',
    local: 'sidecar sulla tua GPU',
  },
  typst: {
    gemini: 'veloce, buon layout',
    nvidia: 'se Gemini è a quota',
    local: 'senza rete né chiavi',
  },
  translate: {
    gemini: 'economico per molte chiamate',
    nvidia: 'modelli multilingue grandi',
    local: 'nessun limite di quota',
  },
  proof: {
    nvidia: 'modelli forti sul testo',
    gemini: 'buono sull’italiano',
    local: 'la fase con più chiamate',
  },
  fix: {
    nvidia: 'es. GLM, DeepSeek, Qwen',
    gemini: 'un Gemini di livello alto',
    local: 'se il locale sa il Typst',
  },
};

/**
 * Gruppo di impostazioni affini. Prima il modale era una lista piatta di
 * quindici controlli in cui le due chiavi API erano separate da opzioni che
 * non c'entravano: il titolo di sezione, più lo spazio generoso fra gruppi
 * contro quello stretto al loro interno, fa il lavoro che facevano i riquadri
 * annidati senza mettere una scatola dentro un'altra.
 */
function Section({ title, note, children }) {
  return (
    <section>
      <div className="mb-3 flex items-baseline justify-between gap-3 border-b border-border/70 pb-2">
        <h3 className="text-sm font-semibold text-ink">{title}</h3>
        {note && <span className="shrink-0 text-xs text-faint">{note}</span>}
      </div>
      <div className="space-y-5">{children}</div>
    </section>
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
