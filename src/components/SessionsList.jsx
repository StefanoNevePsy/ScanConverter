import { useState } from 'react';
import { IconRefresh, IconTrash, IconCheck, IconClock, IconFile, IconDownload } from './Icons.jsx';

/*
  Elenco delle sessioni salvate su IndexedDB: riprendi/riapri o elimina.
  Le sessioni "in sospeso" (interrotte) sono in evidenza; quelle completate
  si possono riaprire per rigenerare/scaricare il PDF.
*/

function relTime(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const m = Math.round(diff / 60000);
  if (m < 1) return 'ora';
  if (m < 60) return `${m} min fa`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h fa`;
  const d = Math.round(h / 24);
  return `${d} g fa`;
}

export default function SessionsList({ sessions, onOpen, onDelete, onExport, exportBusy }) {
  const [confirmId, setConfirmId] = useState(null);

  return (
    <section className="overflow-hidden rounded-xl border border-border-strong bg-surface/60">
      <header className="border-b border-border-strong px-4 py-3">
        <h3 className="font-display text-xl font-medium tracking-[-0.02em] text-ink">
          Sessioni salvate{' '}
          <span className="text-faint">({sessions.length})</span>
        </h3>
      </header>
      <ul className="divide-y divide-border">
        {sessions.map((s) => {
          // L'elenco riceve il riepilogo leggero salvato da `saveSession`:
          // avanzamento già calcolato, nessun testo del documento da caricare.
          const isOcr = s.kind === 'ocr';
          const done = s.done ?? 0;
          const total = s.total ?? 0;
          const complete = s.status === 'done';
          const label = isOcr
            ? `Estrazione OCR · ${done}/${total} pagine`
            : `In sospeso · ${done}/${total} sezioni`;
          return (
            <li key={s.id} className="flex items-center gap-3 px-4 py-3.5 transition-colors hover:bg-lime-soft">
              <span
                className={`grid size-9 shrink-0 place-items-center ${
                  complete ? 'bg-success/15 text-success' : 'bg-lime text-[#11110f]'
                }`}
              >
                {complete ? (
                  <IconCheck width={18} height={18} />
                ) : (
                  <IconClock width={18} height={18} />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 truncate text-sm font-medium text-ink">
                  <IconFile width={13} height={13} className="shrink-0 text-faint" />
                  <span className="truncate">{s.fileName || 'documento'}</span>
                </div>
                <div className="mt-0.5 text-xs text-faint">
                  {complete ? 'Completata' : label} · {relTime(s.updatedAt)}
                </div>
              </div>

              {confirmId === s.id ? (
                <div className="flex shrink-0 items-center gap-2">
                  <span className="text-xs text-muted">Eliminare?</span>
                  <button
                    onClick={() => {
                      onDelete(s.id);
                      setConfirmId(null);
                    }}
                    className="rounded-md bg-danger px-2.5 py-1 text-xs font-semibold text-ink transition-opacity hover:opacity-90"
                  >
                    Sì
                  </button>
                  <button
                    onClick={() => setConfirmId(null)}
                    className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-muted hover:text-ink"
                  >
                    No
                  </button>
                </div>
              ) : (
                <div className="flex shrink-0 items-center gap-1.5">
                  <button
                    onClick={() => onExport?.(s)}
                    disabled={exportBusy}
                    aria-label={`Esporta ${s.fileName || 'documento'}`}
                    title="Esporta progetto"
                    className="rounded-lg p-1.5 text-faint transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-40"
                  >
                    <IconDownload width={16} height={16} />
                  </button>
                  <button
                    onClick={() => onOpen(s)}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-ink transition-colors hover:bg-primary-strong"
                  >
                    <IconRefresh width={13} height={13} />
                    {complete ? 'Riapri' : 'Riprendi'}
                  </button>
                  <button
                    onClick={() => setConfirmId(s.id)}
                    aria-label="Elimina sessione"
                    className="rounded-lg p-1.5 text-faint transition-colors hover:bg-surface-2 hover:text-danger"
                  >
                    <IconTrash width={16} height={16} />
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
