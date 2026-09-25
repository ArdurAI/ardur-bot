# Governance and encryption

Governance and encryption are not part of this build yet.

The space feature contract reserves `governance` with the states `unavailable`,
`disabled` and `enabled`. Any space member can read `features.list`. Only a space
owner can call `features.set`. The server rejects changes to an unavailable
feature, even if a stored row says enabled. Availability comes from the build.
There is no enable control or governance summary endpoint in this build.

`GovernanceSummary` in `packages/contracts/src/features.ts` is a future read
contract shared by web, desktop and mobile. It has no producer or sample data.
A future implementation must supply per-session governance decisions: allowed,
denied, asked and recorded. These describe decisions, not proof of safety.

Evidence bundles will need encryption of recorded evidence, versioned keys,
key rotation and revocation lists. Capture levels must distinguish no capture,
decisions only and evidence capture. A public verifier must validate the bundle's
declared evidence and revocation state without publishing decrypted private
evidence. A verifier URL is a reference, not a successful verification result.

Spend gates must preserve currency, reported amounts and optional limits.
Typed risk gates must preserve the risk type and the resulting decision. Missing
spend and evidence remain null. An enabled feature must bind to the implementation
supplied by the governance project rather than infer decisions from run status.
Enabling a future panel alone must never claim encryption or enforcement.

The reserved Dashboard panel links here. The eventual implementation must define
authorization, retention, key recovery and offline verification before exposing
governance actions. No release date is promised.
