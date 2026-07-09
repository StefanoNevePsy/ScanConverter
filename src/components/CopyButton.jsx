import { useState } from 'react';
import { IconCopy, IconCheck } from './Icons.jsx';

/** Pulsante "copia negli appunti" con feedback temporaneo. */
export default function CopyButton({ getText, label = 'Copia', className = '', disabled }) {
  const [done, setDone] = useState(false);

  const copy = async () => {
    const text = typeof getText === 'function' ? getText() : getText;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Fallback per contesti senza Clipboard API (es. http non sicuro).
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
      } catch {
        /* nessun metodo disponibile */
      }
      ta.remove();
    }
    setDone(true);
    setTimeout(() => setDone(false), 1600);
  };

  return (
    <button
      onClick={copy}
      disabled={disabled}
      className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
    >
      {done ? <IconCheck width={14} height={14} /> : <IconCopy width={14} height={14} />}
      {done ? 'Copiato' : label}
    </button>
  );
}
