/*
  Salvataggio del PDF, cross-platform.

  Sul web basta un blob + <a download>. Nella WebView Android quel meccanismo
  NON funziona: le due vie native sono
    - SALVA: dialogo di sistema "Salva con nome" (Storage Access Framework,
      plugin locale SaveFile) — l'utente sceglie cartella e nome in Files,
      senza permessi di storage;
    - CONDIVIDI: scrittura in cache + foglio di condivisione nativo.
*/

import { Capacitor, registerPlugin } from '@capacitor/core';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';

// Plugin locale Android (android/.../SaveFilePlugin.java): ACTION_CREATE_DOCUMENT.
const SaveFile = registerPlugin('SaveFile');

function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

const withPdfExt = (name) => (name.endsWith('.pdf') ? name : `${name}.pdf`);

/**
 * Salva il PDF sul dispositivo.
 * - Web: download classico via blob.
 * - Nativo: dialogo di sistema "Salva con nome" (scelta di cartella e nome).
 * @param {Uint8Array} bytes
 * @param {string} fileName
 * @returns {Promise<{cancelled?:boolean}>} cancelled=true se l'utente ha annullato
 */
export async function savePdf(bytes, fileName) {
  const name = withPdfExt(fileName);

  if (Capacitor.isNativePlatform()) {
    try {
      await SaveFile.save({
        name,
        mime: 'application/pdf',
        data: bytesToBase64(bytes),
      });
      return {};
    } catch (e) {
      const msg = String(e?.message || e);
      if (/cancel/i.test(msg)) return { cancelled: true };
      throw new Error(`Salvataggio non riuscito: ${msg}`);
    }
  }

  // Web: download classico via blob.
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return {};
}

/**
 * Condivide il PDF con il foglio di condivisione nativo (solo su nativo:
 * scrive in cache e apre lo share sheet; sul web ricade sul download).
 * @param {Uint8Array} bytes
 * @param {string} fileName
 */
export async function sharePdf(bytes, fileName) {
  const name = withPdfExt(fileName);

  if (!Capacitor.isNativePlatform()) return savePdf(bytes, fileName);

  const res = await Filesystem.writeFile({
    path: name,
    data: bytesToBase64(bytes),
    directory: Directory.Cache,
  });
  try {
    await Share.share({ title: name, text: name, url: res.uri });
  } catch {
    // L'utente ha annullato la condivisione: nessun errore da mostrare.
  }
  return {};
}

/** True se siamo nell'app nativa (per mostrare Salva + Condividi separati). */
export function isNativeApp() {
  return Capacitor.isNativePlatform();
}
