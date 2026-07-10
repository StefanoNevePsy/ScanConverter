import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { loadSettings, saveSettings } from './lib/storage.js';
import { formatBytes } from './lib/files.js';
import { usePipeline } from './hooks/usePipeline.js';
import { initNativeShell, onBackButton } from './lib/native.js';
import SettingsModal from './components/SettingsModal.jsx';
import Dropzone from './components/Dropzone.jsx';
import PipelineStepper from './components/PipelineStepper.jsx';
import TypstEditor from './components/TypstEditor.jsx';
import PdfPreview from './components/PdfPreview.jsx';
import RestylePanel from './components/RestylePanel.jsx';
import FigureReviewPanel from './components/FigureReviewPanel.jsx';
import PagesReviewPanel from './components/PagesReviewPanel.jsx';
import FidelityPanel from './components/FidelityPanel.jsx';
import SpellPanel from './components/SpellPanel.jsx';
import OcrTextPanel from './components/OcrTextPanel.jsx';
import SessionsList from './components/SessionsList.jsx';
import {
  IconSettings,
  IconRefresh,
  IconAlert,
  IconFile,
  IconCheck,
  IconX,
} from './components/Icons.jsx';

export default function App() {
  const [settings, setSettings] = useState(loadSettings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [file, setFile] = useState(null);
  const [previewUrl, setPreviewUrl] = useState(null);
  const [livePreview, setLivePreview] = useState(false);

  const pipe = usePipeline(settings);
  const lastCompiledRef = useRef('');
  const previewUrlRef = useRef(null);

  // L'OCR richiede sempre la chiave NVIDIA; la fase Typst richiede la chiave
  // Google solo se il motore è Gemini (con motore NVIDIA riusa quella NVIDIA).
  const needsGoogle = settings.typstEngine !== 'nvidia';
  const keysReady = Boolean(settings.nvidiaApiKey && (!needsGoogle || settings.googleApiKey));

  // Anteprima locale (thumbnail) del file sorgente.
  useEffect(() => {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    if (file && file.type.startsWith('image/')) {
      const url = URL.createObjectURL(file);
      previewUrlRef.current = url;
      setPreviewUrl(url);
    } else {
      previewUrlRef.current = null;
      setPreviewUrl(null);
    }
    return () => {
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    };
  }, [file]);

  const handleFile = useCallback(
    (f) => {
      setFile(f);
      if (!settings.nvidiaApiKey || (needsGoogle && !settings.googleApiKey)) {
        setSettingsOpen(true);
        return;
      }
      lastCompiledRef.current = '';
      pipe.runPipeline(f);
    },
    [settings, pipe],
  );

  const handleSaveSettings = useCallback(
    (next) => {
      saveSettings(next);
      setSettings(next);
      // Se un file era in attesa delle chiavi, avvia ora la pipeline.
      if (file && next.nvidiaApiKey && next.googleApiKey && pipe.phase === 'idle') {
        lastCompiledRef.current = '';
        pipe.runPipeline(file);
      }
    },
    [file, pipe],
  );

  // Registra il sorgente appena compilato dalla pipeline, così la live
  // preview non lo ricompila inutilmente.
  useEffect(() => {
    if (pipe.phase === 'done') lastCompiledRef.current = pipe.typstCode;
  }, [pipe.phase, pipe.typstCode]);

  // Live preview con debounce sulle modifiche manuali del codice.
  useEffect(() => {
    if (!livePreview || !pipe.typstCode.trim()) return;
    if (pipe.typstCode === lastCompiledRef.current) return;
    const t = setTimeout(async () => {
      const ok = await pipe.recompile(pipe.typstCode);
      if (ok) lastCompiledRef.current = pipe.typstCode;
    }, 700);
    return () => clearTimeout(t);
  }, [livePreview, pipe.typstCode, pipe]);

  const manualCompile = useCallback(async () => {
    const ok = await pipe.recompile(pipe.typstCode);
    if (ok) lastCompiledRef.current = pipe.typstCode;
  }, [pipe]);

  const download = useCallback(() => {
    const base = (file?.name || 'documento').replace(/\.[^.]+$/, '');
    pipe.downloadPdf(`${base}-typst`);
  }, [pipe, file]);

  const startOver = useCallback(() => {
    pipe.reset();
    setFile(null);
    lastCompiledRef.current = '';
  }, [pipe]);

  // Apre/riprende una sessione salvata: l'immagine originale non serve più
  // (OCR già fatto), basta un file segnaposto per aprire il workspace.
  const openSavedSession = useCallback(
    async (meta) => {
      if (!meta) return;
      setFile({ name: meta.fileName || 'documento', size: 0, type: '' });
      lastCompiledRef.current = '';
      await pipe.openSession(meta);
    },
    [pipe],
  );

  const hasWorkspace = file && pipe.phase !== 'idle';

  // Gestione del tasto/gesture "indietro" di Android. Un ref tiene sempre
  // aggiornata la logica senza dover ri-registrare il listener nativo.
  const backRef = useRef(() => false);
  backRef.current = () => {
    if (settingsOpen) {
      setSettingsOpen(false);
      return true;
    }
    if (hasWorkspace) {
      startOver();
      return true;
    }
    return false; // nessuno stato da chiudere: l'app può uscire
  };

  useEffect(() => {
    initNativeShell();
    const off = onBackButton(() => backRef.current());
    return off;
  }, []);

  return (
    <div className="app-shell flex min-h-dvh flex-col">
      <TopBar
        keysReady={keysReady}
        onOpenSettings={() => setSettingsOpen(true)}
        status={pipe.status}
        running={pipe.phase === 'running'}
      />

      <main className="mx-auto flex w-full max-w-[1400px] flex-1 flex-col px-4 py-6 sm:px-6 lg:px-8">
        {!hasWorkspace ? (
          <Landing
            keysReady={keysReady}
            onFile={handleFile}
            onOpenSettings={() => setSettingsOpen(true)}
            sessions={pipe.sessions}
            onOpenSession={openSavedSession}
            onDeleteSession={pipe.deleteSavedSession}
          />
        ) : (
          <Workspace
            file={file}
            previewUrl={previewUrl}
            pipe={pipe}
            livePreview={livePreview}
            onToggleLive={() => setLivePreview((v) => !v)}
            onCompile={manualCompile}
            onDownload={download}
            onStartOver={startOver}
            onRetry={() => pipe.runPipeline(file)}
          />
        )}
      </main>

      <SettingsModal
        open={settingsOpen}
        initial={settings}
        onClose={() => setSettingsOpen(false)}
        onSave={handleSaveSettings}
      />
    </div>
  );
}

/* ---------------------------------------------------------------- Top bar */

function TopBar({ keysReady, onOpenSettings, status, running }) {
  return (
    <header
      className="safe-top sticky top-0 border-b border-border bg-bg/80 backdrop-blur-md"
      style={{ zIndex: 'var(--z-sticky)' }}
    >
      <div className="mx-auto flex w-full max-w-[1400px] items-center justify-between gap-4 px-4 py-3 sm:px-6 lg:px-8">
        <div className="flex items-center gap-3">
          <span className="grid size-9 place-items-center rounded-xl bg-primary-soft text-lg">
            📜
          </span>
          <div className="leading-tight">
            <h1 className="text-[15px] font-semibold tracking-tight text-ink">
              ScanConverter
            </h1>
            <p className="hidden text-xs text-muted sm:block">
              Fotocopia → OCR → Typst → PDF vettoriale
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {running && (
            <span className="hidden items-center gap-2 rounded-full border border-border bg-surface px-3 py-1.5 text-xs text-muted md:flex">
              <span className="size-1.5 animate-pulse rounded-full bg-primary" />
              Elaborazione in corso
            </span>
          )}
          <button
            onClick={onOpenSettings}
            className="inline-flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm font-medium text-ink transition-colors hover:bg-surface-2"
          >
            <IconSettings width={16} height={16} />
            <span className="hidden sm:inline">Impostazioni</span>
            <span
              className={`size-2 rounded-full ${keysReady ? 'bg-success' : 'bg-warning'}`}
              title={keysReady ? 'Chiavi API configurate' : 'Chiavi API mancanti'}
            />
          </button>
        </div>
      </div>
    </header>
  );
}

/* ---------------------------------------------------------------- Landing */

function Landing({ keysReady, onFile, onOpenSettings, sessions, onOpenSession, onDeleteSession }) {
  return (
    <div className="mx-auto grid w-full max-w-3xl flex-1 place-items-center py-6">
      <div className="w-full">
        <div className="mb-8 text-center">
          <h2 className="text-balance text-2xl font-semibold tracking-tight text-ink sm:text-[28px]">
            Ridà vita ai documenti accademici
          </h2>
          <p className="mx-auto mt-3 max-w-xl text-pretty text-[15px] leading-relaxed text-muted">
            Carica una pagina scansionata: la estraiamo con Nemotron-Parse, la
            re-impaginiamo in Typst con Gemini e la compiliamo in un PDF
            vettoriale pulito — con margini ampi pronti per le tue annotazioni.
          </p>
        </div>

        {sessions?.length > 0 && (
          <SessionsList
            sessions={sessions}
            onOpen={onOpenSession}
            onDelete={onDeleteSession}
          />
        )}

        {!keysReady && (
          <button
            onClick={onOpenSettings}
            className="mb-4 flex w-full items-center gap-3 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-left transition-colors hover:bg-warning/15"
          >
            <IconAlert width={18} height={18} className="shrink-0 text-warning" />
            <span className="text-sm text-ink">
              <span className="font-medium">Configura le chiavi API</span> —
              servono NVIDIA e Google per avviare l’elaborazione.
            </span>
          </button>
        )}

        <Dropzone onFile={onFile} />

        <ol className="mt-8 grid gap-3 sm:grid-cols-3">
          {[
            ['Estrazione', 'NVIDIA Nemotron-Parse legge titoli, note e tabelle dalla scansione.'],
            ['Formattazione', 'Gemini riscrive il testo in Typst con margini per le annotazioni.'],
            ['Compilazione', 'Il compilatore Typst WASM genera il PDF, tutto nel tuo browser.'],
          ].map(([title, body], i) => (
            <li key={title} className="rounded-xl border border-border bg-surface/60 p-4">
              <div className="mb-2 flex size-7 items-center justify-center rounded-full bg-primary-soft text-sm font-semibold text-primary tabular-nums">
                {i + 1}
              </div>
              <div className="text-sm font-medium text-ink">{title}</div>
              <p className="mt-1 text-[13px] leading-snug text-muted">{body}</p>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- Workspace */

function Workspace({
  file,
  previewUrl,
  pipe,
  livePreview,
  onToggleLive,
  onCompile,
  onDownload,
  onStartOver,
  onRetry,
}) {
  const doneCount = useMemo(
    () => Object.values(pipe.status).filter((s) => s === 'done').length,
    [pipe.status],
  );
  // Su schermi stretti le due colonne diventano schede a tutta altezza.
  const [mobileTab, setMobileTab] = useState('code'); // 'code' | 'pdf'
  const [styleHint, setStyleHint] = useState(''); // scelte di impaginazione correnti
  const [autofixMsg, setAutofixMsg] = useState(null);
  const [searchReq, setSearchReq] = useState(null); // ricerca pilotata nell'editor

  const handleAutofix = useCallback(async () => {
    const { changes } = await pipe.autofix();
    setAutofixMsg(
      changes.length
        ? `Applicate: ${changes.join(' · ')}`
        : 'Nessuna correzione automatica applicabile.',
    );
    setTimeout(() => setAutofixMsg(null), 7000);
  }, [pipe]);

  const handleAiFix = useCallback(async () => {
    const res = await pipe.aiFix();
    setAutofixMsg(res?.message || null);
    setTimeout(() => setAutofixMsg(null), 15000);
  }, [pipe]);

  const handleSpellFixAll = useCallback(
    async (selectedWords) => {
      const res = await pipe.spellFixAll(selectedWords);
      setAutofixMsg(res?.message || null);
      setTimeout(() => setAutofixMsg(null), 15000);
    },
    [pipe],
  );

  const handleFixSpacing = useCallback(async () => {
    const res = await pipe.fixPunctuation();
    setAutofixMsg(res?.message || null);
    setTimeout(() => setAutofixMsg(null), 12000);
  }, [pipe]);

  // Clic su una parola sospetta → cerca nell'editor (e mostra la scheda codice).
  const locateWord = useCallback((word) => {
    setMobileTab('code');
    setSearchReq({ query: word, id: Date.now() });
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      {/* Barra sorgente + stato pipeline + azioni */}
      <div className="card flex flex-col gap-4 p-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
        <div className="flex items-center gap-3">
          <div className="size-11 shrink-0 overflow-hidden rounded-lg border border-border bg-surface-2">
            {previewUrl ? (
              <img src={previewUrl} alt="" className="size-full object-cover" />
            ) : (
              <span className="grid size-full place-items-center text-faint">
                <IconFile width={20} height={20} />
              </span>
            )}
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-ink">{file.name}</div>
            <div className="truncate text-xs text-faint">
              {pipe.detail
                ? pipe.detail
                : `${formatBytes(file.size)} · ${doneCount}/3 fasi completate`}
            </div>
          </div>
        </div>

        <div className="flex-1 sm:px-2">
          <PipelineStepper status={pipe.status} compact />
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={onStartOver}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm font-medium text-muted transition-colors hover:bg-surface-2 hover:text-ink"
          >
            <IconX width={15} height={15} />
            <span className="hidden sm:inline">Nuovo</span>
          </button>
          <button
            onClick={onRetry}
            disabled={pipe.phase === 'running'}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm font-medium text-ink transition-colors hover:bg-surface-2 disabled:opacity-50"
          >
            <IconRefresh width={15} height={15} />
            <span className="hidden sm:inline">Rielabora</span>
          </button>
        </div>
      </div>

      {pipe.error && (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-xl border border-danger/40 bg-danger-soft px-4 py-3"
        >
          <IconAlert width={18} height={18} className="mt-0.5 shrink-0 text-danger" />
          <div className="min-w-0 flex-1 text-sm">
            <div className="font-medium text-ink">La pipeline si è interrotta.</div>
            <p className="mt-0.5 text-muted">{pipe.error}</p>
          </div>
          {pipe.canResume && (
            <button
              onClick={() => pipe.resume()}
              className="inline-flex shrink-0 items-center gap-1.5 self-center rounded-lg bg-primary px-3.5 py-2 text-sm font-semibold text-primary-ink transition-colors hover:bg-primary-strong"
            >
              <IconRefresh width={15} height={15} />
              Riprendi
            </button>
          )}
        </div>
      )}

      {pipe.pageReview && (
        <PagesReviewPanel
          key={pipe.pageReview.length}
          items={pipe.pageReview}
          onConfirm={pipe.confirmPages}
          busy={pipe.phase === 'running'}
        />
      )}

      {pipe.figureReview && (
        <FigureReviewPanel
          key={pipe.figureReview.map((i) => i.path).join('|')}
          items={pipe.figureReview}
          onConfirm={pipe.confirmFigures}
        />
      )}

      <FidelityPanel warnings={pipe.fidelityWarnings} />

      {pipe.spellReport && (
        <SpellPanel
          report={pipe.spellReport}
          busy={pipe.spellBusy}
          onFixAll={handleSpellFixAll}
          onRecheck={pipe.runSpellcheck}
          onLocate={locateWord}
          onClose={pipe.closeSpellReport}
          onIgnore={pipe.ignoreSpellWords}
          onFixSpacing={handleFixSpacing}
        />
      )}

      {pipe.rawText && !pipe.figureReview && (
        <RestylePanel
          onRestyle={(hint) => pipe.restyle(hint)}
          onApplyLocal={(sel) => pipe.applyLocalStyle(sel)}
          onHintChange={setStyleHint}
          busy={pipe.phase === 'running'}
          disabled={pipe.phase === 'running'}
        />
      )}

      {pipe.rawText && <OcrTextPanel text={pipe.rawText} styleHint={styleHint} />}

      {/* Selettore a schede (solo mobile/tablet stretto) */}
      <div className="flex items-center gap-1 rounded-lg border border-border bg-surface p-1 lg:hidden">
        <TabButton active={mobileTab === 'code'} onClick={() => setMobileTab('code')}>
          Codice Typst
        </TabButton>
        <TabButton active={mobileTab === 'pdf'} onClick={() => setMobileTab('pdf')}>
          Anteprima PDF
        </TabButton>
      </div>

      {/* Doppia colonna: editor Typst | anteprima PDF.
          Su mobile una scheda alla volta, a tutta altezza. */}
      <div className="flex min-h-[60vh] flex-1 flex-col gap-4 lg:grid lg:min-h-[520px] lg:grid-cols-2">
        <div className={`min-h-0 flex-1 flex-col ${mobileTab === 'code' ? 'flex' : 'hidden'} lg:flex`}>
          {autofixMsg && (
            <div className="mb-2 rounded-lg border border-primary/40 bg-primary-soft px-3 py-2 text-xs text-ink">
              {autofixMsg}
            </div>
          )}
          <div className="mb-2 flex items-center justify-end">
            <label className="flex cursor-pointer items-center gap-2 text-xs text-muted">
              <span>Anteprima live</span>
              <span className="relative inline-flex">
                <input
                  type="checkbox"
                  checked={livePreview}
                  onChange={onToggleLive}
                  className="peer sr-only"
                />
                <span className="h-5 w-9 rounded-full bg-surface-3 transition-colors peer-checked:bg-primary" />
                <span className="absolute left-0.5 top-0.5 size-4 rounded-full bg-ink transition-transform peer-checked:translate-x-4" />
              </span>
            </label>
          </div>
          <TypstEditor
            value={pipe.typstCode}
            onChange={pipe.setTypstCode}
            onCompile={onCompile}
            onAutofix={handleAutofix}
            onAiFix={handleAiFix}
            aiFixing={pipe.aiFixing}
            onSpellcheck={pipe.runSpellcheck}
            spellBusy={pipe.spellBusy}
            searchRequest={searchReq}
            compiling={pipe.compiling}
            error={pipe.compileError}
            disabled={pipe.phase === 'running' && !pipe.typstCode}
          />
        </div>

        <div className={`min-h-0 flex-1 flex-col ${mobileTab === 'pdf' ? 'flex' : 'hidden'} lg:flex`}>
          <div className="mb-2 hidden h-[26px] lg:block" aria-hidden="true" />
          <PdfPreview
            svg={pipe.previewSvg}
            compiling={pipe.compiling || pipe.status.compile === 'active'}
            downloading={pipe.downloading}
            onDownload={onDownload}
          />
        </div>
      </div>
    </div>
  );
}

function TabButton({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
        active ? 'bg-surface-2 text-ink' : 'text-muted hover:text-ink'
      }`}
    >
      {children}
    </button>
  );
}
