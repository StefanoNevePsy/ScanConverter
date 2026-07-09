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
    label: 'Font',
    options: [
      { id: 'libertinus', label: 'Libertinus', hint: 'Corpo in "Libertinus Serif", titoli in "DejaVu Sans".' },
      { id: 'newcm', label: 'New CM (LaTeX)', hint: 'Usa "New Computer Modern" per corpo e titoli, estetica paper LaTeX.' },
      { id: 'ptserif', label: 'PT Serif', hint: 'Corpo in "PT Serif", titoli in "PT Sans".' },
      { id: 'ptsans', label: 'PT Sans', hint: 'Corpo e titoli in "PT Sans", estetica umanista.' },
      { id: 'dejavu', label: 'DejaVu Sans', hint: 'Corpo e titoli in "DejaVu Sans", pulito e moderno.' },
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
    key: 'margin',
    label: 'Margine annotazioni',
    options: [
      { id: 'wide', label: 'Ampio (4cm)', hint: 'Margine destro largo almeno 4cm per annotazioni.' },
      { id: 'xwide', label: 'Molto ampio (6cm)', hint: 'Margine destro molto largo (~6cm) per annotazioni estese.' },
      { id: 'sym', label: 'Simmetrico', hint: 'Margini simmetrici e classici, senza margine extra.' },
    ],
  },
  {
    key: 'columns',
    label: 'Colonne',
    options: [
      { id: 'one', label: 'Una colonna', hint: 'Testo su una sola colonna.' },
      { id: 'two', label: 'Due colonne', hint: 'Imposta il corpo su due colonne (columns: 2).' },
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
      { id: 'compact', label: 'Compatto', hint: 'Interlinea compatta e testo denso.' },
    ],
  },
  {
    key: 'extras',
    label: 'Extra',
    options: [
      { id: 'pagenums', label: 'Numeri di pagina', hint: 'Aggiungi i numeri di pagina in fondo.' },
      { id: 'numbered', label: 'Titoli numerati', hint: 'Numera i titoli delle sezioni (heading numbering "1.1").' },
      { id: 'runninghead', label: 'Testatina', hint: 'Aggiungi una testatina con il titolo del documento.' },
    ],
  },
];

export default function RestylePanel({ onRestyle, onHintChange, busy, disabled }) {
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState({});
  const [extra, setExtra] = useState('');

  const toggle = (groupKey, opt) =>
    setSel((s) => ({ ...s, [groupKey]: s[groupKey] === opt.id ? undefined : opt.id }));

  const buildHint = () => {
    const parts = [];
    for (const g of GROUPS) {
      const chosen = g.options.find((o) => o.id === sel[g.key]);
      if (chosen) parts.push(chosen.hint);
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
          <span className="text-sm font-medium text-ink">Rigenera layout con Gemini</span>
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
                  const active = sel[g.key] === opt.id;
                  return (
                    <button
                      key={opt.id}
                      onClick={() => toggle(g.key, opt)}
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

          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-faint">
              Rigenera dal testo OCR: le modifiche manuali al codice verranno sostituite.
            </p>
            <button
              onClick={() => onRestyle(buildHint())}
              disabled={busy}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 text-sm font-semibold text-primary-ink transition-colors hover:bg-primary-strong disabled:opacity-60"
            >
              {busy ? <IconSpinner width={15} height={15} /> : <IconRefresh width={15} height={15} />}
              {busy ? 'Rigenero…' : 'Rigenera'}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
