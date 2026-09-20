#!/usr/bin/env bash
#
# Prove trials/bird-sunset actually renders.
#
# Loads the scene in headless Chrome with software WebGL, waits for the page's
# own first-frame signal, screenshots the canvas, and decodes the PNG to check it
# is not a single flat colour. No npm dependency: only chrome, python3, curl.
#
#   ./trials/bird-sunset/verify-render.sh                 # serve the repo, then check
#   ./trials/bird-sunset/verify-render.sh <url>           # check an already-running url
#
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$DIR/../.." && pwd)"

CHROME="${CHROME:-}"
for candidate in google-chrome google-chrome-stable chromium chromium-browser; do
  if [ -z "$CHROME" ] && command -v "$candidate" >/dev/null 2>&1; then CHROME="$candidate"; fi
done
[ -n "$CHROME" ] || { echo "FAIL: no chrome on PATH (set CHROME=...)"; exit 1; }

# A free port, so a server already sitting on the obvious one does not turn the
# check into a false failure against a different directory.
PORT="${PORT:-$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')}"
SERVER_PID=""
PROFILE="$(mktemp -d /tmp/bird-verify.XXXXXX)"
SHOT="$PROFILE/frame.png"
trap 'rm -rf "$PROFILE"; [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true' EXIT

if [ "$#" -ge 1 ]; then
  URL="$1"
else
  URL="http://127.0.0.1:$PORT/trials/bird-sunset/"
  python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$REPO" >/dev/null 2>&1 &
  SERVER_PID=$!
  # Wait for the server to answer rather than sleeping a fixed amount. Kill the
  # wait if the port never came up, so this fails loudly instead of hanging.
  up=""
  for _ in $(seq 1 40); do
    if curl -fsS -o /dev/null "$URL"; then up=yes; break; fi
    kill -0 "$SERVER_PID" 2>/dev/null || break
    sleep 0.25
  done
  [ -n "$up" ] || { echo "FAIL: nothing serving $URL"; exit 1; }
fi

echo "url: $URL"
STATUS=$(curl -sS -o /dev/null -w '%{http_code}' "$URL" || true)
echo "http: $STATUS"
[ "$STATUS" = 200 ] || { echo "FAIL: $URL did not answer 200"; exit 1; }

# 1. The page reports its own readiness: main.js sets body.ready after the first
#    renderer.render(), so this is the scene claiming a frame was drawn.
DOM="$PROFILE/dom.html"
TMPDIR="$PROFILE" "$CHROME" --headless=new --no-sandbox --disable-gpu-sandbox \
  --enable-unsafe-swiftshader --use-gl=angle --use-angle=swiftshader \
  --user-data-dir="$PROFILE/profile" --virtual-time-budget=15000 \
  --dump-dom "$URL" > "$DOM" 2>/dev/null
if grep -q 'class="ready"' "$DOM"; then
  echo "first-frame signal: body.ready present"
else
  echo "FAIL: body.ready never appeared; the scene did not draw a frame"
  exit 1
fi

# 2. Pixels, not just a flag: screenshot the canvas and decode it. A failed or
#    empty scene comes out one flat colour, which this rejects.
TMPDIR="$PROFILE" "$CHROME" --headless=new --no-sandbox --disable-gpu-sandbox \
  --enable-unsafe-swiftshader --use-gl=angle --use-angle=swiftshader \
  --user-data-dir="$PROFILE/profile2" --window-size=1280,720 --hide-scrollbars \
  --virtual-time-budget=8000 --screenshot="$SHOT" "$URL" >/dev/null 2>&1

python3 - "$SHOT" <<'PY'
import struct, sys, zlib

path = sys.argv[1]
data = open(path, 'rb').read()
if data[:8] != b'\x89PNG\r\n\x1a\n':
    sys.exit(f'FAIL: {path} is not a PNG')

pos, idat, width, height, colortype = 8, b'', None, None, None
while pos < len(data):
    (length,) = struct.unpack('>I', data[pos:pos + 4])
    ctype = data[pos + 4:pos + 8]
    chunk = data[pos + 8:pos + 8 + length]
    pos += 12 + length
    if ctype == b'IHDR':
        width, height, depth, colortype = struct.unpack('>IIBB', chunk[:10])
        if depth != 8:
            sys.exit(f'FAIL: unsupported PNG bit depth {depth}')
    elif ctype == b'IDAT':
        idat += chunk
    elif ctype == b'IEND':
        break

channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[colortype]
stride = width * channels
raw = zlib.decompress(idat)

# Undo the per-scanline PNG filters.
rows, prev, i = [], bytearray(stride), 0
for _ in range(height):
    ftype = raw[i]
    i += 1
    line = bytearray(raw[i:i + stride])
    i += stride
    if ftype == 1:
        for x in range(channels, stride):
            line[x] = (line[x] + line[x - channels]) & 0xFF
    elif ftype == 2:
        for x in range(stride):
            line[x] = (line[x] + prev[x]) & 0xFF
    elif ftype == 3:
        for x in range(stride):
            a = line[x - channels] if x >= channels else 0
            line[x] = (line[x] + ((a + prev[x]) >> 1)) & 0xFF
    elif ftype == 4:
        for x in range(stride):
            a = line[x - channels] if x >= channels else 0
            b = prev[x]
            c = prev[x - channels] if x >= channels else 0
            p = a + b - c
            pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
            pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
            line[x] = (line[x] + pr) & 0xFF
    elif ftype != 0:
        sys.exit(f'FAIL: unknown PNG filter {ftype}')
    rows.append(line)
    prev = line

# Sample the frame; a one-colour image is a blank render.
colors, darkest, brightest = set(), 255, 0
for y in range(0, height, 4):
    row = rows[y]
    for x in range(0, stride, 4 * channels):
        px = bytes(row[x:x + channels])
        colors.add(px)
        level = sum(px) // len(px)
        darkest = min(darkest, level)
        brightest = max(brightest, level)
        if len(colors) > 4096:
            break
    if len(colors) > 4096:
        break

print(f'frame: {width}x{height}, {len(colors)}{"+" if len(colors) > 4096 else ""} distinct sampled colours')
print(f'levels: darkest {darkest}, brightest {brightest}')
if len(colors) <= 1:
    sys.exit('FAIL: the frame is a single flat colour; the scene did not render')
if brightest - darkest < 24:
    sys.exit('FAIL: the frame is nearly uniform; the scene did not render')
print('OK: the scene renders')
PY