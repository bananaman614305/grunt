# bird-sunset

A three.js meditation scene: a bird flying into an infinite sunset. Static files only,
no build step. `three` is vendored under `vendor/` and resolved with an import map, so the
scene runs offline and through a tunnel with no CDN.

## Run it

Any static server works; the import map needs real HTTP, not `file://`.

```
python3 -m http.server 4173
# open http://localhost:4173/trials/bird-sunset/
```

To share it:

```
cloudflared tunnel --url http://127.0.0.1:4173
```

## Verify it renders

`verify-render.sh` proves the scene actually draws, rather than that the files
were merely served. It serves the repo on a free port, loads the page in headless
Chrome with software WebGL, waits for the page's own first-frame signal
(`body.ready`, set by `main.js` after `renderer.render()`), screenshots the
canvas, and decodes the PNG to reject a flat or near-uniform frame. It needs
`chrome`, `python3` and `curl` — no npm install.

```
./trials/bird-sunset/verify-render.sh                 # serve the repo, then check
./trials/bird-sunset/verify-render.sh <url>           # check a running url
```

Both the flag and the pixels are checked on purpose. A page that never draws
still loads and serves fine, and a canvas that draws nothing still reports
`ready`; either one alone would call a broken scene good.

## Controls

- `m` — ambience on/off
- `space` — pause
- `h` — hide the overlay
- `f` — full screen

The breath ring paces a slow in/out cycle. `prefers-reduced-motion` slows the flight and
the camera sway.
