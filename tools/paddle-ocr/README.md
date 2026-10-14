# Server PaddleOCR-VL locale

Alternativa locale al servizio online gratuito di PaddleOCR-VL (Baidu AI
Studio). Espone la stessa API (`POST /layout-parsing`), quindi l'app usa lo
stesso codice per entrambi.

## Installazione

Dall'app desktop: Impostazioni → Motori per fase → OCR «PaddleOCR-VL» →
«Sul mio computer» → **Scarica e installa PaddleOCR**, poi **Avvia il server**.

A mano (macOS/Linux):

    tools/setup/install-scanconverter.sh --root /percorso/ScanConverter --components paddle
    /percorso/ScanConverter/paddle-ocr/start-paddle-ocr.sh

Windows (PowerShell):

    tools\setup\Install-ScanConverter.ps1 -Root D:\ScanConverter -Components paddle
    D:\ScanConverter\paddle-ocr\start-paddle-ocr.cmd

Il server ascolta su `http://127.0.0.1:8001/layout-parsing`. Con GPU NVIDIA
viene installata la versione CUDA di PaddlePaddle; altrimenti quella CPU
(funziona, ma più lenta).
