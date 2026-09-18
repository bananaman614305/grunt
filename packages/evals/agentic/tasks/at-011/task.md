# Fix the money report's symbol styles

`report.js` renders rows of amounts; every row names its currency and the
symbol style it wants (`narrow` gives `$`, `wide` gives `US$`). Rows come out
wearing another row's style instead: the same row renders differently
depending on which rows were rendered before it. Make each row render in the
style it asks for, whatever the order, without giving up the caching that
keeps the currency catalog cheap — over a whole process the catalog should
still be read at most once per currency-and-style pair. `node test.js` checks
the result.
