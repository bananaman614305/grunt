# Add a maxLength rule to the validator

The field validator (`validator.js`, messages in `errors.js`) supports
`required` and `minLength`. Add a `maxLength` rule: when the value's length
exceeds the limit, report an error with code `max_length` and the message
`<field> must be at most <limit> characters`; a value exactly at the limit
passes. Follow the pattern the existing rules use, keeping the wording in
the message table. `node test.js` checks the result.
