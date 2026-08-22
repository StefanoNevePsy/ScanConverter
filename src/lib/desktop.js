import { figureCollectionSignature } from './verificationCache.js';

const EMPTY_FIGURES = [];
const figureSets = new WeakMap();
const uploadedFigureSets = new Set();
let capabilitiesPromise = null;
let nativeEngineDisabled = false;

function bridge() {
  return typeof window !== 'undefined' ? window.scanConverterDesktop : null;
}

function figureSetFor(figures) {
  const collection = Array.isArray(figures) ? figures : EMPTY_FIGURES;
  let value = figureSets.get(collection);
  if (!value) {
    const digest = figureCollectionSignature(collection);
    value = { id: `fig-${digest}`, digest };
    figureSets.set(collection, value);
  }
  return { ...value, collection };
}

function serializedFigure(figure) {
  return {
    path: String(figure?.path || ''),
    bytes: figure?.bytes instanceof Uint8Array
      ? figure.bytes
      : new Uint8Array(figure?.bytes || []),
  };
}

async function uploadFigureSet(api, figureSet) {
  let result = await api.prepareTypstFigureSet({ figureSetId: figureSet.id, reset: true });
  if (!result?.ok) return result;
  for (const figure of figureSet.collection) {
    result = await api.prepareTypstFigureSet({
      figureSetId: figureSet.id,
      figure: serializedFigure(figure),
    });
    if (!result?.ok) return result;
  }
  result = await api.prepareTypstFigureSet({ figureSetId: figureSet.id, finalize: true });
  if (result?.ok) uploadedFigureSets.add(figureSet.id);
  return result;
}

export async function desktopCapabilities() {
  const api = bridge();
  if (!api?.isDesktop || typeof api.capabilities !== 'function') {
    return { desktop: false, nativeTypst: false };
  }
  if (!capabilitiesPromise) {
    capabilitiesPromise = api.capabilities().catch(() => ({ desktop: true, nativeTypst: false }));
  }
  return capabilitiesPromise;
}

export async function hasNativeTypstEngine() {
  if (nativeEngineDisabled) return false;
  const capabilities = await desktopCapabilities();
  return Boolean(capabilities.nativeTypst);
}

/**
 * Chiede al processo desktop di compilare con il binario Typst ufficiale.
 * Ritorna null soltanto se il backend nativo non è disponibile: il chiamante
 * può quindi ricadere sul WASM senza duplicare compilazioni con errori reali.
 */
export async function compileWithNativeTypst(source, figures, diagnoseOnly = false) {
  if (!(await hasNativeTypstEngine())) return null;
  const api = bridge();
  const figureSet = figureSetFor(figures);

  try {
    const request = {
      source,
      diagnoseOnly,
      figureSetId: figureSet.id,
      figureDigest: figureSet.digest,
    };
    // Prima si tenta la cache persistente: alla riapertura di un libro evita
    // sia Typst sia il trasferimento IPC di tutte le figure. Soltanto un miss
    // chiede di registrare il progetto e ripete la compilazione.
    let result = await api.compileTypst(request);
    if (result?.code === 'UNKNOWN_FIGURE_SET') {
      const prepared = await uploadFigureSet(api, figureSet);
      if (prepared?.infrastructure || !prepared?.ok) {
        nativeEngineDisabled = true;
        console.warn('Impossibile registrare le figure nel motore nativo:', prepared?.error);
        return null;
      }
      result = await api.compileTypst(request);
    }
    if (result?.figureSetReady) uploadedFigureSets.add(figureSet.id);
    if (result?.infrastructure) {
      nativeEngineDisabled = true;
      console.warn('Motore Typst nativo non disponibile, uso il fallback WASM:', result.error);
      return null;
    }
    return result;
  } catch (error) {
    nativeEngineDisabled = true;
    console.warn('Bridge Typst desktop non disponibile, uso il fallback WASM:', error);
    return null;
  }
}

export function isDesktopPdfArtifact(value) {
  return Boolean(value && value.kind === 'desktop-pdf' && value.id && value.url);
}

export function hasPdfData(value) {
  return isDesktopPdfArtifact(value) || Boolean(value?.length);
}

export async function saveDesktopPdf(value, fileName) {
  if (!isDesktopPdfArtifact(value) || typeof bridge()?.savePdf !== 'function') return null;
  return bridge().savePdf({ id: value.id, fileName });
}

export function releaseDesktopPdf(value) {
  if (!isDesktopPdfArtifact(value) || typeof bridge()?.releasePdf !== 'function') return;
  bridge().releasePdf(value.id).catch(() => {});
}
