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
import re

from layout import find_figures_excluding, find_tables, heading_levels
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
        from nemotron_ocr import NemotronOCR  # type: ignore

        _MODEL = NemotronOCR.from_pretrained("nvidia/nemotron-ocr-v2", lang=variant)
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
        x0, y0, x1, y1 = _corners(region.get("bbox") or region.get("box") or [])
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

    text_boxes = [r["bbox"] for r in prepared]
    tables = find_tables(page_gray, text_boxes)
    for x0, y0, x1, y1 in tables:
        blocks.append({"type": "Table", "text": "", "bbox": _norm(x0, y0, x1, y1, width, height)})
    # Le tabelle sono già rese come tabelle: escluderle evita che tornino anche
    # come immagini ritagliate.
    for x0, y0, x1, y1 in find_figures_excluding(page_gray, text_boxes, tables):
        blocks.append({"type": "Picture", "text": "", "bbox": _norm(x0, y0, x1, y1, width, height)})
    return blocks


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
            model = load_model(self.variant)
            regions = model.predict(image)
            import numpy as np

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
