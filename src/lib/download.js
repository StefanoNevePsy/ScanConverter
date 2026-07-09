/*
  Salvataggio del PDF, cross-platform.

  Sul web basta un blob + <a download>. Nella WebView Android quel meccanismo
  NON funziona: si scrive il file con Filesystem e lo si condivide/apre con il
  foglio di condivisione nativo (da lì l'utente può salvarlo o aprirlo).
*/

import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';

function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * Salva/condivide i byte del PDF con il nome indicato.
 * @param {Uint8Array} bytes
 * @param {string} fileName
 */
export async function savePdf(bytes, fileName) {
  const name = fileName.endsWith('.pdf') ? fileName : `${fileName}.pdf`;

  if (Capacitor.isNativePlatform()) {
    // Scrive nella cache e apre il foglio di condivisione nativo.
    const res = await Filesystem.writeFile({
      path: name,
      data: bytesToBase64(bytes),
      directory: Directory.Cache,
    });
    try {
      await Share.share({
        title: name,
        text: name,
        url: res.uri,
      });
    } catch {
      // L'utente ha annullato la condivisione: il file resta comunque salvato
      // nella cache dell'app.
    }
    return;
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
}
