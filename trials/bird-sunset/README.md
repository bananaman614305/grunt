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

## Controls

- `m` — ambience on/off
- `space` — pause
- `h` — hide the overlay
- `f` — full screen

The breath ring paces a slow in/out cycle. `prefers-reduced-motion` slows the flight and
the camera sway.
