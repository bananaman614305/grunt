# Fix the config loader

`loadConfig(text)` in `load.js` parses a `key = value` config file (comments
start with `#`, blank lines are ignored) and then checks that it defines every
required key. Loading a valid, complete config throws `missing required key:
port` even though the file clearly sets `port`. A genuinely incomplete config
must still be rejected. Make a complete config load and an incomplete one still
fail. `node test.js` checks the result.
