# Fix the pluralizer

`pluralize.js` returns the plural of a lowercase English noun by the regular
spelling rules: a word ending in `s`, `x`, `z`, `ch` or `sh` takes `es`
(`bus -> buses`, `box -> boxes`); a word ending in a consonant plus `y` drops
the `y` for `ies` (`baby -> babies`); a word ending in a vowel plus `y` just
takes `s` (`boy -> boys`); anything else takes `s` (`cat -> cats`). It only
handles the last of these. Make it follow every rule. `node test.js` checks the
result.
