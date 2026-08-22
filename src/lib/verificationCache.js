/*
  Impronta persistente della verifica PDF.

  Il PDF può essere recuperato dalla cache nativa fra due avvii, ma prima di
  fidarci del vecchio esito dobbiamo sapere che sorgente, fonte canonica,
  figure e versione del verificatore sono identici. La SHA-256 è calcolata da
  WebCrypto fuori dal thread JavaScript; delle immagini si campionano byte
  uniformemente per non copiare centinaia di MB nella UI.
*/

export const PDF_VERIFICATION_SCHEMA = 'strict-pdf-v1|typst-0.15.1';

export function figureCollectionSignature(figures = []) {
  let hash = 0x811c9dc5;
  const add = (number) => {
    hash ^= Number(number) & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  };
  for (const figure of figures || []) {
    const path = String(figure?.path || '');
    for (let index = 0; index < path.length; index++) add(path.charCodeAt(index));
    const bytes = figure?.bytes instanceof Uint8Array
      ? figure.bytes
      : new Uint8Array(figure?.bytes || []);
    for (const shift of [0, 8, 16, 24]) add(bytes.length >>> shift);
    const step = Math.max(1, Math.floor(bytes.length / 4096));
    for (let index = 0; index < bytes.length; index += step) add(bytes[index]);
    if (bytes.length) add(bytes[bytes.length - 1]);
  }
  return `${(figures || []).length.toString(36)}-${hash.toString(16).padStart(8, '0')}`;
}

function fallbackHash(value) {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193) >>> 0;
    second = Math.imul(second ^ code, 0x85ebca6b) >>> 0;
  }
  return `${first.toString(16).padStart(8, '0')}${second.toString(16).padStart(8, '0')}`;
}

export async function createPdfVerificationKey({
  source,
  canonicalText,
  figures = [],
  issueResolutions = {},
}) {
  const resolutions = JSON.stringify(
    Object.entries(issueResolutions || {}).sort(([left], [right]) => left.localeCompare(right)),
  );
  const payload = [
    PDF_VERIFICATION_SCHEMA,
    String(source || ''),
    String(canonicalText || ''),
    figureCollectionSignature(figures),
    resolutions,
  ].join('\0');
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return `${PDF_VERIFICATION_SCHEMA}:${payload.length}:${fallbackHash(payload)}`;
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(payload));
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `${PDF_VERIFICATION_SCHEMA}:${hex}`;
}

export function reusablePdfVerification(snapshot, key) {
  return Boolean(
    snapshot &&
    snapshot.key === key &&
    snapshot.pdf &&
    typeof snapshot.pdf === 'object',
  );
}
