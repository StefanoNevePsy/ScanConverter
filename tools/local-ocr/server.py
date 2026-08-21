"""
Sidecar OCR locale — incapsula Nemotron OCR v2 e lo espone all'app.

Perché serve un sidecar: ScanConverter gira nel browser (o nella WebView di
Android/Electron) e non può caricare un modello PyTorch. Questo servizio fa da
ponte: riceve l'immagine di una pagina, la passa al modello sulla GPU e
restituisce i blocchi NELLO STESSO FORMATO di Nemotron-Parse, così tutto il
resto della pipeline dell'app — ordine di lettura, figure, assemblaggio,
verifica di fedeltà — continua a funzionare senza modifiche.

Attenzione a cosa fa e cosa non fa il modello:
  Nemotron OCR v2 (~84M parametri) è un riconoscitore di glifi in tre stadi
  (detector, recognizer, modello relazionale). Restituisce riquadri e testo,
  NON classi semantiche né Markdown. I titoli qui vengono dedotti da
  un'euristica di altezza della riga, che è un'approssimazione: la gerarchia
  esatta che dà Nemotron-Parse non è ricostruibile da questo modello.
  Gli accenti mancanti li rimette il modello linguistico locale, a valle.

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


def to_blocks(regions, width: int, height: int) -> list[dict]:
    """
    Converte le regioni del modello nei blocchi attesi dall'app.

    Il modello dà coordinate in pixel; l'app lavora con bbox normalizzate 0–1
    (le usa per ritagliare le figure e per l'ordine di lettura XY-cut).
    """
    blocks: list[dict] = []
    heights: list[float] = []

    for region in regions:
        text = (region.get("text") or "").strip()
        if not text:
            continue
        x0, y0, x1, y1 = _corners(region.get("bbox") or region.get("box") or [])
        if x1 <= x0 or y1 <= y0:
            continue
        heights.append(y1 - y0)
        blocks.append(
            {
                "text": text,
                "_px": (x0, y0, x1, y1),
                "bbox": {
                    "xmin": x0 / width,
                    "ymin": y0 / height,
                    "xmax": x1 / width,
                    "ymax": y1 / height,
                },
            }
        )

    # Euristica dei titoli: una riga molto più alta della mediana è quasi
    # sempre un'intestazione. È un'approssimazione dichiarata, non una
    # classificazione semantica: il modello non ne fornisce.
    median = sorted(heights)[len(heights) // 2] if heights else 0.0
    for block in blocks:
        _, y0, _, y1 = block.pop("_px")
        line_height = y1 - y0
        if median and line_height >= median * 1.6:
            block["type"] = "Title"
        elif median and line_height >= median * 1.25:
            block["type"] = "Section-header"
        else:
            block["type"] = "Text"
    return blocks


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
            blocks = to_blocks(regions, image.width, image.height)
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
