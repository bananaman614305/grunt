# Unify the toggle parsing

`loadConfig` in `config.js` spells out its truthy-string rule once per
toggle, and the copies have drifted apart: the two toggles no longer accept
the same spellings, though the comment at the top states one rule for both.
Extract the rule into a single helper and use it for every toggle so the
stated rule holds everywhere. `node test.js` checks the result.
