# Regent Lab

The repaired school app is now live at https://aali-alt.github.io/regent-lab/ .

## Current production source checkpoint

[`1-27-27-regent-lab-school-production-20261122.zip`](https://github.com/aali-alt/regent-lab/blob/fix/secure-sync-review/1-27-27-regent-lab-school-production-20261122.zip) is the complete school production checkpoint dated 2026-11-22, reliability update 2026-11-22b. Extract it and start with its own README and OPERATIONS files.

It includes the exact published frontend, school backend source, exact deployed backend ZIP and compiled worker, matching Firebase rules, assets, dependency lock, reproducible build script, tests, verification screenshots and a SHA-256 manifest. It contains no live passwords, private service-account key or school database export.

Archive SHA-256:

```text
7ccfea6d7e5e5398e3a6db22b190603678b3142250e03c86ea438756b1ed0050
```

Reliability update 2026-11-22b adds: complete item details in mobile inventory; reversal of approved requests with batch-provenance stock restoration and audit entries; multiple expiry batches per item; on-demand backend recovery snapshots with honest labeling and a fixed snapshot list; accurate sync status, readable Cairo audit times and Arabic empty-state guidance for teachers. Session-triggered snapshot downloads remain a manual fallback, labeled as such in the app; same-database snapshots are recovery checkpoints, not an independent disaster backup.

Fresh verification of the packaged production source passed 53 unit/security/crypto/restore tests, 13 Firestore/Auth integration tests, the bounded load check, the backend-outage browser check and the actual Chrome UI suite, including the snapshot-list regression test, teacher-password management and requisition reversal with batch-provenance restoration. Load and outage results are emulator/local measurements, not production capacity claims. Separate live school checks covered fresh administrator login at the original URL, mobile inventory rendering, sync status, the session-triggered backup label and the backend snapshot list.

Frontend cutover commit: https://github.com/aali-alt/regent-lab/commit/793fd5c8f7c5855e9e92e95824ce63215b7d3a84

## Historical review files

The older loose files and earlier numbered archives on this branch are preserved review checkpoints. They are not the current school deployment source. Their earlier pilot-only notes describe that earlier stage. Do not deploy them over the current school app or substitute their synthetic accounts for school accounts.

No claim is made that every device, physical printer or UI edge case has been tested. See the production archive for the tested flows, operational limits and recovery boundaries.
