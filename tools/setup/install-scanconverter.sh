#!/usr/bin/env sh
#
# Installa gli accessori locali di ScanConverter dove decidi tu (macOS/Linux).
#
# Gemello di Install-ScanConverter.ps1: stesse cartelle, stesse variabili,
# stesso file di esito. Vedi quello per il perché di ogni scelta.
#
#   ./install-scanconverter.sh --root /Volumes/Esterno/ScanConverter
#   ./install-scanconverter.sh --root ~/sc --model qwen3:4b --components ollama
#
# Rieseguibile: quello che c'è già viene saltato. Se un disco esterno cambia
# punto di mount, rilanciarlo con il nuovo percorso rimette a posto le
# variabili senza riscaricare nulla.

set -eu

TYPST_VERSION='0.15.1'
ROOT=''
MODEL='qwen3:8b'
TRANSLATION_MODEL='translategemma:4b'
COMPONENTS='ollama typst'
SKIP_MODEL=0

cyan()  { printf '\n=== %s\n' "$1"; }
ok()    { printf '  ok   %s\n' "$1"; }
skip()  { printf '  --   %s (già presente)\n' "$1"; }
warn()  { printf '  !    %s\n' "$1"; }

usage() {
  sed -n '3,17p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --root)       ROOT="${2:?--root richiede un percorso}"; shift 2 ;;
    --model)      MODEL="${2:?--model richiede un nome}"; shift 2 ;;
    --translation-model) TRANSLATION_MODEL="${2:?--translation-model richiede un nome}"; shift 2 ;;
    --components) COMPONENTS="$(echo "${2:?}" | tr ',' ' ')"; shift 2 ;;
    --skip-model) SKIP_MODEL=1; shift ;;
    -h|--help)    usage 0 ;;
    *)            printf 'Opzione sconosciuta: %s\n' "$1" >&2; usage 1 ;;
  esac
done

[ -n "$ROOT" ] || { printf '%s\n' 'Manca --root.' >&2; usage 1; }

case "$ROOT" in
  '~'/*) ROOT="$HOME/${ROOT#\~/}" ;;
esac
mkdir -p "$ROOT"
ROOT="$(cd "$ROOT" && pwd)"

has() { command -v "$1" >/dev/null 2>&1; }
wants() { case " $COMPONENTS " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

# Il file di profilo giusto dipende dalla shell: su macOS il default è zsh,
# su Linux quasi sempre bash. Scrivere nel posto sbagliato significa che la
# variabile non viene letta e i modelli finiscono di nuovo nella home.
profile_file() {
  case "${SHELL:-}" in
    */zsh)  printf '%s\n' "$HOME/.zshrc" ;;
    */bash) [ -f "$HOME/.bash_profile" ] && printf '%s\n' "$HOME/.bash_profile" \
              || printf '%s\n' "$HOME/.bashrc" ;;
    *)      printf '%s\n' "$HOME/.profile" ;;
  esac
}

# Idempotente: se la riga c'è già con lo stesso valore non fa niente; se il
# valore è cambiato (disco esterno rimontato altrove) la sostituisce.
set_env() {
  name="$1"; value="$2"; file="$(profile_file)"
  line="export $name=\"$value\""
  if [ -f "$file" ] && grep -qxF "$line" "$file"; then
    skip "$name=$value"
  else
    [ -f "$file" ] && grep -v "^export $name=" "$file" > "$file.sc-tmp" 2>/dev/null \
      && mv "$file.sc-tmp" "$file" || true
    printf '%s\n' "$line" >> "$file"
    ok "$name=$value (in $file)"
  fi
  export "$name=$value"
}

install_ollama() {
  cyan 'Modello linguistico (Ollama)'
  mkdir -p "$ROOT/models"
  # Prima la variabile, poi il download: al contrario i modelli finirebbero
  # in ~/.ollama e andrebbero riscaricati.
  set_env OLLAMA_MODELS "$ROOT/models"

  if has ollama; then
    skip "ollama ($(command -v ollama))"
  elif [ "$(uname -s)" = 'Darwin' ]; then
    warn 'Ollama non installato: scaricalo da https://ollama.com/download e rilancia.'
    warn 'Su macOS è un.app: si installa in /Applications, ma i MODELLI seguono OLLAMA_MODELS.'
    return
  else
    printf '       installo Ollama…\n'
    curl -fsSL https://ollama.com/install.sh | sh
    has ollama && ok 'Ollama installato' || { warn 'Installazione non riuscita.'; return; }
  fi

  [ "$SKIP_MODEL" -eq 1 ] && { warn 'Modello non scaricato (--skip-model).'; return; }
  cyan "Modelli $MODEL e $TRANSLATION_MODEL"
  for model_name in "$MODEL" "$TRANSLATION_MODEL"; do
    if ollama pull "$model_name"; then ok "$model_name pronto in $ROOT/models"
    else warn "«ollama pull $model_name» non è riuscito."; fi
  done
}

install_typst() {
  cyan "Compilatore Typst $TYPST_VERSION"
  dir="$ROOT/typst"
  mkdir -p "$dir"
  if [ -x "$dir/typst" ]; then
    skip "$dir/typst"
  else
    case "$(uname -s)-$(uname -m)" in
      Darwin-arm64)         asset='typst-aarch64-apple-darwin.tar.xz' ;;
      Darwin-x86_64)        asset='typst-x86_64-apple-darwin.tar.xz' ;;
      Linux-aarch64|Linux-arm64) asset='typst-aarch64-unknown-linux-musl.tar.xz' ;;
      Linux-x86_64)         asset='typst-x86_64-unknown-linux-musl.tar.xz' ;;
      *) warn "Typst nativo non disponibile per $(uname -s)-$(uname -m)."; return ;;
    esac
    staging="$(mktemp -d)"
    printf '       scarico %s\n' "$asset"
    curl -fsSL "https://github.com/typst/typst/releases/download/v$TYPST_VERSION/$asset" \
      | tar -xJ -C "$staging"
    found="$(find "$staging" -name typst -type f -print | head -n 1)"
    [ -n "$found" ] || { warn 'L’archivio non contiene il compilatore.'; rm -rf "$staging"; return; }
    cp "$found" "$dir/typst"
    for extra in LICENSE NOTICE README.md; do
      [ -f "$(dirname "$found")/$extra" ] && cp "$(dirname "$found")/$extra" "$dir/" || true
    done
    chmod 755 "$dir/typst"
    rm -rf "$staging"
    ok "Typst installato in $dir"
  fi
  # Il processo desktop cerca questa variabile prima del binario impacchettato.
  set_env SCANCONVERTER_TYPST_PATH "$dir/typst"
}

install_paddle() {
  cyan 'PaddleOCR-VL locale'
  if [ "$(uname -s)" = 'Darwin' ] && [ "$(uname -m)" = 'arm64' ]; then
    warn 'Attenzione: PaddleOCR-VL non supporta ufficialmente i Mac Apple Silicon.'
    warn 'Il server si installa, ma la lettura delle pagine può fallire.'
    warn 'Su Mac usa PaddleOCR online (Impostazioni → PaddleOCR → Online).'
  fi
  dir="$ROOT/paddle-ocr"
  src="$(cd "$(dirname "$0")/../paddle-ocr" && pwd)"
  mkdir -p "$dir" "$ROOT/paddle-cache"
  cp "$src/server.py" "$src/requirements.txt" "$dir/"
  set_env PADDLE_PDX_CACHE_HOME "$ROOT/paddle-cache"
  export UV_PYTHON_INSTALL_DIR="$ROOT/python" UV_CACHE_DIR="$ROOT/uv-cache" HF_HOME="$ROOT/hf-cache"

  # uv scarica da sé un Python compatibile: non serve quello di sistema.
  if ! has uv && [ ! -x "$HOME/.local/bin/uv" ]; then
    printf '       installo uv (gestore Python)…\n'
    curl -LsSf https://astral.sh/uv/install.sh | sh
  fi
  uv_bin="$(command -v uv || printf '%s' "$HOME/.local/bin/uv")"
  [ -d "$dir/venv" ] || "$uv_bin" venv --python 3.12 "$dir/venv"
  py="$dir/venv/bin/python"

  if [ "$(uname -s)" = 'Darwin' ]; then
    "$uv_bin" pip install --python "$py" paddlepaddle
  elif has nvidia-smi; then
    printf '       GPU NVIDIA trovata: PaddlePaddle con CUDA\n'
    "$uv_bin" pip install --python "$py" paddlepaddle-gpu \
      --extra-index-url https://www.paddlepaddle.org.cn/packages/stable/cu126/ \
      --index-strategy unsafe-best-match
  else
    "$uv_bin" pip install --python "$py" paddlepaddle \
      --extra-index-url https://www.paddlepaddle.org.cn/packages/stable/cpu/ \
      --index-strategy unsafe-best-match
  fi
  "$uv_bin" pip install --python "$py" -r "$dir/requirements.txt"
  ok 'Pacchetti installati'

  printf '       scarico il modello (una volta sola)…\n'
  if PADDLE_PDX_CACHE_HOME="$ROOT/paddle-cache" "$py" "$dir/server.py" --warmup; then
    ok "Modello in $ROOT/paddle-cache"
  else
    warn 'Download del modello non riuscito: verrà riprovato al primo avvio.'
  fi

  cat > "$dir/start-paddle-ocr.sh" <<SH
#!/usr/bin/env sh
export PADDLE_PDX_CACHE_HOME="$ROOT/paddle-cache"
exec "$py" "$dir/server.py" --host 127.0.0.1 --port 8001
SH
  chmod 755 "$dir/start-paddle-ocr.sh"
  ok "Avvio: $dir/start-paddle-ocr.sh"
}

install_sidecar() {
  cyan 'Sidecar OCR (Nemotron OCR v2)'
  mkdir -p "$ROOT/sidecar" "$ROOT/hf-cache"
  set_env HF_HOME "$ROOT/hf-cache"
  if [ "$(uname -s)" = 'Darwin' ]; then
    warn 'Il modello OCR richiede una GPU NVIDIA con CUDA: su Mac non gira.'
    warn 'Tieni l’OCR su Gemini o NVIDIA e usa il locale per le fasi testuali.'
    return
  fi
  if [ ! -d "$ROOT/sidecar/ScanConverter" ]; then
    git clone --depth 1 https://github.com/StefanoNevePsy/ScanConverter.git \
      "$ROOT/sidecar/ScanConverter"
  else
    skip "$ROOT/sidecar/ScanConverter"
  fi
  printf '\n  Per completare, dalla cartella del sidecar:\n'
  printf '    cd %s/sidecar/ScanConverter/tools/local-ocr\n' "$ROOT"
  printf '    pip install torch==2.12.1 torchvision==0.27.1 --index-url https://download.pytorch.org/whl/cu132\n'
  printf '    pip install -r requirements.txt\n'
  printf '    python server.py\n'
}

# Esito che l'app desktop legge all'avvio: solo percorsi e indirizzi locali,
# nessuna chiave e nessun dato dei documenti.
write_manifest() {
  case "$(uname -s)" in
    Darwin) dir="$HOME/Library/Application Support/ScanConverter" ;;
    *)      dir="${XDG_CONFIG_HOME:-$HOME/.config}/ScanConverter" ;;
  esac
  mkdir -p "$dir"
  typst_path=''
  wants typst && [ -x "$ROOT/typst/typst" ] && typst_path="$ROOT/typst/typst"
  model=''
  translation_model=''
  if [ "$SKIP_MODEL" -eq 0 ]; then
    model="$MODEL"
    translation_model="$TRANSLATION_MODEL"
  fi
  cat > "$dir/local-setup.json" <<JSON
{
  "schemaVersion": 1,
  "writtenAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "root": "$ROOT",
  "components": "$COMPONENTS",
  "model": "$model",
  "translationModel": "$translation_model",
  "localEndpoint": "http://localhost:11434/v1/chat/completions",
  "localOcrEndpoint": "http://localhost:8000/ocr",
  "paddleEndpoint": "http://localhost:8001/layout-parsing",
  "typstPath": "$typst_path"
}
JSON
  ok "Esito scritto in $dir/local-setup.json"
}

printf 'ScanConverter — installazione locale in %s\n' "$ROOT"
wants ollama  && install_ollama
wants typst   && install_typst
wants sidecar && install_sidecar
wants paddle  && install_paddle
write_manifest

cyan 'Fatto'
cat <<'TXT'
  Nell'app: Impostazioni -> Motori per fase -> scegli «Locale» dove vuoi.
  Gli indirizzi predefiniti (Ollama su 11434, sidecar su 8000) vanno già bene.

  Le variabili valgono dal prossimo terminale: apri una finestra nuova, e
  riavvia Ollama e ScanConverter.

  Disco esterno: se cambia punto di mount, rilancia con il nuovo --root.
  Non riscarica nulla, rimette solo a posto i percorsi.
TXT
