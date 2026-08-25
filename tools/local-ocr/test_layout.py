"""
Test dell'analisi di layout su pagine sintetiche.

Le pagine vengono disegnate qui: così ogni test sa esattamente dove ha messo
titoli, figure e tabelle, e può verificare che il rilevamento li ritrovi. Non
serve né GPU né il modello OCR — questa parte è geometria pura.

    python test_layout.py
"""

from __future__ import annotations

import sys

import numpy as np

from layout import (
    estimate_skew,
    find_figures,
    find_ruling_lines,
    find_tables,
    heading_levels,
    ink_mask,
)

PASSED: list[str] = []
FAILED: list[str] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    (PASSED if condition else FAILED).append(f"{name}{(' — ' + detail) if detail else ''}")


def blank_page(w: int = 800, h: int = 1000) -> np.ndarray:
    """Pagina bianca (255 = carta)."""
    return np.full((h, w), 255, dtype=np.uint8)


def draw(page: np.ndarray, x0: int, y0: int, x1: int, y1: int, value: int = 0) -> None:
    page[y0:y1, x0:x1] = value


# --------------------------------------------------------------- titoli


def test_heading_by_rank() -> None:
    """Le righe più alte diventano titoli, e il corpo resta corpo."""
    regions = [
        {"bbox": (100, 40, 700, 92), "text": "Teoria e prassi"},          # 52 px
        {"bbox": (100, 140, 500, 172), "text": "Le origini del gruppo"},  # 32 px
        {"bbox": (100, 200, 780, 220), "text": "Il gruppo si è diviso subito dopo."},
        {"bbox": (100, 230, 780, 250), "text": "Un secondo paragrafo di prosa."},
        {"bbox": (100, 260, 780, 280), "text": "Un terzo paragrafo di prosa."},
    ]
    types = heading_levels(regions)
    check("titolo principale", types[0] == "Title", types[0])
    check("titolo di sezione", types[1] == "Section-header", types[1])
    check("prosa non promossa", types[2:] == ["Text"] * 3, str(types[2:]))


def test_heading_scale_invariance() -> None:
    """Raddoppiando la risoluzione la gerarchia non deve cambiare."""
    base = [
        {"bbox": (0, 0, 600, 50), "text": "Titolo"},
        {"bbox": (0, 100, 600, 120), "text": "Corpo del testo qui."},
        {"bbox": (0, 130, 600, 150), "text": "Ancora corpo del testo."},
    ]
    doubled = [
        {"bbox": tuple(v * 2 for v in r["bbox"]), "text": r["text"]} for r in base
    ]
    check("gerarchia invariante alla scala", heading_levels(base) == heading_levels(doubled))


def test_long_paragraph_is_not_a_heading() -> None:
    """Un paragrafo lungo stampato grande non è un titolo."""
    regions = [
        {
            "bbox": (0, 0, 700, 60),
            "text": "Questa è una frase molto lunga che prosegue per parecchie parole e termina con un punto.",
        },
        {"bbox": (0, 100, 700, 120), "text": "Corpo."},
        {"bbox": (0, 130, 700, 150), "text": "Corpo."},
    ]
    check("paragrafo lungo resta testo", heading_levels(regions)[0] == "Text")


def test_uniform_page_has_no_headings() -> None:
    """Una pagina tutta di prosa non deve inventare titoli."""
    regions = [{"bbox": (0, i * 30, 700, i * 30 + 20), "text": f"Riga {i}."} for i in range(10)]
    check("nessun titolo inventato", set(heading_levels(regions)) == {"Text"})


# --------------------------------------------------------------- figure


def test_figure_detection() -> None:
    """Un blocco d'inchiostro fuori dalle righe di testo è una figura."""
    page = blank_page()
    text_boxes = []
    for i in range(6):  # colonna di righe di testo in alto
        y = 60 + i * 30
        draw(page, 80, y, 720, y + 18)
        text_boxes.append((80, y, 720, y + 18))
    draw(page, 200, 500, 600, 800)  # la figura

    figures = find_figures(page, text_boxes)
    check("una figura trovata", len(figures) == 1, str(figures))
    if figures:
        x0, y0, x1, y1 = figures[0]
        inside = x0 <= 210 and y0 <= 510 and x1 >= 590 and y1 >= 790
        check("riquadro figura corretto", inside, str(figures[0]))


def test_text_only_page_has_no_figures() -> None:
    """Se c'è solo testo non deve emergere alcuna figura."""
    page = blank_page()
    text_boxes = []
    for i in range(20):
        y = 40 + i * 30
        draw(page, 80, y, 720, y + 18)
        text_boxes.append((80, y, 720, y + 18))
    check("nessuna figura fantasma", find_figures(page, text_boxes) == [], "trovate figure")


def test_scan_noise_is_ignored() -> None:
    """Granelli sparsi di scansione non devono diventare figure."""
    page = blank_page()
    rng = np.random.default_rng(7)
    for _ in range(400):
        y, x = int(rng.integers(0, 990)), int(rng.integers(0, 790))
        draw(page, x, y, x + 2, y + 2)
    check("rumore ignorato", find_figures(page, []) == [], "rumore scambiato per figura")


# -------------------------------------------------------------- tabelle


def test_bordered_table() -> None:
    """Griglia disegnata: i righelli la individuano."""
    page = blank_page()
    for y in (300, 360, 420, 480):           # righelli orizzontali
        draw(page, 100, y, 700, y + 3)
    for x in (100, 400, 700):                # righelli verticali
        draw(page, x, 300, x + 3, 480)

    rules = find_ruling_lines(page)
    check("righelli orizzontali", len(rules["horizontal"]) == 4, str(rules["horizontal"]))
    # I separatori di colonna sono alti quanto la TABELLA, non quanto la pagina:
    # vanno cercati nella fascia delimitata dai righelli orizzontali.
    band = (min(rules["horizontal"]), max(rules["horizontal"]))
    in_band = find_ruling_lines(page, band=band)
    check("righelli verticali nella fascia", len(in_band["vertical"]) == 3, str(in_band["vertical"]))
    check("righelli verticali non su tutta la pagina", rules["vertical"] == [], str(rules["vertical"]))
    tables = find_tables(page, [])
    check("tabella bordata trovata", len(tables) >= 1, str(tables))


def test_borderless_table_by_alignment() -> None:
    """Senza bordi resta l'allineamento delle colonne."""
    text_boxes = []
    for i in range(5):                        # 5 righe x 3 colonne allineate
        y = 400 + i * 40
        for x in (100, 300, 500):
            text_boxes.append((x, y, x + 120, y + 22))
    tables = find_tables(blank_page(), text_boxes)
    check("tabella non bordata trovata", len(tables) >= 1, str(tables))
    if tables:
        x0, y0, x1, y1 = tables[0]
        check("riquadro tabella plausibile", x0 <= 100 and y1 >= 560, str(tables[0]))


def test_shared_mask_gives_the_same_answers() -> None:
    """
    La maschera d'inchiostro si calcola una volta per pagina e si passa a
    tabelle e figure. Deve dare gli stessi riquadri del calcolo separato — e
    non deve restare sporcata da chi la usa: `find_figures` cancella il testo
    dalla maschera, e se lo facesse su quella condivisa il chiamante dopo di
    lui vedrebbe una pagina mezza vuota.
    """
    rng = np.random.default_rng(4)
    page = blank_page()
    for i in range(6):
        _glyph_line(page, 80, 60 + i * 30, 720, 78 + i * 30, rng)
    for y in (300, 360, 420, 480):
        draw(page, 100, y, 700, y + 3)
    for x in (100, 400, 700):
        draw(page, x, 300, x + 3, 480)
    draw(page, 120, 700, 400, 900, 40)
    boxes = [(80, 60 + i * 30, 720, 78 + i * 30) for i in range(6)]

    condivisa = ink_mask(page)
    prima = condivisa.sum()
    tabelle_sep = find_tables(page, boxes)
    figure_sep = find_figures(page, boxes)
    tabelle_cond = find_tables(page, boxes, mask=condivisa)
    figure_cond = find_figures(page, boxes, mask=condivisa)

    check("tabelle uguali con la maschera condivisa", tabelle_sep == tabelle_cond)
    check("figure uguali con la maschera condivisa", figure_sep == figure_cond)
    check("maschera condivisa non sporcata", condivisa.sum() == prima)


def test_prose_is_not_a_table() -> None:
    """Righe di prosa a piena larghezza non sono una tabella."""
    text_boxes = [(80, 40 + i * 30, 720, 58 + i * 30) for i in range(15)]
    check("prosa non scambiata per tabella", find_tables(blank_page(), text_boxes) == [])


# --------------------------------------------------------- inclinazione


def _skewed_text_page(angle: float, rng) -> np.ndarray:
    """Pagina di righe di testo, appoggiata storta sul vetro."""
    from PIL import Image

    page = blank_page(900, 1200)
    for i in range(24):
        y = 80 + i * 45
        _glyph_line(page, 120, y, 780, y + 26, rng)
    return np.asarray(
        Image.fromarray(page).rotate(angle, resample=Image.BILINEAR, fillcolor=255),
        dtype=np.uint8,
    )


def _exhaustive_skew(gray: np.ndarray, limit: float = 5.0, step: float = 0.25) -> float:
    """La ricerca esaustiva, tenuta qui come metro di paragone."""
    return estimate_skew(gray, limit=limit, step=step, _coarse=step)


def test_skew_search_matches_exhaustive() -> None:
    """
    La ricerca in due tempi deve dare esattamente l'angolo della ricerca
    esaustiva: è un'ottimizzazione, non un'approssimazione. Se un giorno il
    punteggio cambiasse forma e i due passaggi divergessero, si scopre qui.
    """
    rng = np.random.default_rng(5)
    diverse = []
    for atteso in (-3.5, -2.0, -0.75, 0.0, 1.25, 2.5, 4.0):
        page = _skewed_text_page(atteso, rng)
        rapida, lenta = estimate_skew(page), _exhaustive_skew(page)
        if abs(rapida - lenta) > 1e-9:
            diverse.append(f"{atteso:+.2f}: {rapida:+.2f} invece di {lenta:+.2f}")
        # E l'angolo trovato deve essere quello che RADDRIZZA la pagina, cioè
        # l'opposto di quello con cui è stata storta.
        if abs(rapida + atteso) > 0.5:
            diverse.append(f"storta di {atteso:+.2f}: raddrizza di {rapida:+.2f}")
    check("ricerca rapida uguale a esaustiva", not diverse, "; ".join(diverse))


def test_skew_of_straight_page_is_zero() -> None:
    """Una pagina dritta non va raddrizzata."""
    rng = np.random.default_rng(9)
    check("pagina dritta", abs(estimate_skew(_skewed_text_page(0.0, rng))) <= 0.25)


# --------------------------------------------------- pagina completa


def _glyph_line(page: np.ndarray, x0: int, y0: int, x1: int, y1: int, rng) -> None:
    """Riga di testo realistica: glifi separati da spazi, non una barra piena."""
    x = x0
    while x < x1 - 6:
        w = int(rng.integers(3, 7))
        draw(page, x, y0, min(x + w, x1), y1)
        x += w + int(rng.integers(2, 4))


def test_full_page_integration() -> None:
    """Titolo, prosa, tabella bordata e figura: ognuno al posto giusto."""
    from server import to_blocks

    rng = np.random.default_rng(3)
    page = blank_page()
    regions = []

    _glyph_line(page, 100, 40, 700, 92, rng)
    regions.append({"text": "Teoria e prassi", "bbox": [100, 40, 700, 92]})
    for i in range(6):
        y = 150 + i * 30
        _glyph_line(page, 80, y, 720, y + 18, rng)
        regions.append({"text": f"Riga di prosa numero {i}.", "bbox": [80, y, 720, y + 18]})

    for y in (600, 660, 720):                 # tabella bordata
        draw(page, 100, y, 700, y + 3)
    for x in (100, 400, 700):
        draw(page, x, 600, x + 3, 723)
    draw(page, 200, 800, 600, 950)            # figura

    blocks = to_blocks(regions, 800, 1000, page_gray=page)
    kinds: dict[str, int] = {}
    for b in blocks:
        kinds[b["type"]] = kinds.get(b["type"], 0) + 1

    check("un titolo", kinds.get("Title") == 1, str(kinds))
    check("sei righe di prosa", kinds.get("Text") == 6, str(kinds))
    check("una tabella", kinds.get("Table") == 1, str(kinds))
    check("una figura, non due", kinds.get("Picture") == 1, str(kinds))
    check(
        "coordinate normalizzate",
        all(0 <= v <= 1 for b in blocks for v in b["bbox"].values()),
    )
    table = next((b for b in blocks if b["type"] == "Table"), None)
    if table:
        check(
            "riquadro tabella aderente",
            abs(table["bbox"]["ymin"] - 0.60) < 0.03 and abs(table["bbox"]["ymax"] - 0.72) < 0.03,
            str(table["bbox"]),
        )


def test_official_v2_normalized_regions() -> None:
    """L'output left/upper/right/lower di NemotronOCRV2 resta normalizzato."""
    from server import to_blocks

    blocks = to_blocks(
        [{
            "text": "Riga riconosciuta",
            "left": 0.10,
            "upper": 0.25,
            "right": 0.90,
            "lower": 0.20,
            "confidence": 0.98,
        }],
        800,
        1000,
    )
    box = blocks[0]["bbox"]
    check(
        "coordinate ufficiali Nemotron OCR v2",
        abs(box["xmin"] - 0.10) < 1e-6
        and abs(box["xmax"] - 0.90) < 1e-6
        and abs(box["ymin"] - 0.20) < 1e-6
        and abs(box["ymax"] - 0.25) < 1e-6,
        str(box),
    )


def main() -> int:
    for fn in [
        test_heading_by_rank,
        test_heading_scale_invariance,
        test_long_paragraph_is_not_a_heading,
        test_uniform_page_has_no_headings,
        test_figure_detection,
        test_text_only_page_has_no_figures,
        test_scan_noise_is_ignored,
        test_bordered_table,
        test_borderless_table_by_alignment,
        test_shared_mask_gives_the_same_answers,
        test_prose_is_not_a_table,
        test_skew_search_matches_exhaustive,
        test_skew_of_straight_page_is_zero,
        test_full_page_integration,
        test_official_v2_normalized_regions,
    ]:
        fn()

    for name in PASSED:
        print(f"  ok   {name}")
    for name in FAILED:
        print(f"  FAIL {name}")
    print(f"\n{len(PASSED)} superati, {len(FAILED)} falliti")
    return 1 if FAILED else 0


if __name__ == "__main__":
    sys.exit(main())
