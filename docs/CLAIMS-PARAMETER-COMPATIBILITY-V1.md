# Parameter Claims Compatibility V1

Status: frozen G0 implementation baseline  
Baseline schema: `16`

This contract protects the existing Parameter Claims slice while generalized
Subjects are introduced. Schema migrations may add relationships and metadata,
but they must not recompute or rewrite these V1 identities and fingerprints.

## Canonical Contracts

```text
ParameterIdentityV1
  id = "parameter:" + sha256(canonicalJson(parameterKey))

EvidenceIdentityV1
  id = "evidence:" + sha256(canonicalJson(evidenceIdentityKey))

ParameterClaimIdentityV1
  identityKey = parameterKey + ":" + claimType + ":" + (scope ?? "")
  id = "claim:" + sha256(canonicalJson(identityKey))

ParameterMaterialityV1
  sha256(canonicalJson({
    parameterIdentity,
    semanticLocation,
    normalizedValue
  }))
```

Paths, spans, commits, and symbols are not inputs to
`ParameterMaterialityV1`. Evidence observations may still version when those
locations change.

## Golden Vector

The canonical fixture is `session.timeout = 1800`, observed as
`SESSION_TIMEOUT` in `src/auth/session.ts` and assessed as an unscoped
`CLM-DEFAULT`.

| Value                | Golden V1 output                                                                 |
| -------------------- | -------------------------------------------------------------------------------- |
| Parameter identity   | `parameter:5a860a5ed7612f6812ad097808f8b989a555553cf999845c2a5166262e65978a`     |
| Evidence identity    | `evidence:6d09f20fba39e578be032b6d174c30a0efc4271712852ac39c8648001eb9f500`      |
| Evidence version     | `evidence:6d09f20fba39e578be032b6d174c30a0efc4271712852ac39c8648001eb9f500@1`    |
| Material fingerprint | `99102ebfcf67f4949e9c3c7c86f02921834c92ad08cd2b40c2dcf95030b1ce48`               |
| RuleResult identity  | `rule-result:91debdb64ea9360e53fca562b9db60c8dd56bb1ec3fd77d24f597e323c13c7c0`   |
| RuleResult version   | `rule-result:91debdb64ea9360e53fca562b9db60c8dd56bb1ec3fd77d24f597e323c13c7c0@1` |
| Claim identity       | `claim:7936f1a0e3f4283252273bd8eca32056f204bd25f8c23a5d9bc87ba08a79d99f`         |
| Claim version        | `claim:7936f1a0e3f4283252273bd8eca32056f204bd25f8c23a5d9bc87ba08a79d99f@1`       |
| Assessment           | `assessment:72b1a34c68b76ed91f73bddbaf0b0bf890562e44a03a16a496b9fb272ccbaee8`    |

The executable contract is
`packages/index/src/__tests__/claimsCompatibilityV1.test.ts`.

## Public Exit Codes

| Outcome         | Code |
| --------------- | ---: |
| success         |  `0` |
| failed          |  `1` |
| inconclusive    |  `2` |
| not applicable  |  `3` |
| review required |  `4` |
| invalid input   | `64` |

Priority is `64 -> 1 -> 2 -> 4 -> 3 -> 0`. The executable contract is
`packages/index/src/__tests__/claimsExitCode.test.ts`.

## Compatibility Suite

The existing C0-C8 and P-001/P1 scenarios are covered by
`packages/cli/src/commands/claims.test.ts`. C9 and C10 are covered in both
regular-first and `--since`-first order by
`packages/cli/src/commands/claimsContractDrift.test.ts`. Store, migration,
WAL-safety, and native/TypeScript rebuild parity remain part of the same gate.

Still required before G0 is complete:

- first-run noise, runtime, and database-size measurements on at least three
  external repositories,
- manual classification of their findings,
- publication feedback from the planned design-partner round.
