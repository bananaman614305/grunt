# Fix config merge

`merge.js` merges a config patch into a base config, but a nested object in
the patch wipes out every sibling key of the base's nested object instead of
merging into it. Nested plain objects must merge key by key, while arrays and
scalars in the patch replace the base value; neither input may be modified.
Fix `merge`; `node test.js` checks the result.
