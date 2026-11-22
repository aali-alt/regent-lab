# Regent Lab

The repaired school app is now live at https://aali-alt.github.io/regent-lab/ .

## Current production source checkpoint

[`5-28-28-regent-lab-school-production-20261122.zip`](https://github.com/aali-alt/regent-lab/blob/fix/secure-sync-review/5-28-28-regent-lab-school-production-20261122.zip) is the complete school production checkpoint dated 2026-11-22, reliability update 2026-11-22c. Extract it and start with its own README and OPERATIONS files.

It includes the exact published frontend, school backend source, the exact deployed Workers backend (bundle, wrangler.toml, static assets), matching Firebase rules, assets, dependency lock, reproducible build script, tests, verification logs and screenshots, and a SHA-256 manifest. It contains no live passwords, private service-account key or school database export.

Archive SHA-256:

```text
8f55074f86472719dceb1ec27947061a8a58c3d773661152e9216bea29469346
```

Reliability update 2026-11-22c moves the backend to Cloudflare Workers with a nightly Cron Trigger: an unattended recovery snapshot every night at 22:00 UTC (about midnight Cairo), labeled system-scheduler and verified with real scheduled fires. The backup card shows the latest automatic checkpoint, labels each snapshot scheduled or session, and warns when the nightly checkpoint is overdue. Snapshots remain same-database recovery checkpoints, not an offsite disaster backup; R2 was not enabled because it requires a billing checkout. The packaged index.html is byte-identical to the live site (sha256 begins 11e76837d100fc34).

Fresh verification of the packaged production source passed 55 unit/security/crypto/restore tests, 13 Firestore/Auth integration tests, the bounded load check, the backend-outage browser check and the actual Chrome UI suite, including the snapshot list, teacher-password management and requisition reversal with batch-provenance restoration. Load and outage results are emulator/local measurements, not production capacity claims. Separate live school checks covered fresh administrator login at the original URL, mobile inventory rendering, sync status, the session-triggered backup label, the backend snapshot list and two unattended scheduled snapshot fires.

Frontend cutover commit: https://github.com/aali-alt/regent-lab/commit/966b94ecb3382e83889197f91765f5b074255e9f

## Historical review files

The older loose files and earlier numbered archives on this branch are preserved review checkpoints. They are not the current school deployment source. Their earlier pilot-only notes describe that earlier stage. Do not deploy them over the current school app or substitute their synthetic accounts for school accounts.

No claim is made that every device, physical printer or UI edge case has been tested. See the production archive for the tested flows, operational limits and recovery boundaries.
