import { useCallback, useEffect, useRef, useState, forwardRef } from 'react';
import { DEFAULTS } from '../lib/storage.js';
import { PHASES, PHASE_META, PHASE_DEFAULTS, phaseConfig, withPhase, requiredKeys } from '../lib/phases.js';
import { listGeminiModels } from '../lib/gemini.js';
import { listNvidiaModels, chatCandidates, probeNvidiaModel } from '../lib/nvidia.js';
import { listLocalModels } from '../lib/local.js';
import LocalSetupPanel from './LocalSetupPanel.jsx';
import PaddleSetupPanel from './PaddleSetupPanel.jsx';
import { IconX, IconEye, IconEyeOff, IconSpinner, IconRefresh } from './Icons.jsx';

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
  const [tab, setTab] = useState(() => {
    try {
      return localStorage.getItem('sc.settingsTab') || 'document';
    } catch {
      return 'document';
    }
  });
  const chooseTab = (id) => {
    setTab(id);
    try {
      localStorage.setItem('sc.settingsTab', id);
    } catch {
      /* solo in memoria */
    }
  };
  const firstFieldRef = useRef(null);

  // Elenchi modelli auto-aggiornanti. `{ list, loading, error }` per fornitore.
  const [gemini, setGemini] = useState({ list: [], loading: false, error: '' });
  const [nvidia, setNvidia] = useState({ list: [], loading: false, error: '' });
  // Modelli NVIDIA provati davvero su questo account (salvati fra un'apertura e l'altra).
  const [nvidiaWorking, setNvidiaWorking] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem('sc.nvidiaWorking') || 'null');
    } catch {
      return null;
    }
  });
  const [probe, setProbe] = useState(null);
  const probeAbort = useRef(null);
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

  // Prova i modelli di testo del catalogo uno alla volta, con calma: il
  // servizio gratuito ammette circa 40 richieste al minuto.
  const verifyNvidia = async () => {
    if (probeAbort.current) {
      probeAbort.current.abort();
      return;
    }
    const apiKey = form.nvidiaApiKey?.trim();
    const endpoint = form.nvidiaEndpoint?.trim() || DEFAULTS.nvidiaEndpoint;
    if (!apiKey) {
      setProbe({ message: 'Inserisci prima la chiave NVIDIA.' });
      return;
    }
    const controller = new AbortController();
    probeAbort.current = controller;
    const working = [];
    try {
      const all = nvidia.list.length ? nvidia.list : await listNvidiaModels({ apiKey, endpoint });
      const candidates = chatCandidates(all);
      for (let i = 0; i < candidates.length; i++) {
        setProbe({ running: true, message: `Provo ${i + 1}/${candidates.length}: ${candidates[i]} · ${working.length} funzionanti finora` });
        let res = await probeNvidiaModel({ apiKey, endpoint, model: candidates[i], signal: controller.signal });
        if (res.status === 429) {
          setProbe({ running: true, message: 'Limite di velocità raggiunto: attendo 30 secondi…' });
          await new Promise((r) => setTimeout(r, 30000));
          res = await probeNvidiaModel({ apiKey, endpoint, model: candidates[i], signal: controller.signal });
        }
        if (res.ok) working.push(candidates[i]);
        await new Promise((r) => setTimeout(r, 1600));
      }
      setProbe({ message: `${working.length} modelli funzionano con il tuo account: ora l’elenco mostra solo quelli.` });
    } catch (e) {
      setProbe({
        message: e?.name === 'AbortError'
          ? `Interrotto: ${working.length} modelli funzionanti trovati finora.`
          : e.message,
      });
    } finally {
      probeAbort.current = null;
      if (working.length) {
        setNvidiaWorking(working);
        try {
          localStorage.setItem('sc.nvidiaWorking', JSON.stringify(working));
        } catch {
          /* solo in memoria */
        }
      }
    }
  };

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
      // Se i modelli sono stati provati, si mostrano solo quelli che funzionano.
      list: nvidiaWorking?.length ? nvidiaWorking : nvidia.list,
      // L'OCR usa modelli che la prova (solo testo) non copre: catalogo intero.
      fullList: nvidia.list,
    },
    local: { ...local, refresh: () => fetchLocal(form.localEndpoint) },
  };

  const submit = (e) => {
    e.preventDefault();
    onSave(form);
    onClose();
  };

  const workflow = ['strict', 'scan'].includes(form.formatWorkflow) ? form.formatWorkflow : 'legacy';
  const keys = requiredKeys(form);
  const missingKey = (keys.google && !form.googleApiKey?.trim()) || (keys.nvidia && !form.nvidiaApiKey?.trim());
  const toggle = (k) => (checked) => setForm((f) => ({ ...f, [k]: checked }));
  const correctionPhases = PHASES.filter((p) => p !== 'ocr' && (p !== 'typst' || workflow === 'legacy'));

  return (
    <div
      className="fixed inset-0 grid place-items-center p-3 sm:p-4"
      style={{ zIndex: 'var(--z-modal)' }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-title"
    >
      <button
        aria-label="Chiudi"
        onClick={onClose}
        className="anim-fade fixed inset-0 bg-black/60 cursor-default"
        style={{ zIndex: 'var(--z-backdrop)' }}
        tabIndex={-1}
      />
      <form
        ref={dialogRef}
        onSubmit={submit}
        className="card anim-settle relative flex h-[min(88vh,760px)] w-full max-w-4xl flex-col overflow-hidden shadow-2xl"
        style={{ zIndex: 'var(--z-modal)' }}
      >
        <header className="flex items-center justify-between gap-4 border-b border-border px-5 py-4 sm:px-6">
          <h2 id="settings-title" className="font-display text-xl text-ink">
            Impostazioni
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-muted hover:bg-surface-2 hover:text-ink transition-colors"
            aria-label="Chiudi impostazioni"
          >
            <IconX />
          </button>
        </header>

        <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
          <nav
            aria-label="Sezioni"
            className="flex shrink-0 gap-1 overflow-x-auto border-b border-border p-2 sm:w-48 sm:flex-col sm:overflow-visible sm:border-b-0 sm:border-r sm:p-3"
          >
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => chooseTab(t.id)}
                aria-current={tab === t.id ? 'page' : undefined}
                className={`flex shrink-0 items-center justify-between gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors ${
                  tab === t.id
                    ? 'bg-primary-soft font-semibold text-ink'
                    : 'text-muted hover:bg-surface-2 hover:text-ink'
                }`}
              >
                {t.label}
                {t.id === 'keys' && missingKey && (
                  <span className="size-2 rounded-full bg-danger" aria-label="chiave mancante" />
                )}
              </button>
            ))}
          </nav>

          <div key={tab} className="anim-settle min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-7 sm:py-6">
            {tab === 'document' && (
              <div className="space-y-8">
                <Section title="Che cosa vuoi ottenere">
                  <div className="grid gap-2 sm:grid-cols-3">
                    <EngineButton
                      active={workflow === 'strict'}
                      onClick={() => setForm((f) => ({ ...f, formatWorkflow: 'strict' }))}
                      title="Testo ricomposto"
                      sub="consigliato · testo fedele, impaginato con regole fisse"
                    />
                    <EngineButton
                      active={workflow === 'scan'}
                      onClick={() => setForm((f) => ({ ...f, formatWorkflow: 'scan' }))}
                      title="Scansione ricercabile"
                      sub="le pagine originali, con il testo cercabile sotto"
                    />
                    <EngineButton
                      active={workflow === 'legacy'}
                      onClick={() => setForm((f) => ({ ...f, formatWorkflow: 'legacy' }))}
                      title="Impaginato da un modello"
                      sub="più libero, ma il modello può alterare il testo"
                    />
                  </div>
                </Section>

                <Section title="Contesto del documento" note="Facoltativo, ma cambia molto">
                  <label className="block">
                    <span className="mb-2 block max-w-prose text-xs leading-relaxed text-muted">
                      Una frase su cosa stai digitalizzando. Così i termini specialistici
                      («parentificazione», «ipercircolarità») non vengono scambiati per refusi.
                    </span>
                    <textarea
                      value={form.docContext || ''}
                      onChange={update('docContext')}
                      rows={3}
                      placeholder="Es. Libro di psicoterapia sistemica (scuola di Milano): cibernetica di secondo ordine, parentificazione, doppio legame."
                      className="w-full resize-y rounded-lg border border-border bg-surface-2 px-3.5 py-2.5 text-sm leading-relaxed text-ink placeholder:text-faint transition-colors focus:border-primary focus:outline-none"
                    />
                  </label>
                </Section>

                <Section title="Qualità">
                  <Toggle
                    checked={form.cleanPages !== false}
                    onChange={toggle('cleanPages')}
                    title="Raddrizza le pagine prima della lettura"
                    text="Corregge inclinazione e righe curve vicino alla rilegatura, schiarisce il grigio delle fotocopie."
                  />
                  <Toggle
                    checked={form.fixTypos !== false}
                    onChange={toggle('fixTypos')}
                    title="Rilettura automatica dei refusi"
                    text="Un modello corregge accenti e parole spezzate dall’OCR; nel dubbio lascia il testo com’è. Usa il motore scelto in «Correzione»."
                  />
                  {workflow !== 'scan' && (
                    <Toggle
                      checked={form.useHeadingSize !== false}
                      onChange={toggle('useHeadingSize')}
                      title="Usa la dimensione dei titoli per la gerarchia"
                      text="Confronta ogni titolo con il testo vicino: regge anche le foto storte fatte col telefono."
                    />
                  )}
                  {ocrEngine !== 'gemini' && workflow !== 'scan' && (
                    <Toggle
                      checked={!!form.refineTables}
                      onChange={toggle('refineTables')}
                      title="Ricostruisci le tabelle dall’immagine"
                      text="Righe e colonne si recuperano dall’immagine con Gemini. Richiede la chiave Google."
                    />
                  )}
                  {workflow === 'strict' && (
                    <Toggle
                      checked={!!form.compareOcr}
                      onChange={toggle('compareOcr')}
                      title="Confronta con un secondo OCR"
                      text="Legge ogni pagina anche con l’altro motore in rete e segnala le differenze. Richiede entrambe le chiavi e raddoppia il costo."
                    />
                  )}
                </Section>
              </div>
            )}

            {tab === 'reading' && (
              <div className="space-y-8">
                <Section title="Lettura delle pagine">
                  <PhaseRow phase="ocr" form={form} providers={providers} onEngine={setPhaseEngine} onModel={setPhaseModel} />
                </Section>
                {ocrEngine === 'paddle' && (
                  <Section title="PaddleOCR-VL" note="Stesso modello, tre modi di usarlo">
                    <PaddleSetupPanel form={form} setForm={setForm} defaults={DEFAULTS} />
                  </Section>
                )}
                {ocrEngine === 'local' && (
                  <Section title="Sidecar OCR">
                    <Field
                      label="Indirizzo del sidecar"
                      hint="Il servizio Python con Nemotron OCR v2 (vedi tools/local-ocr)."
                      value={form.localOcrEndpoint}
                      onChange={update('localOcrEndpoint')}
                      placeholder={DEFAULTS.localOcrEndpoint}
                      mono
                    />
                  </Section>
                )}
              </div>
            )}

            {tab === 'correction' && (
              <Section
                title="Modelli per fase"
                note="Locale dove basta, in rete dove serve"
              >
                {workflow !== 'legacy' && (
                  <p className="max-w-prose text-xs leading-relaxed text-muted">
                    Con «{workflow === 'strict' ? 'Testo ricomposto' : 'Scansione ricercabile'}»
                    l’impaginazione è fatta con regole fisse, senza modelli: qui scegli solo chi
                    rilegge, ripara e traduce.
                  </p>
                )}
                {correctionPhases.map((phase) => (
                  <PhaseRow key={phase} phase={phase} form={form} providers={providers} onEngine={setPhaseEngine} onModel={setPhaseModel} />
                ))}
              </Section>
            )}

            {tab === 'local' && (
              <div className="space-y-8">
                <Section title="Modelli sul tuo computer" note="Nessuna chiave, nessuna quota">
                  <LocalSetupPanel
                    localEndpoint={form.localEndpoint}
                    localOcrEndpoint={form.localOcrEndpoint}
                    onUseModel={(phase, model) =>
                      setForm((f) => withPhase(f, phase, { engine: 'local', model }))
                    }
                    onApplySetup={(setup) =>
                      setForm((f) => ({
                        ...f,
                        localEndpoint: setup.localEndpoint || f.localEndpoint,
                        localOcrEndpoint: setup.localOcrEndpoint || f.localOcrEndpoint,
                      }))
                    }
                  />
                </Section>
                <Section title="Indirizzo di Ollama">
                  <Field
                    label="Endpoint"
                    hint="Cambialo solo se Ollama gira su un altro computer della rete."
                    value={form.localEndpoint}
                    onChange={update('localEndpoint')}
                    placeholder={DEFAULTS.localEndpoint}
                    mono
                  />
                </Section>
                {!usesLocal && (
                  <p className="text-xs text-faint">
                    Nessuna fase usa ancora i modelli locali: sceglili in «Lettura» o «Correzione».
                  </p>
                )}
              </div>
            )}

            {tab === 'keys' && (
              <div className="space-y-8">
                <Section title="Chiavi dei servizi in rete" note="Restano solo su questo dispositivo">
                  {missingKey && (
                    <p className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-ink">
                      Le impostazioni attuali usano {keys.google && !form.googleApiKey?.trim() ? 'Google' : 'NVIDIA'}
                      {' '}ma la chiave è vuota.
                    </p>
                  )}
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field
                      label="Chiave NVIDIA"
                      hint="build.nvidia.com · OCR Nemotron e modelli di testo."
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
                      label="Chiave Google"
                      hint="aistudio.google.com · Gemini."
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
                <Section title="Modelli NVIDIA disponibili">
                  <p className="max-w-prose text-xs leading-relaxed text-muted">
                    Il catalogo NVIDIA elenca anche modelli non attivi per il tuo account. La prova
                    (2–4 minuti) li interroga uno per uno e poi mostra solo quelli che rispondono.
                  </p>
                  <div>
                    <button type="button" onClick={verifyNvidia} className="button-secondary">
                      {probe?.running ? 'Interrompi' : 'Trova i modelli funzionanti'}
                    </button>
                  </div>
                  {probe?.message && <p className="text-xs text-ink">{probe.message}</p>}
                  {nvidiaWorking?.length > 0 && !probe?.running && (
                    <p className="text-xs leading-relaxed text-faint">Funzionanti: {nvidiaWorking.join(', ')}</p>
                  )}
                </Section>
              </div>
            )}

            {tab === 'advanced' && (
              <div className="space-y-8">
                <Section title="PDF">
                  <div>
                    <span className="mb-1.5 block text-sm font-medium text-ink">PDF che contengono già testo</span>
                    <span className="mb-2 block text-xs text-muted">
                      Usare il testo esistente salta l’OCR ed è più fedele, ma non estrae figure e tabelle.
                    </span>
                    <div className="grid gap-2 sm:grid-cols-2">
                      <EngineButton
                        active={form.pdfTextMode !== 'ocr'}
                        onClick={() => setForm((f) => ({ ...f, pdfTextMode: 'auto' }))}
                        title="Automatico"
                        sub="usa il testo se c’è"
                      />
                      <EngineButton
                        active={form.pdfTextMode === 'ocr'}
                        onClick={() => setForm((f) => ({ ...f, pdfTextMode: 'ocr' }))}
                        title="Sempre OCR"
                        sub="rilegge le pagine come immagini"
                      />
                    </div>
                  </div>
                  <label className="block">
                    <span className="mb-1.5 block text-sm font-medium text-ink">Risoluzione delle pagine</span>
                    <span className="mb-2 block text-xs text-muted">
                      Più alta legge meglio le scansioni difficili, ma è più lenta.
                    </span>
                    <select
                      value={String(form.ocrLongSide ?? DEFAULTS.ocrLongSide)}
                      onChange={(e) => setForm((f) => ({ ...f, ocrLongSide: parseInt(e.target.value, 10) }))}
                      className="w-full rounded-lg border border-border bg-surface-2 px-3.5 py-2.5 text-sm text-ink transition-colors focus:border-primary focus:outline-none"
                    >
                      <option value="2048">Standard · ~250 DPI</option>
                      <option value="2600">Alta · ~320 DPI</option>
                      <option value="3200">Molto alta · ~390 DPI</option>
                      <option value="4000">Massima · ~490 DPI</option>
                    </select>
                  </label>
                  <Field
                    label="Pagine massime per PDF"
                    type="number"
                    min={1}
                    max={2000}
                    value={form.maxPages}
                    onChange={update('maxPages')}
                    placeholder={String(DEFAULTS.maxPages)}
                    mono
                  />
                </Section>
                <Section title="Richieste ai modelli">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field
                      label="Caratteri per richiesta"
                      hint="TranslateGemma: massimo 5000."
                      type="number"
                      min={1000}
                      max={30000}
                      value={form.chunkSize}
                      onChange={update('chunkSize')}
                      placeholder={String(DEFAULTS.chunkSize)}
                      mono
                    />
                    <Field
                      label="Frasi di contesto in traduzione"
                      hint="Prima e dopo ogni passaggio (0–6)."
                      type="number"
                      min={0}
                      max={6}
                      value={form.translateOverlap}
                      onChange={update('translateOverlap')}
                      placeholder={String(DEFAULTS.translateOverlap)}
                      mono
                    />
                  </div>
                  <Field
                    label="Endpoint NVIDIA"
                    value={form.nvidiaEndpoint}
                    onChange={update('nvidiaEndpoint')}
                    placeholder={DEFAULTS.nvidiaEndpoint}
                    mono
                  />
                </Section>
              </div>
            )}
          </div>
        </div>

        <footer className="flex items-center justify-end gap-3 border-t border-border px-5 py-3 sm:px-6">
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
            Salva
          </button>
        </footer>
      </form>
    </div>
  );
}

const TABS = [
  { id: 'document', label: 'Documento' },
  { id: 'reading', label: 'Lettura' },
  { id: 'correction', label: 'Correzione' },
  { id: 'local', label: 'Sul computer' },
  { id: 'keys', label: 'Chiavi' },
  { id: 'advanced', label: 'Avanzate' },
];

/** Interruttore con titolo e spiegazione: una riga per scelta sì/no. */
function Toggle({ checked, onChange, title, text }) {
  return (
    <label className="flex cursor-pointer items-start gap-3">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 size-4 shrink-0 accent-primary"
      />
      <span>
        <span className="block text-sm font-medium text-ink">{title}</span>
        <span className="block max-w-prose text-xs leading-relaxed text-muted">{text}</span>
      </span>
    </label>
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
  const pickable = !['paddle', 'apple'].includes(engine) && (engine !== 'local' || meta.localModel !== false);

  return (
    <div className="rounded-lg border border-border bg-surface-2/40 p-3">
      <span className="block text-sm font-medium text-ink">{meta.label}</span>
      <span className="mb-2.5 block text-xs text-faint">{meta.hint}</span>
      {/* Classe statica: Tailwind non vede le stringhe costruite a runtime,
          e una `grid-cols-${n}` dinamica non finirebbe nel CSS generato. */}
      <div className={`grid gap-2 ${meta.engines.length > 3 ? 'sm:grid-cols-2' : 'sm:grid-cols-3'}`}>
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
            options={phase === 'ocr' && provider.fullList ? provider.fullList : provider.list}
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
          {engine === 'apple'
            ? 'Usa il modello di Apple Intelligence integrato in macOS 27 (comando «fm»), sul chip del Mac. Solo nell’app desktop per Mac.'
            : engine === 'paddle'
            ? 'Modello PaddleOCR-VL: scegli come usarlo qui sotto.'
            : 'Il modello lo sceglie il sidecar: qui basta il suo indirizzo, più sotto.'}
        </p>
      )}
    </div>
  );
}

const ENGINE_TITLES = {
  gemini: 'Google Gemini',
  nvidia: 'NVIDIA',
  paddle: 'PaddleOCR-VL',
  local: 'Locale',
  apple: 'Apple (Mac)',
};

// Il sottotitolo dice cosa cambia SCEGLIENDO quel motore per QUELLA fase: è
// l'informazione che serve a decidere, e cambia da fase a fase.
const ENGINE_SUBS = {
  default: {
    gemini: 'in rete, chiave Google',
    nvidia: 'in rete, chiave NVIDIA',
    paddle: 'online gratuito o sul tuo computer',
    local: 'sulla tua macchina',
    apple: 'integrato nel Mac, macOS 27',
  },
  ocr: {
    nvidia: 'estrae figure e tabelle',
    gemini: 'regge le scansioni peggiori',
    paddle: 'molto preciso, online o locale',
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
  // Si filtra solo su quello che l'utente sta digitando: col nome già salvato
  // come filtro la tendina mostrava soltanto il modello attuale, e gli altri
  // sembravano non esistere.
  const [typed, setTyped] = useState(false);
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

  const q = typed ? (value || '').trim().toLowerCase() : '';
  const filtered = q ? options.filter((m) => m.toLowerCase().includes(q)) : options;
  const list = filtered.length ? filtered : options; // filtro a vuoto → mostra tutto

  const commit = (m) => {
    onChange({ target: { value: m } });
    setOpen(false);
    setTyped(false);
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
            setTyped(true);
            setActive(0);
          }}
          onFocus={() => {
            setOpen(true);
            setTyped(false);
          }}
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
          onClick={() => {
            setOpen((v) => !v);
            setTyped(false);
          }}
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
