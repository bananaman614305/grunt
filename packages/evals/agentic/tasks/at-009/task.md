# Deduplicate the number formatters

The three formatters in `fmt.js` each carry their own copy of the same
thousands-grouping loop, and the copies have drifted: they no longer treat
negative numbers alike, though the comment at the top says every formatter
keeps the sign. Extract the shared grouping into one helper, use it from all
three, and make the stated rule hold. `node test.js` checks the result.
