# Fix the search highlighter

A search result carries the span of the document it matched, and `snippet.js`
puts brackets around it. The brackets keep landing in the wrong place: in
documents containing accented letters or runs of spaces they slide a character
at a time, so a highlight ends up shifted, or cutting a word in half. Make the
highlighted span cover exactly the word that matched in the original document,
however far into the text it is, while searching goes on ignoring case and
accents as it does today. `node test.js` checks the result.
