# Give repeated headings their own anchors

`build.js` renders a markdown document as a table of contents plus the
sections themselves, and a document may legitimately repeat a heading (two
"Notes" sections, say). Today those sections share one anchor, so their table
of contents entries and any `[[Notes]]` cross-references all land on the same
place. Make every section's anchor unique within the document: the first
section with a title keeps the plain anchor and later ones get `-2`, `-3` and
so on in document order, each table-of-contents entry points at its own
section, and a `[[Title]]` reference points at the first section with that
title. Two documents built one after another must come out exactly as they do
when each is built alone. `node test.js` checks the result.
