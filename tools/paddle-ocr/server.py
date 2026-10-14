"""
Server PaddleOCR-VL locale per ScanConverter.

Imita l'API del servizio online di Baidu AI Studio (`POST /layout-parsing`),
così l'app usa lo stesso codice per le due strade: cambia solo l'indirizzo.

Avvio:
    python server.py --host 127.0.0.1 --port 8001
    python server.py --warmup     # scarica il modello e termina

I pesi finiscono in PADDLE_PDX_CACHE_HOME (lo script di setup la imposta
nella cartella scelta dall'utente).
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import logging
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(message)s")
log = logging.getLogger("paddle-ocr")

_PIPELINE: Any = None
# Il modello non è rientrante: una pagina alla volta.
_LOCK = threading.Lock()
_LOAD_LOCK = threading.Lock()


def load_pipeline():
    global _PIPELINE
    with _LOAD_LOCK:
        if _PIPELINE is None:
            _load()
    return _PIPELINE


def _load():
    global _PIPELINE
    log.info("Carico PaddleOCR-VL (al primo avvio scarica il modello)…")
    from paddleocr import PaddleOCRVL  # type: ignore

    _PIPELINE = PaddleOCRVL()
    log.info("Modello pronto.")


def decode_image(payload: str):
    from PIL import Image  # type: ignore

    data = payload.split(",", 1)[1] if payload.startswith("data:") else payload
    return Image.open(io.BytesIO(base64.b64decode(data))).convert("RGB")


def _plain(value):
    """Rende serializzabile in JSON quello che esce dal modello (ndarray, …)."""
    if hasattr(value, "tolist"):
        return value.tolist()
    if isinstance(value, dict):
        return {k: _plain(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_plain(v) for v in value]
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    # Oggetti blocco: si prendono i campi che servono all'app.
    out = {}
    for key in ("block_label", "block_content", "block_bbox", "label", "content", "bbox"):
        if hasattr(value, key):
            out[key] = _plain(getattr(value, key))
    return out or str(value)


def to_blocks(result) -> list[dict]:
    """Estrae `parsing_res_list` dal risultato, qualunque forma abbia."""
    data = getattr(result, "json", None)
    if callable(data):
        data = data()
    if not isinstance(data, dict):
        data = dict(result) if hasattr(result, "keys") else {}
    data = data.get("res", data)
    items = data.get("parsing_res_list") or []
    blocks = []
    for item in items:
        item = _plain(item)
        if not isinstance(item, dict):
            continue
        blocks.append(
            {
                "block_label": item.get("block_label") or item.get("label") or "text",
                "block_content": item.get("block_content") or item.get("content") or "",
                "block_bbox": item.get("block_bbox") or item.get("bbox") or [],
            }
        )
    return blocks


def parse_page(image) -> dict:
    import numpy as np

    pipeline = load_pipeline()
    with _LOCK:
        output = list(pipeline.predict(np.asarray(image)[:, :, ::-1]))  # RGB → BGR
    blocks = to_blocks(output[0]) if output else []
    return {
        "errorCode": 0,
        "errorMsg": "Success",
        "result": {
            "layoutParsingResults": [
                {
                    "prunedResult": {
                        "width": image.width,
                        "height": image.height,
                        "parsing_res_list": blocks,
                    }
                }
            ]
        },
    }


class Handler(BaseHTTPRequestHandler):
    def _send(self, code: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        # L'app gira su un'altra origine: senza CORS il browser blocca tutto.
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:  # noqa: N802
        self._send(204, {})

    def do_GET(self) -> None:  # noqa: N802
        if self.path.rstrip("/") == "/health":
            self._send(200, {"status": "ok", "model": "PaddleOCR-VL", "loaded": _PIPELINE is not None})
        else:
            self._send(404, {"errorCode": 404, "errorMsg": "usa POST /layout-parsing"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path.rstrip("/") != "/layout-parsing":
            self._send(404, {"errorCode": 404, "errorMsg": "usa POST /layout-parsing"})
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
            payload = json.loads(self.rfile.read(length) or b"{}")
            image = decode_image(payload.get("file") or "")
            response = parse_page(image)
            n = len(response["result"]["layoutParsingResults"][0]["prunedResult"]["parsing_res_list"])
            log.info("Pagina elaborata: %d blocchi", n)
            self._send(200, response)
        except Exception as exc:  # noqa: BLE001 — l'errore va restituito all'app
            log.exception("Errore durante l'OCR")
            self._send(500, {"errorCode": 500, "errorMsg": str(exc)})

    def log_message(self, *args) -> None:
        """Silenzia il log per richiesta."""


def main() -> None:
    parser = argparse.ArgumentParser(description="Server PaddleOCR-VL per ScanConverter")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8001)
    parser.add_argument("--warmup", action="store_true", help="scarica il modello e termina")
    args = parser.parse_args()

    if args.warmup:
        load_pipeline()
        return

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    log.info("In ascolto su http://%s:%d/layout-parsing", args.host, args.port)
    # Il modello si carica subito in un thread: la prima pagina non aspetta.
    threading.Thread(target=load_pipeline, daemon=True).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log.info("Arresto.")


if __name__ == "__main__":
    main()
