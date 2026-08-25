"""
Sidecar OCR locale — incapsula Nemotron OCR v2 e lo espone all'app.

Perché serve un sidecar: ScanConverter gira nel browser (o nella WebView di
Android/Electron) e non può caricare un modello PyTorch. Questo servizio fa da
ponte: riceve l'immagine di una pagina, la passa al modello sulla GPU e
restituisce i blocchi NELLO STESSO FORMATO di Nemotron-Parse, così tutto il
resto della pipeline dell'app — ordine di lettura, figure, assemblaggio,
verifica di fedeltà — continua a funzionare senza modifiche.

Cosa fa e cosa non fa il modello:
  Nemotron OCR v2 (~84M parametri) è un riconoscitore di glifi in tre stadi.
  Restituisce riquadri e testo, NON classi semantiche né Markdown. Quelle
  informazioni però non sono perse: stanno nella geometria della pagina, e
  `layout.py` le ricostruisce con analisi d'immagine deterministica — titoli
  per rango delle altezze, figure come inchiostro fuori dal testo, tabelle da
  righelli e colonne allineate. Gli accenti mancanti li rimette il modello
  linguistico locale, a valle.

Requisiti (dalla scheda modello NVIDIA):
  - Linux amd64 con GPU NVIDIA (Ampere / Lovelace / Hopper / Blackwell)
  - CUDA toolkit compatibile con la versione di PyTorch installata
  - su Windows: eseguire dentro WSL2

Avvio:
    pip install -r requirements.txt
    python server.py --host 127.0.0.1 --port 8000

Poi in ScanConverter: Impostazioni → Motore OCR → «Locale (sidecar)».
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import logging
import os
import re

from layout import (
    deskew,
    estimate_skew,
    find_figures_excluding,
    find_tables,
    ink_mask,
    heading_levels,
    rotate_box,
)
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(message)s")
log = logging.getLogger("local-ocr")

# Caricato una sola volta al primo utilizzo: il modello pesa poche centinaia di
# MB, ma l'inizializzazione di CUDA non è istantanea.
_MODEL: Any = None


def load_model(variant: str):
    """Carica Nemotron OCR v2 (variante multilingue per default)."""
    global _MODEL
    if _MODEL is None:
        log.info("Carico nemotron-ocr-v2 (%s)…", variant)
        # L'import sta qui dentro così il file resta importabile (e testabile)
        # anche su una macchina senza torch né GPU.
        from nemotron_ocr.inference.pipeline_v2 import NemotronOCRV2  # type: ignore

        # Se il setup ha già clonato i pesi con Git LFS, usali direttamente:
        # evita di scaricarli una seconda volta nella cache Hugging Face.
        model_root = os.environ.get("NEMOTRON_OCR_MODEL_ROOT", "").strip()
        if model_root:
            folder = "v2_english" if variant == "english" else "v2_multilingual"
            _MODEL = NemotronOCRV2(model_dir=os.path.join(model_root, folder))
        else:
            _MODEL = NemotronOCRV2(lang="en" if variant == "english" else "multi")
        log.info("Modello pronto.")
    return _MODEL


def decode_data_url(data_url: str):
    """Estrae l'immagine PIL da un data URL `data:image/png;base64,…`."""
    from PIL import Image  # type: ignore

    match = re.match(r"^data:image/[a-zA-Z.+-]+;base64,(.*)$", data_url, re.DOTALL)
    payload = match.group(1) if match else data_url
    raw = base64.b64decode(payload)
    return Image.open(io.BytesIO(raw)).convert("RGB")


def to_blocks(regions, width: int, height: int, page_gray=None) -> list[dict]:
    """
    Converte le regioni del modello nei blocchi attesi dall'app.

    Il modello dà coordinate in pixel; l'app lavora con bbox normalizzate 0–1
    (le usa per ritagliare le figure e per l'ordine di lettura XY-cut). I tipi
    semantici — titoli, figure, tabelle — li ricava `layout.py` dalla geometria.
    """
    prepared = []
    for region in regions:
        text = (region.get("text") or "").strip()
        if not text:
            continue
        x0, y0, x1, y1 = _region_corners(region, width, height)
        if x1 <= x0 or y1 <= y0:
            continue
        prepared.append({"text": text, "bbox": (x0, y0, x1, y1)})

    types = heading_levels(prepared) if prepared else []

    blocks: list[dict] = []
    for region, kind in zip(prepared, types):
        x0, y0, x1, y1 = region["bbox"]
        blocks.append(
            {
                "type": kind,
                "text": region["text"],
                "bbox": _norm(x0, y0, x1, y1, width, height),
            }
        )

    # Figure e tabelle richiedono l'immagine: senza, si restituisce il testo.
    if page_gray is None:
        return blocks

    # RADDRIZZAMENTO. I righelli di una tabella si riconoscono come corse
    # orizzontali continue: se la pagina è appoggiata storta sul vetro non lo
    # sono più, e la tabella sparisce. Si stima l'inclinazione, si analizza la
    # pagina raddrizzata e si riportano i riquadri trovati nello spazio
    # originale, che è quello da cui l'app ritaglia.
    angle = estimate_skew(page_gray)
    straight = deskew(page_gray, angle)
    sh, sw = straight.shape
    straight_boxes = [rotate_box(b, -angle, sw, sh) for b in (r["bbox"] for r in prepared)]

    def back(box):
        return rotate_box(box, angle, width, height)

    # La maschera d'inchiostro è la parte cara dell'analisi e serve identica a
    # tabelle e figure: si calcola una volta sola per pagina.
    mask = ink_mask(straight)

    tables = find_tables(straight, straight_boxes, mask=mask)
    for x0, y0, x1, y1 in (back(t) for t in tables):
        blocks.append({"type": "Table", "text": "", "bbox": _norm(x0, y0, x1, y1, width, height)})
    # Le tabelle sono già rese come tabelle: escluderle evita che tornino anche
    # come immagini ritagliate.
    for x0, y0, x1, y1 in (
        back(f) for f in find_figures_excluding(straight, straight_boxes, tables, mask=mask)
    ):
        blocks.append({"type": "Picture", "text": "", "bbox": _norm(x0, y0, x1, y1, width, height)})
    return blocks


def _region_corners(region, width: int, height: int) -> tuple[float, float, float, float]:
    """Accetta sia il vecchio bbox pixel sia l'output normalizzato ufficiale v2."""
    names = ("left", "upper", "right", "lower")
    if all(region.get(name) is not None for name in names):
        left, upper, right, lower = (float(region[name]) for name in names)
        # NemotronOCRV2 restituisce coordinate 0–1. La tolleranza lascia
        # funzionare anche un eventuale backend che restituisca già pixel.
        if max(abs(left), abs(upper), abs(right), abs(lower)) <= 1.5:
            left *= width
            right *= width
            upper *= height
            lower *= height
        return _corners([left, upper, right, lower])
    return _corners(region.get("bbox") or region.get("box") or [])


def _norm(x0, y0, x1, y1, width: int, height: int) -> dict:
    """Coordinate pixel → frazioni di pagina, come le attende l'app."""
    return {
        "xmin": max(0.0, min(1.0, x0 / width)),
        "ymin": max(0.0, min(1.0, y0 / height)),
        "xmax": max(0.0, min(1.0, x1 / width)),
        "ymax": max(0.0, min(1.0, y1 / height)),
    }


def _corners(box) -> tuple[float, float, float, float]:
    """Accetta [x0,y0,x1,y1] oppure un poligono [[x,y], …]."""
    if not box:
        return (0.0, 0.0, 0.0, 0.0)
    if isinstance(box[0], (list, tuple)):
        xs = [float(p[0]) for p in box]
        ys = [float(p[1]) for p in box]
        return (min(xs), min(ys), max(xs), max(ys))
    x0, y0, x1, y1 = (float(v) for v in box[:4])
    return (min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1))


class Handler(BaseHTTPRequestHandler):
    variant = "multilingual"

    def _send(self, code: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        # L'app gira su un'altra origine (file://, app://, localhost:5173):
        # senza questi header il browser bloccherebbe la risposta.
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:  # noqa: N802  (nome imposto da BaseHTTPRequestHandler)
        self._send(204, {})

    def do_GET(self) -> None:  # noqa: N802
        if self.path.rstrip("/") == "/health":
            self._send(200, {"status": "ok", "variant": self.variant})
        else:
            self._send(404, {"error": "usa POST /ocr"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path.rstrip("/") != "/ocr":
            self._send(404, {"error": "usa POST /ocr"})
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
            payload = json.loads(self.rfile.read(length) or b"{}")
            image = decode_data_url(payload.get("image") or "")
            import numpy as np

            model = load_model(self.variant)
            # L'API ufficiale v2 accetta ndarray/bytes/path ed è invocabile;
            # `predict(PIL.Image)` apparteneva alla vecchia API.
            regions = model(np.asarray(image), merge_level="sentence")
            gray = np.asarray(image.convert("L"))
            blocks = to_blocks(regions, image.width, image.height, page_gray=gray)
            log.info("Pagina elaborata: %d blocchi", len(blocks))
            self._send(200, {"blocks": blocks})
        except Exception as exc:  # noqa: BLE001 — l'errore va restituito all'app
            log.exception("Errore durante l'OCR")
            self._send(500, {"error": str(exc)})

    def log_message(self, *args) -> None:
        """Silenzia il log per richiesta: usiamo il nostro."""


def main() -> None:
    parser = argparse.ArgumentParser(description="Sidecar OCR per ScanConverter")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument(
        "--variant",
        default="multilingual",
        choices=["multilingual", "english"],
        help="variante del modello; 'multilingual' per i documenti non inglesi",
    )
    args = parser.parse_args()

    Handler.variant = args.variant
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    log.info("In ascolto su http://%s:%d/ocr", args.host, args.port)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log.info("Arresto.")


if __name__ == "__main__":
    main()
