# Fix the title caser

`title.js` turns a lowercase phrase into a title. Each word is capitalized,
except the small words `a`, `an`, `and`, `the`, `of`, `to`, `in`, which stay
lowercase -- but the first word and the last word of the title are always
capitalized, even when they are one of those small words. For example, `"the
lord of the rings"` becomes `"The Lord of the Rings"` and `"to the moon"`
becomes `"To the Moon"`. Right now every word is capitalized. Make it follow
the rules. `node test.js` checks the result.
