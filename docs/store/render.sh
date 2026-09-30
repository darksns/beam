#!/usr/bin/env bash
# Renders the Chrome Web Store images from src/*.html with headless Chrome.
# The page captures in src/ come from `beam shot` on a local demo page.
set -e
cd "$(dirname "$0")"
CH="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
shot() { "$CH" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
  --allow-file-access-from-files --window-size="$2" --screenshot="$PWD/$3" "file://$PWD/src/$1" 2>/dev/null; }
for f in 1-read 2-fill 3-session 4-parallel 5-agents; do shot "$f.html" 1280,800 "$f.png"; done
shot tile.html 440,280 promo-tile-440x280.png
shot marquee.html 1400,560 marquee-1400x560.png
ls -1 *.png
# the store wants 24-bit images, no alpha
python3 -c "
from PIL import Image; import glob
for f in glob.glob('*.png'):
    im = Image.open(f)
    if im.mode != 'RGB': im.convert('RGB').save(f)
" 2>/dev/null || echo 'PIL missing: convert the PNGs to 24-bit (no alpha) before uploading'
