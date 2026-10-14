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
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

def _prefer_bundled_cuda_libs() -> None:
    """Usa cuDNN installato nell'ambiente prima di quello di sistema.

    Su Windows Paddle carica cuDNN dal PATH: se un altro programma ha messo
    una versione diversa (es. 9.5 invece di 9.9), il modello può bloccarsi.
    """
    import site
    import sys

    roots = [*site.getsitepackages(), site.getusersitepackages()]
    for root in roots:
        for sub in ("cudnn", "cublas", "cuda_runtime"):
            for folder in ("bin", "lib"):
                path = os.path.join(root, "nvidia", sub, folder)
                if os.path.isdir(path):
                    os.environ["PATH"] = path + os.pathsep + os.environ.get("PATH", "")
                    if sys.platform == "win32" and hasattr(os, "add_dll_directory"):
                        os.add_dll_directory(path)


_prefer_bundled_cuda_libs()

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(message)s")
log = logging.getLogger("paddle-ocr")

_PIPELINE: Any = None
# Il modello non è rientrante: una pagina alla volta.
_LOCK = threading.Lock()
_LOAD_LOCK = threading.Lock()
# Ultima attività e richieste in corso: servono allo spegnimento per inattività.
_LAST_ACTIVITY = time.monotonic()
_BUSY = 0
_BUSY_LOCK = threading.Lock()


def idle_watchdog(seconds: int) -> None:
    """Spegne il server dopo `seconds` senza pagine: libera la memoria.

    L'app desktop lo riaccende da sola alla pagina successiva.
    """
    while True:
        time.sleep(15)
        with _BUSY_LOCK:
            idle = _BUSY == 0 and time.monotonic() - _LAST_ACTIVITY > seconds
        if idle:
            log.info("Nessuna pagina da %d minuti: mi spengo per liberare memoria.", seconds // 60)
            os._exit(0)


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

    device = detect_device()
    log.info("Dispositivo: %s", device)
    _PIPELINE = PaddleOCRVL(device=device)
    log.info("Modello pronto.")


def detect_device() -> str:
    """GPU se PaddlePaddle è compilato con CUDA e la vede, altrimenti CPU."""
    try:
        import paddle  # type: ignore

        if paddle.device.is_compiled_with_cuda() and paddle.device.cuda.device_count() > 0:
            return "gpu:0"
        log.warning(
            "PaddlePaddle non usa la GPU (compilato con CUDA: %s). Sul solo processore "
            "PaddleOCR-VL è lentissimo e spesso fallisce: reinstalla da ScanConverter.",
            paddle.device.is_compiled_with_cuda(),
        )
    except Exception as exc:  # noqa: BLE001
        log.warning("Impossibile verificare la GPU: %s", exc)
    return "cpu"


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
            self._send(200, {"status": "ok", "model": "PaddleOCR-VL", "loaded": _PIPELINE is not None, "device": detect_device()})
        else:
            self._send(404, {"errorCode": 404, "errorMsg": "usa POST /layout-parsing"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path.rstrip("/") != "/layout-parsing":
            self._send(404, {"errorCode": 404, "errorMsg": "usa POST /layout-parsing"})
            return
        global _LAST_ACTIVITY, _BUSY
        with _BUSY_LOCK:
            _BUSY += 1
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
        finally:
            with _BUSY_LOCK:
                _BUSY -= 1
                _LAST_ACTIVITY = time.monotonic()

    def log_message(self, *args) -> None:
        """Silenzia il log per richiesta."""


def main() -> None:
    parser = argparse.ArgumentParser(description="Server PaddleOCR-VL per ScanConverter")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8001)
    parser.add_argument("--warmup", action="store_true", help="scarica il modello e termina")
    parser.add_argument(
        "--idle-exit",
        type=int,
        default=0,
        help="secondi senza pagine dopo cui il server si spegne (0 = mai)",
    )
    args = parser.parse_args()

    # Pacchetti mancanti = installazione rimasta a metà: lo si dice subito,
    # invece di fallire alla prima pagina con un errore incomprensibile.
    missing = []
    for module in ("PIL", "numpy", "paddleocr", "paddle"):
        try:
            __import__(module)
        except Exception:  # noqa: BLE001
            missing.append(module)
    if missing:
        log.error(
            "Installazione incompleta, mancano: %s. Rilancia «Scarica e installa PaddleOCR» "
            "dalle impostazioni e controlla nel registro il primo errore.",
            ", ".join(missing),
        )
        raise SystemExit(3)

    if args.warmup:
        load_pipeline()
        return

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    log.info("In ascolto su http://%s:%d/layout-parsing", args.host, args.port)
    # Il modello si carica subito in un thread: la prima pagina non aspetta.
    threading.Thread(target=load_pipeline, daemon=True).start()
    if args.idle_exit > 0:
        threading.Thread(target=idle_watchdog, args=(args.idle_exit,), daemon=True).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log.info("Arresto.")


if __name__ == "__main__":
    main()
