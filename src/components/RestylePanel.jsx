import { useEffect, useState } from 'react';
import { IconRefresh, IconSpinner } from './Icons.jsx';

/*
  Pannello per ri-promptare Gemini e rigenerare l'impaginazione senza rifare
  l'OCR. Le scelte rapide vengono tradotte in istruzioni di stile; c'è anche
  un campo libero per richieste specifiche.
*/

const GROUPS = [
  {
    key: 'font',
    label: 'Font corpo',
    options: [
      { id: 'libertinus', label: 'Libertinus', hint: 'Corpo del testo in "Libertinus Serif".' },
      { id: 'newcm', label: 'New CM (LaTeX)', hint: 'Corpo del testo in "New Computer Modern", estetica paper LaTeX.' },
      { id: 'ptserif', label: 'PT Serif', hint: 'Corpo del testo in "PT Serif".' },
      { id: 'ptsans', label: 'PT Sans', hint: 'Corpo del testo in "PT Sans", estetica umanista.' },
      { id: 'dejavu', label: 'DejaVu Sans', hint: 'Corpo del testo in "DejaVu Sans", pulito e moderno.' },
    ],
  },
  {
    key: 'textsize',
    label: 'Dimensione testo',
    options: [
      { id: 'small', label: 'Compatta (10pt)', hint: 'Corpo del testo a 10pt.' },
      { id: 'normal', label: 'Normale (11pt)', hint: 'Corpo del testo a 11pt.' },
      { id: 'large', label: 'Grande (12pt)', hint: 'Corpo del testo a 12pt.' },
      { id: 'xlarge', label: 'Accessibile (13pt)', hint: 'Corpo del testo a 13pt, molto leggibile.' },
    ],
  },
  {
    key: 'headfont',
    label: 'Font titoli',
    options: [
      { id: 'body', label: 'Come il corpo', hint: 'Titoli nello stesso font del corpo, coerenti su TUTTI i livelli.' },
      { id: 'dejavu', label: 'DejaVu Sans', hint: 'Tutti i titoli (ogni livello) in "DejaVu Sans".' },
      { id: 'ptsans', label: 'PT Sans', hint: 'Tutti i titoli (ogni livello) in "PT Sans".' },
      { id: 'newcm', label: 'New CM', hint: 'Tutti i titoli (ogni livello) in "New Computer Modern".' },
      { id: 'libertinus', label: 'Libertinus', hint: 'Tutti i titoli (ogni livello) in "Libertinus Serif".' },
    ],
  },
  {
    key: 'headingalign',
    label: 'Allineamento titoli',
    options: [
      { id: 'left', label: 'Sinistra', hint: 'Titoli allineati a sinistra.' },
      { id: 'center', label: 'Centrati', hint: 'Titoli centrati.' },
      { id: 'right', label: 'Destra', hint: 'Titoli allineati a destra.' },
    ],
  },
  {
    key: 'paper',
    label: 'Formato pagina',
    options: [
      { id: 'a4', label: 'A4', hint: 'Formato pagina A4.' },
      { id: 'a5', label: 'A5', hint: 'Formato pagina A5.' },
      { id: 'letter', label: 'US Letter', hint: 'Formato pagina US Letter.' },
    ],
  },
  {
    key: 'orientation',
    label: 'Orientamento',
    options: [
      { id: 'portrait', label: 'Verticale', hint: 'Pagina in orientamento verticale.' },
      { id: 'landscape', label: 'Orizzontale', hint: 'Pagina in orientamento orizzontale.' },
    ],
  },
  {
    key: 'margin',
    label: 'Margine annotazioni',
    options: [
      { id: 'wide', label: 'Ampio (4cm)', hint: 'Margine destro largo almeno 4cm per annotazioni.' },
      { id: 'xwide', label: 'Molto ampio (6cm)', hint: 'Margine destro molto largo (~6cm) per annotazioni estese.' },
      { id: 'sym', label: 'Simmetrico', hint: 'Margini simmetrici e classici, senza margine extra.' },
      { id: 'narrow', label: 'Compatto (2cm)', hint: 'Margini compatti da 2cm per sfruttare meglio la pagina.' },
    ],
  },
  {
    key: 'columns',
    label: 'Colonne',
    options: [
      { id: 'one', label: 'Una colonna', hint: 'Testo su una sola colonna.' },
      { id: 'two', label: 'Due colonne', hint: 'Imposta il corpo su due colonne (columns: 2).' },
      { id: 'three', label: 'Tre colonne', hint: 'Imposta il corpo su tre colonne (columns: 3).' },
    ],
  },
  {
    key: 'align',
    label: 'Allineamento',
    options: [
      { id: 'justify', label: 'Giustificato', hint: 'Testo giustificato (justify: true).' },
      { id: 'ragged', label: 'A bandiera', hint: 'Testo allineato a sinistra, non giustificato.' },
    ],
  },
  {
    key: 'density',
    label: 'Densità',
    options: [
      { id: 'airy', label: 'Arioso', hint: 'Interlinea generosa e spaziatura ariosa.' },
      { id: 'normal', label: 'Normale', hint: 'Interlinea e spaziatura equilibrate.' },
      { id: 'compact', label: 'Compatto', hint: 'Interlinea compatta e testo denso.' },
    ],
  },
  {
    key: 'indent',
    label: 'Rientro paragrafi',
    options: [
      { id: 'none', label: 'Nessuno', hint: 'Nessun rientro di prima riga.' },
      { id: 'small', label: 'Leggero', hint: 'Rientro leggero della prima riga.' },
      { id: 'normal', label: 'Classico', hint: 'Rientro classico della prima riga.' },
      { id: 'deep', label: 'Profondo', hint: 'Rientro marcato della prima riga.' },
    ],
  },
  {
    key: 'extras',
    label: 'Extra (più scelte)',
    multi: true,
    options: [
      { id: 'pagenums', label: 'Numeri di pagina', hint: 'Aggiungi i numeri di pagina in fondo.' },
      { id: 'numbered', label: 'Titoli numerati', hint: 'Numera i titoli delle sezioni (heading numbering "1.1").' },
      { id: 'runninghead', label: 'Testatina', hint: 'Aggiungi una testatina con il titolo del documento.' },
      { id: 'noindent', label: 'Senza rientro', hint: 'Paragrafi senza rientro di prima riga.' },
      { id: 'hyphenate', label: 'Sillabazione', hint: 'Abilita la sillabazione automatica italiana.' },
    ],
  },
];

export default function RestylePanel({ onRestyle, onApplyLocal, onHintChange, busy, disabled, strict = false }) {
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState({});
  const [extra, setExtra] = useState('');

  const toggle = (group, opt) =>
    setSel((s) => {
      if (group.multi) {
        const cur = new Set(Array.isArray(s[group.key]) ? s[group.key] : []);
        if (cur.has(opt.id)) cur.delete(opt.id);
        else cur.add(opt.id);
        return { ...s, [group.key]: [...cur] };
      }
      return { ...s, [group.key]: s[group.key] === opt.id ? undefined : opt.id };
    });

  const isActive = (group, opt) =>
    group.multi
      ? Array.isArray(sel[group.key]) && sel[group.key].includes(opt.id)
      : sel[group.key] === opt.id;

  const buildHint = () => {
    const parts = [];
    for (const g of GROUPS) {
      for (const o of g.options) {
        if (isActive(g, o)) parts.push(o.hint);
      }
    }
    if (extra.trim()) parts.push(extra.trim());
    return parts.join(' ');
  };

  // Comunica la scelta di stile corrente (per il "Copia prompt + testo").
  useEffect(() => {
    onHintChange?.(buildHint());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel, extra]);

  return (
    <section className="card overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-2/50 disabled:opacity-50"
        aria-expanded={open}
      >
        <span className="flex items-center gap-2.5">
          <IconRefresh width={16} height={16} className="text-primary" />
          <span className="text-sm font-medium text-ink">{strict ? 'Personalizza layout' : 'Rigenera layout con Gemini'}</span>
          <span className="hidden text-xs text-faint sm:inline">
            font, margini, densità · senza rifare l’OCR
          </span>
        </span>
        <span className={`text-faint transition-transform ${open ? 'rotate-180' : ''}`}>▾</span>
      </button>

      {open && (
        <div className="space-y-4 border-t border-border px-4 py-4">
          {GROUPS.map((g) => (
            <div key={g.key}>
              <div className="mb-1.5 text-xs font-medium text-muted">{g.label}</div>
              <div className="flex flex-wrap gap-2">
                {g.options.map((opt) => {
                  const active = isActive(g, opt);
                  return (
                    <button
                      key={opt.id}
                      onClick={() => toggle(g, opt)}
                      className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                        active
                          ? 'border-primary bg-primary-soft text-primary'
                          : 'border-border bg-surface-2 text-muted hover:text-ink'
                      }`}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}

          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted">
              Istruzioni extra (opzionale)
            </label>
            <textarea
              value={extra}
              onChange={(e) => setExtra(e.target.value)}
              rows={2}
              placeholder="es. “titoli centrati e in maiuscoletto, numeri di pagina in basso, due colonne”"
              className="w-full resize-none rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-ink placeholder:text-faint focus:border-primary focus:outline-none"
            />
          </div>

          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs text-faint">
              <span className="text-ink">Applica</span> cambia font/margini/layout
              all’istante, senza AI (le istruzioni extra richiedono la rigenerazione).
            </p>
            <div className="flex shrink-0 items-center gap-2">
              <button
                onClick={() => onApplyLocal(sel)}
                disabled={busy}
                className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 text-sm font-semibold text-primary-ink transition-colors hover:bg-primary-strong disabled:opacity-60"
              >
                <IconRefresh width={15} height={15} />
                Applica (senza AI)
              </button>
              {onRestyle && (
                <button
                  onClick={() => onRestyle(buildHint())}
                  disabled={busy}
                  title="Rigenera l'intero layout con l'AI dal testo OCR"
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm font-medium text-ink transition-colors hover:bg-surface-3 disabled:opacity-60"
                >
                  {busy ? <IconSpinner width={15} height={15} /> : <IconRefresh width={15} height={15} />}
                  {busy ? 'Rigenero…' : 'Rigenera con AI'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
