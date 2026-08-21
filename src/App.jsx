import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { loadSettings, saveSettings } from './lib/storage.js';
import { formatBytes } from './lib/files.js';
import { usePipeline } from './hooks/usePipeline.js';
import { initNativeShell, onBackButton, setNativeTheme } from './lib/native.js';
import { getSharedFile, onSharedFile } from './lib/incoming.js';
import SettingsModal from './components/SettingsModal.jsx';
import Dropzone from './components/Dropzone.jsx';
import PipelineStepper from './components/PipelineStepper.jsx';
import TypstEditor from './components/TypstEditor.jsx';
import PdfPreview from './components/PdfPreview.jsx';
import RestylePanel from './components/RestylePanel.jsx';
import FigureReviewPanel from './components/FigureReviewPanel.jsx';
import PagesReviewPanel from './components/PagesReviewPanel.jsx';
import FidelityPanel from './components/FidelityPanel.jsx';
import StrictReportPanel from './components/StrictReportPanel.jsx';
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
  IconArrowLeft,
  IconDownload,
  IconUpload,
  IconSun,
  IconMoon,
} from './components/Icons.jsx';

function initialTheme() {
  try {
    const stored = localStorage.getItem('scanconverter:theme');
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    /* storage non disponibile */
  }
  return globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export default function App() {
  const [settings, setSettings] = useState(loadSettings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [file, setFile] = useState(null);
  const [previewUrl, setPreviewUrl] = useState(null);
  const [livePreview, setLivePreview] = useState(false);
  const [projectNotice, setProjectNotice] = useState(null);
  const [theme, setTheme] = useState(initialTheme);

  const pipe = usePipeline(settings);
  const lastCompiledRef = useRef('');
  const previewUrlRef = useRef(null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute(
      'content',
      theme === 'dark' ? '#10110f' : '#f0eee8',
    );
    try {
      localStorage.setItem('scanconverter:theme', theme);
    } catch {
      /* preferenza non persistibile */
    }
    setNativeTheme(theme);
  }, [theme]);

  // Chiave Google richiesta se Gemini è motore OCR o motore Typst; chiave
  // NVIDIA richiesta se NVIDIA è motore OCR o motore Typst.
  const needsGoogle =
    settings.ocrEngine === 'gemini' ||
    settings.typstEngine === 'gemini' ||
    (settings.formatWorkflow === 'strict' && settings.compareOcr) ||
    (settings.ocrEngine !== 'gemini' && settings.refineTables) ||
    (settings.formatWorkflow === 'strict' && settings.fixTypos && settings.fixEngine === 'gemini');
  const needsNvidia =
    settings.ocrEngine === 'nvidia' ||
    settings.typstEngine === 'nvidia' ||
    (settings.formatWorkflow === 'strict' && settings.compareOcr) ||
    (settings.formatWorkflow === 'strict' && settings.fixTypos && settings.fixEngine === 'nvidia');
  const keysReady = Boolean(
    (!needsNvidia || settings.nvidiaApiKey) && (!needsGoogle || settings.googleApiKey),
  );

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
      if (!keysReady) {
        setSettingsOpen(true);
        return;
      }
      lastCompiledRef.current = '';
      pipe.runPipeline(f);
    },
    [keysReady, pipe],
  );

  const handleSaveSettings = useCallback(
    (next) => {
      saveSettings(next);
      setSettings(next);
      // Se un file era in attesa delle chiavi, avvia ora la pipeline — ma solo
      // se le chiavi effettivamente richieste dalla nuova configurazione ci sono.
      const nextNeedsGoogle =
        next.ocrEngine === 'gemini' ||
        next.typstEngine === 'gemini' ||
        (next.formatWorkflow === 'strict' && next.compareOcr) ||
        (next.ocrEngine !== 'gemini' && next.refineTables) ||
        (next.formatWorkflow === 'strict' && next.fixTypos && next.fixEngine === 'gemini');
      const nextNeedsNvidia =
        next.ocrEngine === 'nvidia' ||
        next.typstEngine === 'nvidia' ||
        (next.formatWorkflow === 'strict' && next.compareOcr) ||
        (next.formatWorkflow === 'strict' && next.fixTypos && next.fixEngine === 'nvidia');
      const nextReady =
        (!nextNeedsNvidia || next.nvidiaApiKey) && (!nextNeedsGoogle || next.googleApiKey);
      if (file && nextReady && pipe.phase === 'idle') {
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
    if (!livePreview || pipe.aiFixing || !pipe.typstCode.trim()) return;
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

  const download = useCallback(
    (mode) => {
      const base = (file?.name || 'documento').replace(/\.[^.]+$/, '');
      pipe.downloadPdf(`${base}-typst`, mode);
    },
    [pipe, file],
  );

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

  const exportProject = useCallback(async (summary = null) => {
    setProjectNotice(null);
    try {
      const result = await pipe.exportProject(summary);
      if (!result.cancelled) {
        setProjectNotice({
          kind: 'success',
          text: `Progetto esportato: ${result.fileName} · ${result.figures} figure${result.pages ? ` · ${result.pages} pagine da riprendere` : ''}.`,
        });
      }
    } catch (error) {
      setProjectNotice({ kind: 'error', text: error.message || 'Esportazione non riuscita.' });
    }
  }, [pipe]);

  const importProject = useCallback(async (projectFile) => {
    setProjectNotice(null);
    try {
      const meta = await pipe.importProject(projectFile);
      if (meta.status === 'ocr' && !keysReady) {
        setProjectNotice({
          kind: 'success',
          text: `“${meta.fileName}” importato. Configura le chiavi API, poi riprendilo dall’elenco.`,
        });
        return;
      }
      setFile({ name: meta.fileName || 'documento', size: 0, type: '' });
      lastCompiledRef.current = '';
      await pipe.openSession(meta);
      setProjectNotice({ kind: 'success', text: `Progetto “${meta.fileName}” importato.` });
    } catch (error) {
      setProjectNotice({ kind: 'error', text: error.message || 'Importazione non riuscita.' });
    }
  }, [keysReady, pipe]);

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

  // File condiviso verso l'app (menu Condividi / "Apri con" di Android): un
  // ref tiene aggiornato handleFile senza ri-registrare il listener nativo.
  const handleFileRef = useRef(handleFile);
  handleFileRef.current = handleFile;
  useEffect(() => {
    let alive = true;
    getSharedFile().then((f) => {
      if (alive && f) handleFileRef.current(f);
    });
    const off = onSharedFile((f) => handleFileRef.current(f));
    return () => {
      alive = false;
      off();
    };
  }, []);

  return (
    <div className="app-shell flex min-h-dvh flex-col">
      <TopBar
        keysReady={keysReady}
        onOpenSettings={() => setSettingsOpen(true)}
        onDashboard={hasWorkspace ? startOver : null}
        status={pipe.status}
        running={pipe.phase === 'running'}
        theme={theme}
        onToggleTheme={() => setTheme((value) => value === 'light' ? 'dark' : 'light')}
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
            onExportSession={exportProject}
            onImportProject={importProject}
            projectBusy={pipe.projectBusy}
            projectNotice={projectNotice}
          />
        ) : (
          <Workspace
            file={file}
            previewUrl={previewUrl}
            pipe={pipe}
            fixTypos={settings.fixTypos}
            livePreview={livePreview}
            onToggleLive={() => setLivePreview((v) => !v)}
            onCompile={manualCompile}
            onDownload={download}
            onStartOver={startOver}
            onRetry={() => pipe.runPipeline(file)}
            onExportProject={() => exportProject(null)}
            projectBusy={pipe.projectBusy}
            projectNotice={projectNotice}
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

function TopBar({ keysReady, onOpenSettings, onDashboard, status, running, theme, onToggleTheme }) {
  return (
    <header
      className="safe-top scan-topbar sticky top-0"
      style={{ zIndex: 'var(--z-sticky)' }}
    >
      <div className="mx-auto flex w-full max-w-[1400px] items-center justify-between gap-4 px-4 py-3 sm:px-6 lg:px-8">
        <div className="flex min-w-0 items-center gap-3">
          {onDashboard && (
            <button
              onClick={onDashboard}
              aria-label="Torna alla home"
              title="Torna alla home"
              className="grid size-9 shrink-0 place-items-center rounded-lg border border-border bg-surface text-muted transition-colors hover:bg-surface-2 hover:text-ink"
            >
              <IconArrowLeft width={18} height={18} />
            </button>
          )}
          <BrandMark />
          <div className="leading-tight">
            <h1 className="brand-wordmark">
              ScanConverter
            </h1>
            <p className="hidden text-[11px] text-muted sm:block">
              Scansione · testo · pagina
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
            type="button"
            onClick={onToggleTheme}
            className="topbar-icon-button"
            aria-label={theme === 'light' ? 'Attiva il tema scuro' : 'Attiva il tema chiaro'}
            title={theme === 'light' ? 'Tema scuro' : 'Tema chiaro'}
          >
            {theme === 'light' ? <IconMoon width={16} height={16} /> : <IconSun width={16} height={16} />}
          </button>
          <button
            onClick={onOpenSettings}
            className="topbar-settings"
            aria-label={`Apri impostazioni. ${keysReady ? 'Chiavi API configurate' : 'Chiavi API mancanti'}`}
          >
            <IconSettings width={16} height={16} />
            <span className="hidden sm:inline">Impostazioni</span>
            <span
              className={`size-2 rounded-full ${keysReady ? 'bg-success' : 'bg-warning'}`}
              aria-hidden="true"
            />
          </button>
        </div>
      </div>
    </header>
  );
}

/* ---------------------------------------------------------------- Landing */

function Landing({
  keysReady,
  onFile,
  onOpenSettings,
  sessions,
  onOpenSession,
  onDeleteSession,
  onExportSession,
  onImportProject,
  projectBusy,
  projectNotice,
}) {
  // Chi torna ha già letto la spiegazione: quando c'è lavoro in sospeso la
  // pagina guida alla ripresa, e «riprendi» e «nuovo documento» stanno
  // affiancate come azioni di pari grado invece che impilate.
  const hasSessions = sessions?.length > 0;

  return (
    <div
      className={`mx-auto flex w-full flex-1 flex-col ${
        // Con del lavoro in sospeso la pagina si ancora in alto: centrare due
        // colonne in un viewport alto lascia il contenuto a galleggiare nel
        // vuoto. Al primo avvio, invece, il blocco è compatto e il centro regge.
        hasSessions ? 'max-w-5xl justify-start pt-4 sm:pt-8' : 'max-w-2xl justify-center py-6'
      }`}
    >
      <header className={hasSessions ? 'mb-6' : 'mb-10 text-center'}>
        <h2 className="landing-title text-balance text-ink">
          {hasSessions ? 'Riprendi o inizia un documento' : 'Ridà vita ai documenti accademici'}
        </h2>
        {!hasSessions && (
          <p className="mx-auto mt-3 max-w-xl text-pretty text-[15px] leading-relaxed text-muted">
            Carica scansioni, dispense o un libro completo. L’app estrae il testo,
            ricostruisce un sorgente Typst modificabile e compila un PDF vettoriale
            pulito — con uno stato che puoi interrompere, esportare e riprendere.
          </p>
        )}
      </header>

      {!keysReady && (
        <button
          onClick={onOpenSettings}
          className="mb-6 flex w-full items-center gap-3 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-left transition-colors hover:bg-warning/15"
        >
          <IconAlert width={18} height={18} className="shrink-0 text-warning" />
          <span className="text-sm text-ink">
            <span className="font-medium">Configura le chiavi API</span> — servono
            NVIDIA e Google per avviare l’elaborazione.
          </span>
        </button>
      )}

      {projectNotice && <ProjectNotice notice={projectNotice} />}

      <div className="mb-5 flex items-center justify-end">
        <ProjectImportButton onImport={onImportProject} busy={projectBusy === 'import'} />
      </div>

      <div className={hasSessions ? 'grid gap-5 lg:grid-cols-[1.15fr_1fr] lg:items-start' : ''}>
        {hasSessions && (
          <SessionsList
            sessions={sessions}
            onOpen={onOpenSession}
            onDelete={onDeleteSession}
            onExport={onExportSession}
            exportBusy={projectBusy === 'export'}
          />
        )}
        <Dropzone onFile={onFile} />
      </div>

      {/* La sequenza si spiega una volta sola, a chi non ha ancora documenti:
          per gli altri è già nella barra in alto. Una riga di testo, non tre
          schede identiche che ripetono la stessa forma. */}
      {!hasSessions && (
        <p className="mt-8 text-center text-[13px] leading-relaxed text-faint">
          <span className="text-muted">OCR strutturato</span> legge titoli, note e
          tabelle · <span className="text-muted">Motore di layout</span> ricostruisce
          l’impaginazione in Typst · <span className="text-muted">Typst locale</span>{' '}
          compila e diagnostica senza server intermedi
        </p>
      )}
    </div>
  );
}

/* -------------------------------------------------------------- Workspace */

function Workspace({
  file,
  previewUrl,
  pipe,
  fixTypos,
  livePreview,
  onToggleLive,
  onCompile,
  onDownload,
  onStartOver,
  onRetry,
  onExportProject,
  projectBusy,
  projectNotice,
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
  const [pdfSearchTarget, setPdfSearchTarget] = useState(null);
  const pdfSearchRequestRef = useRef(0);

  const handleSearchMatch = useCallback(async (match) => {
    const requestId = ++pdfSearchRequestRef.current;
    const target = await pipe.previewSearchMatch(match);
    if (requestId !== pdfSearchRequestRef.current) return;
    if (match && target) {
      setPdfSearchTarget(target);
    } else {
      if (requestId === pdfSearchRequestRef.current) setPdfSearchTarget(null);
    }
  }, [pipe.previewSearchMatch]);

  const handleAutofix = useCallback(async () => {
    const { changes } = await pipe.autofix();
    const visible = changes.slice(0, 8);
    const more = changes.length > visible.length ? ` · +${changes.length - visible.length} altre` : '';
    setAutofixMsg(
      changes.length
        ? `Applicate: ${visible.join(' · ')}${more}`
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

  const handleProofread = useCallback(async () => {
    const res = await pipe.proofreadAI();
    setAutofixMsg(res?.message || null);
    setTimeout(() => setAutofixMsg(null), 18000);
  }, [pipe]);

  // Clic su una parola sospetta → cerca nell'editor (e mostra la scheda codice).
  const locateWord = useCallback((suspect) => {
    setMobileTab('code');
    setSearchReq({ query: suspect.word, wholeWord: true, id: Date.now() });
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
            onClick={onExportProject}
            disabled={!!projectBusy}
            aria-label="Esporta progetto"
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm font-medium text-ink transition-colors hover:bg-surface-2 disabled:opacity-50"
            title="Esporta sorgente, stato, figure e pagine ancora da elaborare"
          >
            {projectBusy === 'export' ? <span className="size-3.5 animate-spin rounded-full border border-current border-r-transparent" /> : <IconDownload width={15} height={15} />}
            <span className="hidden xl:inline">Esporta progetto</span>
          </button>
          <label className="mr-1 flex cursor-pointer items-center gap-2 text-xs text-muted">
            <span className="hidden sm:inline">Anteprima live</span>
            <span className="relative inline-flex">
              <input
                type="checkbox"
                aria-label="Attiva anteprima live"
                checked={livePreview}
                onChange={onToggleLive}
                className="peer sr-only"
              />
              <span className="h-5 w-9 rounded-full bg-surface-3 transition-colors peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-primary peer-checked:bg-primary" />
              <span className="absolute left-0.5 top-0.5 size-4 rounded-full bg-ink transition-transform peer-checked:translate-x-4" />
            </span>
          </label>
          <button
            onClick={onStartOver}
            aria-label="Nuovo documento"
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm font-medium text-muted transition-colors hover:bg-surface-2 hover:text-ink"
          >
            <IconX width={15} height={15} />
            <span className="hidden sm:inline">Nuovo</span>
          </button>
          <button
            onClick={onRetry}
            disabled={pipe.phase === 'running'}
            aria-label="Rielabora documento"
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm font-medium text-ink transition-colors hover:bg-surface-2 disabled:opacity-50"
          >
            <IconRefresh width={15} height={15} />
            <span className="hidden sm:inline">Rielabora</span>
          </button>
        </div>
      </div>

      {projectNotice && <ProjectNotice notice={projectNotice} />}

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
      <StrictReportPanel
        report={pipe.strictReport}
        correctionBusy={pipe.strictCorrectionBusy}
        onReviewCorrection={pipe.reviewStrictCorrection}
        issueBusy={pipe.strictIssueBusy}
        onReviewIssue={pipe.reviewStrictIssue}
      />

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

      {/* Strumenti secondari affiancati: due fisarmoniche chiuse impilate
          rubavano due righe intere allo spazio dell'editor, che è il lavoro. */}
      {pipe.rawText && (
        <div className="workspace-tools grid gap-3 lg:grid-cols-2 lg:items-start">
          {!pipe.figureReview && (
            <RestylePanel
              onRestyle={pipe.strictReport ? null : (hint) => pipe.restyle(hint)}
              onApplyLocal={(sel) => pipe.applyLocalStyle(sel)}
              onHintChange={setStyleHint}
              initialSelection={pipe.layoutOptions}
              busy={pipe.phase === 'running'}
              disabled={pipe.phase === 'running'}
              strict={!!pipe.strictReport}
            />
          )}
          <OcrTextPanel text={pipe.rawText} styleHint={styleHint} fixTypos={fixTypos} />
        </div>
      )}

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
          Su mobile una scheda alla volta. L'altezza segue la viewport ma è
          limitata: editor e PDF scorrono internamente invece di allungare la pagina. */}
      <div className="flex h-[clamp(380px,70dvh,800px)] min-h-0 flex-none flex-col gap-4 lg:grid lg:grid-cols-2">
        <div className={`min-h-0 flex-1 flex-col ${mobileTab === 'code' ? 'flex' : 'hidden'} lg:flex`}>
          {autofixMsg && (
            <div className="mb-2 rounded-lg border border-primary/40 bg-primary-soft px-3 py-2 text-xs text-ink">
              {autofixMsg}
            </div>
          )}
          <TypstEditor
            value={pipe.typstCode}
            onChange={pipe.setTypstCode}
            onCompile={onCompile}
            onAutofix={handleAutofix}
            onAiFix={handleAiFix}
            aiFixing={pipe.aiFixing}
            onSpellcheck={pipe.runSpellcheck}
            spellBusy={pipe.spellBusy}
            onProofread={handleProofread}
            proofreadBusy={pipe.proofreadBusy}
            proofreadDetail={pipe.proofreadDetail}
            searchRequest={searchReq}
            onSearchMatch={handleSearchMatch}
            compiling={pipe.compiling}
            error={pipe.compileError}
            disabled={pipe.phase === 'running' && !pipe.typstCode}
          />
        </div>

        <div className={`min-h-0 flex-1 flex-col ${mobileTab === 'pdf' ? 'flex' : 'hidden'} lg:flex`}>
          <PdfPreview
            pdfBytes={pipe.previewPdf}
            compiling={pipe.compiling || pipe.status.compile === 'active'}
            downloading={pipe.downloading}
            onDownload={onDownload}
            searchTarget={pdfSearchTarget}
          />
        </div>
      </div>
    </div>
  );
}

function ProjectImportButton({ onImport, busy }) {
  const inputRef = useRef(null);
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept=".scanconverter,application/vnd.scanconverter.project+zip,application/zip"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          const projectFile = event.target.files?.[0];
          event.target.value = '';
          if (projectFile) onImport(projectFile);
        }}
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={busy}
        className="button-secondary"
      >
        {busy ? <span className="size-3.5 animate-spin rounded-full border border-current border-r-transparent" /> : <IconUpload width={15} height={15} />}
        {busy ? 'Importazione…' : 'Importa progetto'}
      </button>
    </>
  );
}

function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <svg viewBox="0 0 40 40">
        <path d="M10 5.5h17l4 4v25H10z" />
        <path d="M27 5.5v5h4" />
        <path d="M15 14h10M15 19h11M15 24h8" />
        <path className="brand-margin" d="M12.5 5.5v29" />
      </svg>
    </span>
  );
}

function ProjectNotice({ notice }) {
  return (
    <div
      role={notice.kind === 'error' ? 'alert' : 'status'}
      className={`project-notice ${notice.kind === 'error' ? 'is-error' : 'is-success'}`}
    >
      {notice.kind === 'error' ? <IconAlert width={17} height={17} /> : <IconCheck width={17} height={17} />}
      <span>{notice.text}</span>
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
