# Fix the slug generator

`slugify.js` turns article titles into URL slugs, but multi-word titles come
out wrong: words run together or keep stray hyphens. A slug should be the
lowercased words joined by single hyphens, with punctuation dropped and no
hyphen at either end. Fix `slugify`; `node test.js` checks the result.
