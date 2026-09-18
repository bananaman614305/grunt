# Fix the circuit breaker's recovery

The breaker in `breaker.js` trips as it should, but it never recovers
properly: once it has let a trial call through it stops behaving like a
breaker at all. Make it obey these rules exactly:

1. While closed, a call goes straight through — the value is returned and an
   error is propagated to the caller.
2. `failureThreshold` failures in a row while closed open the circuit; any
   success resets that count.
3. While open, a call is refused with `Error("circuit open")` and the guarded
   function is not invoked, until at least `cooldownMs` has passed on the
   caller's clock since the circuit opened.
4. Once that much time has passed, the next call is a trial: the guarded
   function is invoked and the breaker reports `half_open` while it runs.
5. A trial that succeeds closes the circuit and clears the failure count; a
   trial that fails reopens the circuit at once, whatever the count is, and
   the cooldown starts again from then.
6. `state` reads `"closed"`, `"open"`, or `"half_open"`.

`node test.js` checks the result.
