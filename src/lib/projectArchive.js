import { strFromU8, strToU8, unzip, zip } from 'fflate';

const ARCHIVE_FORMAT = 'scanconverter-project';
const ARCHIVE_SCHEMA_VERSION = 1;
const MANIFEST_PATH = 'scanconverter-manifest.json';
const SESSION_PATH = 'document/session.json';
const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 1536 * 1024 * 1024;
const MAX_ENTRIES = 20000;
const MIME = 'application/vnd.scanconverter.project+zip';

function createZip(entries) {
  return new Promise((resolve, reject) => {
    zip(entries, { level: 0 }, (error, data) => {
      if (error) reject(error);
      else resolve(data);
    });
  });
}

function openZip(data) {
  let expandedBytes = 0;
  let entries = 0;
  return new Promise((resolve, reject) => {
    try {
      unzip(
        data,
        {
          filter: (file) => {
            entries += 1;
            expandedBytes += file.originalSize;
            if (entries > MAX_ENTRIES) throw new Error('Il progetto contiene troppi elementi.');
            if (expandedBytes > MAX_EXPANDED_BYTES) {
              throw new Error('Il progetto espanso supera il limite di sicurezza di 1,5 GB.');
            }
            return (
              file.name === MANIFEST_PATH ||
              file.name === SESSION_PATH ||
              file.name.startsWith('document/parts/') ||
              file.name.startsWith('document/figures/') ||
              file.name.startsWith('document/pages/')
            );
          },
        },
        (error, files) => {
          if (error) reject(error);
          else resolve(files);
        },
      );
    } catch (error) {
      reject(error);
    }
  });
}

function pad(index) {
  return String(index).padStart(6, '0');
}

function safeBaseName(name) {
  return String(name || 'documento')
    .replace(/\.[^.]+$/u, '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '-')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 100) || 'documento';
}

function parseDataUrl(dataUrl) {
  const match = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/u.exec(String(dataUrl || ''));
  if (!match) throw new Error('Una pagina del progetto non contiene dati immagine validi.');
  const mime = match[1] || 'application/octet-stream';
  if (match[2]) {
    const binary = atob(match[3]);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return { mime, bytes };
  }
  return { mime, bytes: strToU8(decodeURIComponent(match[3])) };
}

function toDataUrl(mime, bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return `data:${mime || 'application/octet-stream'};base64,${btoa(binary)}`;
}

function parseJson(raw, label) {
  try {
    return JSON.parse(strFromU8(raw));
  } catch {
    throw new Error(`${label} del progetto non è leggibile.`);
  }
}

function readRequired(files, path) {
  const value = files[path];
  if (!value) throw new Error(`Nel progetto manca “${path}”.`);
  return value;
}

function validateManifest(value) {
  if (!value || typeof value !== 'object') throw new Error('Manifesto progetto non valido.');
  if (value.format !== ARCHIVE_FORMAT || value.schemaVersion !== ARCHIVE_SCHEMA_VERSION) {
    throw new Error('Questo file non è un progetto ScanConverter compatibile.');
  }
  if (typeof value.exportedAt !== 'string' || Number.isNaN(Date.parse(value.exportedAt))) {
    throw new Error('La data del progetto non è valida.');
  }
  for (const key of ['parts', 'figures', 'pages']) {
    if (!Array.isArray(value[key]) || value[key].length > MAX_ENTRIES) {
      throw new Error(`L’indice “${key}” del progetto non è valido.`);
    }
  }
  return value;
}

function withoutSecrets(session) {
  const json = JSON.stringify(session, (key, value) => (
    /(?:api[-_]?key|password|secret|access[-_]?token|refresh[-_]?token)/iu.test(key)
      ? undefined
      : value
  ));
  return JSON.parse(json);
}

/** Crea un archivio portatile senza includere impostazioni globali o chiavi API. */
export async function createProjectArchive({ session, parts = [], figures = [], pages = [] }) {
  if (!session?.id || typeof session.fileName !== 'string') {
    throw new Error('La sessione corrente non è ancora esportabile.');
  }

  const portableSession = withoutSecrets(session);
  const manifest = {
    format: ARCHIVE_FORMAT,
    schemaVersion: ARCHIVE_SCHEMA_VERSION,
    appVersion: '0.1.0',
    exportedAt: new Date().toISOString(),
    document: {
      fileName: session.fileName,
      sourceSessionId: session.id,
      status: session.status || '',
    },
    parts: [],
    figures: [],
    pages: [],
  };
  const entries = {
    [SESSION_PATH]: [strToU8(JSON.stringify(portableSession)), { level: 6 }],
  };

  parts.forEach((text, index) => {
    if (typeof text !== 'string' || !text) return;
    const path = `document/parts/${pad(index)}.txt`;
    entries[path] = [strToU8(text), { level: 6 }];
    manifest.parts.push({ index, path });
  });

  figures.forEach((figure, index) => {
    const bytes = figure?.bytes instanceof Uint8Array
      ? figure.bytes
      : new Uint8Array(figure?.bytes || 0);
    if (!bytes.length || typeof figure.path !== 'string') return;
    const path = `document/figures/${pad(index)}.bin`;
    entries[path] = [bytes, { level: 0 }];
    manifest.figures.push({
      path,
      documentPath: figure.path,
      widthPct: figure.widthPct ?? null,
      junk: !!figure.junk,
    });
  });

  pages.forEach((page, index) => {
    if (!Number.isInteger(page?.index) || !page.dataUrl) return;
    const decoded = parseDataUrl(page.dataUrl);
    const path = `document/pages/${pad(index)}.bin`;
    entries[path] = [decoded.bytes, { level: 0 }];
    manifest.pages.push({ index: page.index, path, mime: decoded.mime });
  });

  entries[MANIFEST_PATH] = [strToU8(JSON.stringify(manifest, null, 2)), { level: 6 }];
  const expandedBytes = Object.values(entries).reduce(
    (total, entry) => total + (entry?.[0]?.byteLength || 0),
    0,
  );
  if (expandedBytes > MAX_EXPANDED_BYTES) {
    throw new Error('Il progetto supera il limite di sicurezza di 1,5 GB.');
  }
  const bytes = await createZip(entries);
  if (bytes.byteLength > MAX_ARCHIVE_BYTES) {
    throw new Error('Il progetto compresso supera il limite di sicurezza di 1 GB.');
  }
  return {
    bytes,
    fileName: `${safeBaseName(session.fileName)}.scanconverter`,
    summary: {
      parts: manifest.parts.length,
      figures: manifest.figures.length,
      pages: manifest.pages.length,
    },
  };
}

/** Legge e valida un archivio prima di scrivere qualunque dato locale. */
export async function inspectProjectArchive(input) {
  const size = Number(input?.size ?? input?.byteLength ?? 0);
  if (size > MAX_ARCHIVE_BYTES) {
    throw new Error('Il progetto supera il limite di sicurezza di 1 GB.');
  }
  const bytes = input instanceof Uint8Array
    ? input
    : new Uint8Array(await input.arrayBuffer());
  const files = await openZip(bytes);
  const manifest = validateManifest(parseJson(readRequired(files, MANIFEST_PATH), 'Il manifesto'));
  const session = parseJson(readRequired(files, SESSION_PATH), 'Lo stato del documento');
  delete files[MANIFEST_PATH];
  delete files[SESSION_PATH];
  if (!session || typeof session !== 'object' || typeof session.fileName !== 'string') {
    throw new Error('Lo stato del documento non è valido.');
  }

  const parts = [];
  for (const item of manifest.parts) {
    if (!Number.isInteger(item?.index) || !item.path?.startsWith('document/parts/')) {
      throw new Error('L’indice delle parti OCR non è valido.');
    }
    parts[item.index] = strFromU8(readRequired(files, item.path));
    delete files[item.path];
  }

  const figures = manifest.figures.map((item) => {
    if (!item?.path?.startsWith('document/figures/') || typeof item.documentPath !== 'string') {
      throw new Error('L’indice delle figure non è valido.');
    }
    const figure = {
      path: item.documentPath,
      bytes: readRequired(files, item.path),
      widthPct: item.widthPct ?? undefined,
      junk: !!item.junk,
    };
    delete files[item.path];
    return figure;
  });

  const pages = manifest.pages.map((item) => {
    if (!Number.isInteger(item?.index) || !item.path?.startsWith('document/pages/')) {
      throw new Error('L’indice delle pagine non è valido.');
    }
    const page = {
      index: item.index,
      dataUrl: toDataUrl(item.mime, readRequired(files, item.path)),
    };
    delete files[item.path];
    return page;
  });

  return {
    manifest,
    session,
    parts,
    figures,
    pages,
    fileName: session.fileName,
  };
}

export const projectArchiveMime = MIME;
