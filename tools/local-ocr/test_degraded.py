"""
Prova di resistenza su pagine ROVINATE.

`test_layout.py` verifica il comportamento su pagine pulite. Ma questa app
esiste per le fotocopie storte, sbiadite e macchiate: se il rilevamento regge
solo sul pulito non serve a niente. Qui la stessa pagina viene degradata in
modi realistici, uno per volta e poi tutti insieme, e si misura cosa
sopravvive.

Degradi simulati:
  inclinazione     la pagina appoggiata storta sullo scanner (0,5°–3°)
  rumore           granelli sale-e-pepe della fotocopia
  illuminazione    sfumatura di grigio: lampada dello scanner non uniforme
  macchia          alone scuro di caffè o di piega
  bordo nero       la banda scura del coperchio dello scanner aperto
  sbiadito         contrasto basso, inchiostro grigio invece che nero

    python test_degraded.py
"""

from __future__ import annotations

import sys

import numpy as np
from PIL import Image

from layout import find_figures_excluding, find_tables, heading_levels
from server import to_blocks

RESULTS: list[tuple[str, bool, str]] = []


def record(name: str, ok: bool, detail: str = "") -> None:
    RESULTS.append((name, ok, detail))


# ------------------------------------------------------ costruzione pagina


def build_page(rng):
    """Pagina di riferimento: titolo, prosa, tabella bordata, figura."""
    page = np.full((1000, 800), 255, dtype=np.uint8)
    regions = []

    def glyphs(x0, y0, x1, y1):
        x = x0
        while x < x1 - 6:
            w = int(rng.integers(3, 7))
            page[y0:y1, x : min(x + w, x1)] = 0
            x += w + int(rng.integers(2, 4))

    glyphs(100, 40, 700, 92)
    regions.append({"text": "Teoria e prassi", "bbox": [100, 40, 700, 92]})
    for i in range(6):
        y = 150 + i * 30
        glyphs(80, y, 720, y + 18)
        regions.append({"text": f"Riga di prosa numero {i}.", "bbox": [80, y, 720, y + 18]})

    for y in (600, 660, 720):
        page[y : y + 3, 100:700] = 0
    for x in (100, 400, 700):
        page[600:723, x : x + 3] = 0

    page[800:950, 200:600] = 0
    return page, regions


# ------------------------------------------------------------- degradazioni


def skew(page: np.ndarray, degrees: float) -> np.ndarray:
    """Ruota la pagina come se fosse appoggiata storta sul vetro."""
    img = Image.fromarray(page).rotate(degrees, resample=Image.BILINEAR, fillcolor=255)
    return np.asarray(img)


def speckle(page: np.ndarray, amount: float, rng) -> np.ndarray:
    """Granelli sale-e-pepe sparsi, tipici della fotocopia."""
    out = page.copy()
    n = int(out.size * amount)
    ys = rng.integers(0, out.shape[0], n)
    xs = rng.integers(0, out.shape[1], n)
    out[ys, xs] = 0
    return out


def uneven_light(page: np.ndarray, strength: int = 60) -> np.ndarray:
    """Sfumatura: un lato della pagina più scuro dell'altro."""
    h, w = page.shape
    ramp = np.linspace(0, strength, w, dtype=np.int16)[None, :]
    return np.clip(page.astype(np.int16) - ramp, 0, 255).astype(np.uint8)


def stain(page: np.ndarray, cx: int, cy: int, radius: int, darkness: int = 90) -> np.ndarray:
    """Alone scuro tondeggiante: caffè, umidità, piega."""
    h, w = page.shape
    yy, xx = np.ogrid[:h, :w]
    mask = (xx - cx) ** 2 + (yy - cy) ** 2 <= radius**2
    out = page.astype(np.int16)
    out[mask] -= darkness
    return np.clip(out, 0, 255).astype(np.uint8)


def dark_edge(page: np.ndarray, width: int = 30) -> np.ndarray:
    """Banda nera del bordo: coperchio dello scanner aperto."""
    out = page.copy()
    out[:, :width] = 20
    return out


def faded(page: np.ndarray, floor: int = 110) -> np.ndarray:
    """Inchiostro sbiadito: il nero diventa grigio medio."""
    out = page.copy()
    out[out < 128] = floor
    return out


def jitter_boxes(regions, rng, amount: int = 4):
    """I riquadri dell'OCR non sono mai perfetti: spostali di qualche pixel."""
    out = []
    for r in regions:
        x0, y0, x1, y1 = r["bbox"]
        d = lambda: int(rng.integers(-amount, amount + 1))  # noqa: E731
        out.append({"text": r["text"], "bbox": [x0 + d(), y0 + d(), x1 + d(), y1 + d()]})
    return out


# ------------------------------------------------------------------ misura


def evaluate(name: str, page: np.ndarray, regions, max_pictures: int = 2) -> None:
    """Conta cosa viene riconosciuto su una pagina degradata."""
    blocks = to_blocks(regions, page.shape[1], page.shape[0], page_gray=page)
    kinds: dict[str, int] = {}
    for b in blocks:
        kinds[b["type"]] = kinds.get(b["type"], 0) + 1

    titles = kinds.get("Title", 0)
    texts = kinds.get("Text", 0)
    tables = kinds.get("Table", 0)
    pictures = kinds.get("Picture", 0)

    record(f"{name} · titolo riconosciuto", titles == 1, f"{titles}")
    record(f"{name} · prosa non promossa", texts == 6, f"{texts}")
    record(f"{name} · tabella trovata", tables >= 1, f"{tables}")
    record(f"{name} · figura trovata", pictures >= 1, f"{pictures}")
    record(f"{name} · figure spurie contenute", pictures <= max_pictures, f"{pictures}")


def main() -> int:
    rng = np.random.default_rng(11)
    clean, regions = build_page(rng)

    evaluate("pulita", clean, regions)
    evaluate("inclinata 1°", skew(clean, 1.0), jitter_boxes(regions, rng))
    evaluate("inclinata 3°", skew(clean, 3.0), jitter_boxes(regions, rng))
    evaluate("rumore", speckle(clean, 0.004, rng), jitter_boxes(regions, rng))
    evaluate("luce disomogenea", uneven_light(clean), regions)
    evaluate("macchia", stain(clean, 650, 300, 120), regions)
    evaluate("bordo nero", dark_edge(clean), regions)
    evaluate("sbiadita", faded(clean), regions)

    worst = faded(
        dark_edge(stain(uneven_light(speckle(skew(clean, 2.0), 0.003, rng)), 650, 300, 110))
    )
    # Caso limite: TUTTI i difetti insieme. Qui non si pretende la pulizia —
    # si pretende che la figura vera esca comunque e che le candidate in più
    # restino poche, perché finiscono nella revisione figure dove l'utente le
    # toglie con un clic. È un cedimento visibile e correggibile, non silenzioso.
    evaluate("tutto insieme", worst, jitter_boxes(regions, rng), max_pictures=6)

    by_case: dict[str, list[bool]] = {}
    for name, ok, detail in RESULTS:
        case = name.split(" · ")[0]
        by_case.setdefault(case, []).append(ok)
        print(f"  {'ok  ' if ok else 'FAIL'} {name}" + (f" — {detail}" if detail else ""))

    print()
    for case, oks in by_case.items():
        print(f"  {case:20s} {sum(oks)}/{len(oks)}")

    total_ok = sum(1 for _, ok, _ in RESULTS if ok)
    print(f"\n{total_ok}/{len(RESULTS)} controlli superati")
    # Su pagine rovinate non si pretende la perfezione: si pretende di sapere
    # DOVE cede. La soglia serve a far fallire il test se peggiora.
    return 0 if total_ok >= len(RESULTS) * 0.8 else 1


if __name__ == "__main__":
    sys.exit(main())
