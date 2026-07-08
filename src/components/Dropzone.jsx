import { useCallback, useRef, useState } from 'react';
import { ACCEPTED, validateFile } from '../lib/files.js';
import { IconUpload, IconFile } from './Icons.jsx';

/**
 * Area di Drag & Drop per il caricamento della pagina scansionata.
 * Accetta immagini (PNG/JPEG/WebP) e PDF.
 */
export default function Dropzone({ onFile, disabled }) {
  const [dragging, setDragging] = useState(false);
  const [localError, setLocalError] = useState(null);
  const inputRef = useRef(null);

  const handleFiles = useCallback(
    (fileList) => {
      const file = fileList?.[0];
      const err = validateFile(file);
      if (err) {
        setLocalError(err);
        return;
      }
      setLocalError(null);
      onFile(file);
    },
    [onFile],
  );

  const onDrop = useCallback(
    (e) => {
      e.preventDefault();
      setDragging(false);
      if (disabled) return;
      handleFiles(e.dataTransfer.files);
    },
    [disabled, handleFiles],
  );

  return (
    <div>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => !disabled && inputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if ((e.key === 'Enter' || e.key === ' ') && !disabled) {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
        aria-disabled={disabled}
        className={[
          'group relative grid place-items-center rounded-2xl border-2 border-dashed px-8 py-14 text-center transition-all duration-200',
          disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
          dragging
            ? 'border-primary bg-primary-soft scale-[1.01]'
            : 'border-border-strong bg-surface/60 hover:border-primary/60 hover:bg-surface',
        ].join(' ')}
        style={{ transitionTimingFunction: 'var(--ease-out-quint)' }}
      >
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPTED.join(',')}
          className="sr-only"
          onChange={(e) => handleFiles(e.target.files)}
          disabled={disabled}
        />
        <span
          className={`mb-4 grid size-14 place-items-center rounded-2xl transition-colors ${
            dragging ? 'bg-primary text-primary-ink' : 'bg-surface-2 text-primary'
          }`}
        >
          <IconUpload width={26} height={26} />
        </span>
        <p className="text-base font-medium text-ink">
          Trascina qui la pagina scansionata
        </p>
        <p className="mt-1 text-sm text-muted">
          oppure <span className="text-primary">sfoglia i file</span> · PNG, JPEG, WebP o PDF
        </p>
        <div className="mt-4 flex items-center gap-1.5 text-xs text-faint">
          <IconFile width={14} height={14} />
          <span>Le vecchie fotocopie a basso contrasto funzionano meglio in scala di grigi.</span>
        </div>
      </div>
      {localError && (
        <p role="alert" className="mt-3 text-sm text-danger">
          {localError}
        </p>
      )}
    </div>
  );
}
