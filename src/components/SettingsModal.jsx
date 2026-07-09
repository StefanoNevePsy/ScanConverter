import { useEffect, useRef, useState } from 'react';
import { DEFAULTS } from '../lib/storage.js';
import { IconX, IconEye, IconEyeOff, IconKey } from './Icons.jsx';

/**
 * Modale di configurazione: chiavi API (NVIDIA, Google) ed endpoint/modello.
 * Le chiavi restano nel localStorage del browser. Il modale è giustificato
 * qui: è una superficie di configurazione, non un'interruzione del task.
 */
export default function SettingsModal({ open, initial, onClose, onSave }) {
  const [form, setForm] = useState(initial);
  const [showNvidia, setShowNvidia] = useState(false);
  const [showGoogle, setShowGoogle] = useState(false);
  const dialogRef = useRef(null);
  const firstFieldRef = useRef(null);

  useEffect(() => {
    if (open) {
      setForm(initial);
      // Focus sul primo campo all'apertura.
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

  if (!open) return null;

  const update = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

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
        className="card relative w-full max-w-lg p-6 shadow-2xl"
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

        <div className="mt-6 space-y-5">
          <Field
            label="NVIDIA_API_KEY"
            hint="Per l'estrazione OCR con Nemotron-Parse."
            ref={firstFieldRef}
            type={showNvidia ? 'text' : 'password'}
            value={form.nvidiaApiKey}
            onChange={update('nvidiaApiKey')}
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
            placeholder="AIza…"
            reveal={showGoogle}
            onToggle={() => setShowGoogle((v) => !v)}
            autoComplete="off"
          />

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
              <Field
                label="Modello OCR NVIDIA"
                hint="nvidia/nemotron-parse è il modello di parsing consigliato."
                value={form.nvidiaModel}
                onChange={update('nvidiaModel')}
                placeholder={DEFAULTS.nvidiaModel}
                mono
              />
              <Field
                label="Modello Gemini"
                value={form.geminiModel}
                onChange={update('geminiModel')}
                placeholder={DEFAULTS.geminiModel}
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

import { forwardRef } from 'react';

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
