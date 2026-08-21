import { useEffect, useMemo, useState } from 'react';
import {
  DEFAULT_LAYOUT_OPTIONS,
  normalizeLayoutOptions,
} from '../lib/preamble.js';
import { IconRefresh, IconSpinner } from './Icons.jsx';

const FONT_OPTIONS = [
  ['libertinus', 'Libertinus Serif'],
  ['newcm', 'New Computer Modern'],
  ['ptserif', 'PT Serif'],
  ['ptsans', 'PT Sans'],
  ['dejavu', 'DejaVu Sans'],
];

const HEADING_FONT_OPTIONS = [['body', 'Come il corpo'], ...FONT_OPTIONS];

function SelectField({ label, value, onChange, options, hint }) {
  return (
    <label className="layout-field">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
      </select>
      {hint && <small>{hint}</small>}
    </label>
  );
}

function NumberField({ label, value, onChange, min, max, step = 0.1, unit, hint }) {
  return (
    <label className="layout-field">
      <span>{label}</span>
      <span className="layout-number">
        <input
          type="number"
          inputMode="decimal"
          value={value}
          min={min}
          max={max}
          step={step}
          onChange={(event) => onChange(event.target.value)}
        />
        <i>{unit}</i>
      </span>
      {hint && <small>{hint}</small>}
    </label>
  );
}

function ToggleField({ label, checked, onChange, hint }) {
  return (
    <label className="layout-toggle">
      <span>
        <strong>{label}</strong>
        {hint && <small>{hint}</small>}
      </span>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <i aria-hidden="true" />
    </label>
  );
}

function Section({ title, summary, children, open = false }) {
  return (
    <details className="layout-section" open={open}>
      <summary>
        <span>{title}</span>
        <small>{summary}</small>
        <i aria-hidden="true">+</i>
      </summary>
      <div className="layout-section-body">{children}</div>
    </details>
  );
}

function hintFrom(options, extra) {
  const font = FONT_OPTIONS.find(([id]) => id === options.font)?.[1] || 'Libertinus Serif';
  const paper = options.paper === 'custom'
    ? `${options.pageWidthMm}×${options.pageHeightMm} mm`
    : options.paper.toUpperCase();
  const margins = options.marginMode === 'custom'
    ? `${options.marginTopCm}/${options.marginRightCm}/${options.marginBottomCm}/${options.marginLeftCm} cm`
    : options.marginMode === 'mirrored'
      ? `${options.marginInsideCm} cm interno e ${options.marginOutsideCm} cm esterno`
      : options.marginPreset;
  const parts = [
    `Formato ${paper}, orientamento ${options.orientation}, ${options.columns} colonna/e.`,
    `Margini ${margins}.`,
    `Corpo in ${font} a ${options.bodySizePt}pt, interlinea ${options.leadingEm}em e spaziatura paragrafi ${options.paragraphSpacingEm}em.`,
    `Titoli ${options.headingalign}, numerazione ${options.headingNumbering}.`,
  ];
  if (extra.trim()) parts.push(extra.trim());
  return parts.join(' ');
}

export default function RestylePanel({
  onRestyle,
  onApplyLocal,
  onHintChange,
  initialSelection,
  busy,
  disabled,
  strict = false,
}) {
  const [open, setOpen] = useState(false);
  const [selection, setSelection] = useState(() => normalizeLayoutOptions(initialSelection || {}));
  const [extra, setExtra] = useState('');
  const normalized = useMemo(() => normalizeLayoutOptions(selection), [selection]);
  const hint = useMemo(() => hintFrom(normalized, extra), [normalized, extra]);
  const set = (key, value) => setSelection((current) => ({ ...current, [key]: value }));

  useEffect(() => {
    setSelection(normalizeLayoutOptions(initialSelection || {}));
  }, [initialSelection]);

  useEffect(() => {
    onHintChange?.(hint);
  }, [hint, onHintChange]);

  return (
    <section className="card layout-panel overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        disabled={disabled}
        className="layout-panel-trigger"
        aria-expanded={open}
      >
        <span className="layout-panel-mark" aria-hidden="true"><i /><i /><i /></span>
        <span className="min-w-0 flex-1">
          <strong>{strict ? 'Personalizza impaginazione' : 'Atelier di impaginazione'}</strong>
          <small>Pagina, margini, testo, titoli e apparati · tutto applicabile in locale</small>
        </span>
        <span className="layout-panel-count">30+ controlli</span>
        <span className={`layout-panel-chevron ${open ? 'is-open' : ''}`} aria-hidden="true">↓</span>
      </button>

      {open && (
        <div className="layout-panel-content">
          <Section title="Pagina e margini" summary="formato, orientamento, colonne, rilegatura" open>
            <div className="layout-grid">
              <SelectField label="Formato" value={selection.paper} onChange={(value) => set('paper', value)} options={[
                ['a4', 'A4'], ['a5', 'A5'], ['b5', 'B5'], ['letter', 'US Letter'], ['legal', 'US Legal'], ['custom', 'Personalizzato'],
              ]} />
              <SelectField label="Orientamento" value={selection.orientation} onChange={(value) => set('orientation', value)} options={[
                ['portrait', 'Verticale'], ['landscape', 'Orizzontale'],
              ]} />
              <SelectField label="Colonne" value={String(selection.columns)} onChange={(value) => set('columns', value)} options={[
                ['1', 'Una'], ['2', 'Due'], ['3', 'Tre'],
              ]} />
              <SelectField label="Margini" value={selection.marginMode} onChange={(value) => set('marginMode', value)} options={[
                ['preset', 'Preset'], ['custom', 'Quattro lati'], ['mirrored', 'Pagine affiancate'],
              ]} />
              {selection.paper === 'custom' && (
                <>
                  <NumberField label="Larghezza" value={selection.pageWidthMm} onChange={(value) => set('pageWidthMm', value)} min={80} max={500} unit="mm" />
                  <NumberField label="Altezza" value={selection.pageHeightMm} onChange={(value) => set('pageHeightMm', value)} min={80} max={700} unit="mm" />
                </>
              )}
              {selection.marginMode === 'preset' && (
                <SelectField label="Preset margini" value={selection.marginPreset} onChange={(value) => set('marginPreset', value)} options={[
                  ['wide', 'Annotazioni 4 cm'], ['xwide', 'Annotazioni 6 cm'], ['sym', 'Simmetrici 2,5 cm'], ['narrow', 'Compatti 2 cm'],
                ]} />
              )}
              {selection.marginMode !== 'preset' && (
                <>
                  <NumberField label="Superiore" value={selection.marginTopCm} onChange={(value) => set('marginTopCm', value)} min={0.5} max={12} unit="cm" />
                  <NumberField label="Inferiore" value={selection.marginBottomCm} onChange={(value) => set('marginBottomCm', value)} min={0.5} max={12} unit="cm" />
                </>
              )}
              {selection.marginMode === 'custom' && (
                <>
                  <NumberField label="Sinistro" value={selection.marginLeftCm} onChange={(value) => set('marginLeftCm', value)} min={0.5} max={12} unit="cm" />
                  <NumberField label="Destro" value={selection.marginRightCm} onChange={(value) => set('marginRightCm', value)} min={0.5} max={12} unit="cm" />
                </>
              )}
              {selection.marginMode === 'mirrored' && (
                <>
                  <NumberField label="Interno" value={selection.marginInsideCm} onChange={(value) => set('marginInsideCm', value)} min={0.5} max={12} unit="cm" />
                  <NumberField label="Esterno" value={selection.marginOutsideCm} onChange={(value) => set('marginOutsideCm', value)} min={0.5} max={12} unit="cm" />
                  <SelectField label="Rilegatura" value={selection.binding} onChange={(value) => set('binding', value)} options={[
                    ['left', 'A sinistra'], ['right', 'A destra'],
                  ]} />
                </>
              )}
            </div>
          </Section>

          <Section title="Testo e paragrafi" summary="font, corpo, interlinea, rientri, sillabazione" open>
            <div className="layout-grid">
              <SelectField label="Font corpo" value={selection.font} onChange={(value) => set('font', value)} options={FONT_OPTIONS} />
              <NumberField label="Corpo" value={selection.bodySizePt} onChange={(value) => set('bodySizePt', value)} min={8} max={24} unit="pt" />
              <SelectField label="Peso" value={String(selection.bodyWeight)} onChange={(value) => set('bodyWeight', value)} options={[
                ['300', 'Leggero'], ['400', 'Regolare'], ['500', 'Medio'], ['600', 'Semibold'], ['700', 'Grassetto'],
              ]} />
              <SelectField label="Lingua" value={selection.language} onChange={(value) => set('language', value)} options={[
                ['it', 'Italiano'], ['en', 'Inglese'], ['fr', 'Francese'], ['de', 'Tedesco'], ['es', 'Spagnolo'], ['pt', 'Portoghese'],
              ]} />
              <NumberField label="Tracking" value={selection.trackingPt} onChange={(value) => set('trackingPt', value)} min={-0.2} max={1.5} step={0.05} unit="pt" />
              <NumberField label="Interlinea" value={selection.leadingEm} onChange={(value) => set('leadingEm', value)} min={0.35} max={2} step={0.05} unit="em" />
              <NumberField label="Spazio paragrafi" value={selection.paragraphSpacingEm} onChange={(value) => set('paragraphSpacingEm', value)} min={0} max={4} step={0.05} unit="em" />
              <NumberField label="Rientro prima riga" value={selection.indentEm} onChange={(value) => set('indentEm', value)} min={0} max={5} step={0.1} unit="em" />
              <SelectField label="Allineamento" value={selection.align} onChange={(value) => set('align', value)} options={[
                ['justify', 'Giustificato'], ['ragged', 'A bandiera'],
              ]} />
              <SelectField label="A capo" value={selection.linebreaks} onChange={(value) => set('linebreaks', value)} options={[
                ['optimized', 'Ottimizzato'], ['simple', 'Semplice'],
              ]} />
            </div>
            <div className="layout-toggle-row">
              <ToggleField label="Sillabazione" checked={!!selection.hyphenate} onChange={(value) => set('hyphenate', value)} hint="Usa le regole della lingua scelta" />
              <ToggleField label="Rientra tutti i paragrafi" checked={!!selection.indentAll} onChange={(value) => set('indentAll', value)} hint="Anche dopo titoli e blocchi" />
            </div>
          </Section>

          <Section title="Gerarchia dei titoli" summary="famiglia, scala, peso, ritmo, numerazione">
            <div className="layout-grid">
              <SelectField label="Font titoli" value={selection.headfont} onChange={(value) => set('headfont', value)} options={HEADING_FONT_OPTIONS} />
              <SelectField label="Peso" value={String(selection.headingWeight)} onChange={(value) => set('headingWeight', value)} options={[
                ['400', 'Regolare'], ['500', 'Medio'], ['600', 'Semibold'], ['700', 'Grassetto'], ['800', 'Extra bold'], ['900', 'Nero'],
              ]} />
              <SelectField label="Allineamento" value={selection.headingalign} onChange={(value) => set('headingalign', value)} options={[
                ['left', 'Sinistra'], ['center', 'Centro'], ['right', 'Destra'],
              ]} />
              <SelectField label="Numerazione" value={selection.headingNumbering} onChange={(value) => set('headingNumbering', value)} options={[
                ['none', 'Nessuna'], ['decimal', '1.1'], ['decimal-dot', '1.1.'], ['roman', 'I.1'],
              ]} />
              <NumberField label="Titolo livello 1" value={selection.heading1Pt} onChange={(value) => set('heading1Pt', value)} min={10} max={42} unit="pt" />
              <NumberField label="Titolo livello 2" value={selection.heading2Pt} onChange={(value) => set('heading2Pt', value)} min={9} max={36} unit="pt" />
              <NumberField label="Titolo livello 3" value={selection.heading3Pt} onChange={(value) => set('heading3Pt', value)} min={8} max={30} unit="pt" />
              <NumberField label="Titolo livello 4" value={selection.heading4Pt} onChange={(value) => set('heading4Pt', value)} min={8} max={26} unit="pt" />
              <NumberField label="Spazio sopra" value={selection.headingAboveEm} onChange={(value) => set('headingAboveEm', value)} min={0} max={5} unit="em" />
              <NumberField label="Spazio sotto" value={selection.headingBelowEm} onChange={(value) => set('headingBelowEm', value)} min={0} max={4} unit="em" />
            </div>
          </Section>

          <Section title="Navigazione e apparati" summary="pagine, testatina, figure, didascalie, note">
            <div className="layout-grid">
              <SelectField label="Numeri di pagina" value={selection.pageNumbering} onChange={(value) => set('pageNumbering', value)} options={[
                ['none', 'Nessuno'], ['arabic', 'Arabi: 1, 2, 3'], ['roman-lower', 'Romani: i, ii, iii'], ['roman-upper', 'Romani: I, II, III'],
              ]} />
              <SelectField label="Posizione numero" value={selection.pageNumberPosition} onChange={(value) => set('pageNumberPosition', value)} options={[
                ['bottom-left', 'In basso a sinistra'], ['bottom-center', 'In basso al centro'], ['bottom-right', 'In basso a destra'],
              ]} />
              <SelectField label="Testatina" value={selection.headerMode} onChange={(value) => set('headerMode', value)} options={[
                ['none', 'Nessuna'], ['title', 'Titolo documento'], ['custom', 'Testo personalizzato'],
              ]} />
              <SelectField label="Allineamento testatina" value={selection.headerAlign} onChange={(value) => set('headerAlign', value)} options={[
                ['left', 'Sinistra'], ['center', 'Centro'], ['right', 'Destra'],
              ]} />
              <NumberField label="Corpo testatina" value={selection.headerSizePt} onChange={(value) => set('headerSizePt', value)} min={6} max={16} unit="pt" />
              <SelectField label="Figure" value={selection.figureAlign} onChange={(value) => set('figureAlign', value)} options={[
                ['left', 'A sinistra'], ['center', 'Centrate'], ['right', 'A destra'],
              ]} />
              <SelectField label="Didascalie" value={selection.captionPosition} onChange={(value) => set('captionPosition', value)} options={[
                ['bottom', 'Sotto la figura'], ['top', 'Sopra la figura'],
              ]} />
              <NumberField label="Corpo didascalie" value={selection.captionSizePt} onChange={(value) => set('captionSizePt', value)} min={6} max={16} unit="pt" />
              <NumberField label="Corpo note" value={selection.footnoteSizePt} onChange={(value) => set('footnoteSizePt', value)} min={6} max={16} unit="pt" />
              <NumberField label="Spazio tra note" value={selection.footnoteGapEm} onChange={(value) => set('footnoteGapEm', value)} min={0} max={3} unit="em" />
            </div>
            {selection.headerMode === 'custom' && (
              <label className="layout-text-field">
                <span>Testo della testatina</span>
                <input value={selection.headerText} maxLength={180} onChange={(event) => set('headerText', event.target.value)} placeholder="Titolo breve, autore o collana" />
              </label>
            )}
          </Section>

          {onRestyle && (
            <label className="layout-text-field layout-ai-field">
              <span>Istruzioni creative per il modello</span>
              <textarea
                value={extra}
                onChange={(event) => setExtra(event.target.value)}
                rows={2}
                placeholder="Solo per la rigenerazione AI: es. tratta le citazioni come estratti editoriali"
              />
            </label>
          )}

          <footer className="layout-panel-footer">
            <button
              type="button"
              onClick={() => setSelection({ ...DEFAULT_LAYOUT_OPTIONS })}
              disabled={busy}
              className="button-quiet"
            >
              Ripristina valori
            </button>
            <p>Il preambolo viene ricostruito e validato localmente; il testo del documento non cambia.</p>
            <div>
              {onRestyle && (
                <button
                  type="button"
                  onClick={() => onRestyle(hint)}
                  disabled={busy}
                  className="button-secondary"
                >
                  {busy ? <IconSpinner width={15} height={15} /> : <IconRefresh width={15} height={15} />}
                  {busy ? 'Rigenero…' : 'Rigenera con AI'}
                </button>
              )}
              <button
                type="button"
                onClick={() => onApplyLocal(normalized)}
                disabled={busy}
                className="button-primary"
              >
                <IconRefresh width={15} height={15} />
                Applica e compila
              </button>
            </div>
          </footer>
        </div>
      )}
    </section>
  );
}
