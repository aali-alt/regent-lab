# Regent Lab

The repaired school app is now live at https://aali-alt.github.io/regent-lab/ .

## Current production source checkpoint

[`26-26-regent-lab-school-production-20261122.zip`](https://github.com/aali-alt/regent-lab/blob/fix/secure-sync-review/26-26-regent-lab-school-production-20261122.zip) is the complete school production checkpoint dated 2026-11-22. Extract it and start with its own README and OPERATIONS files.

It includes the exact published frontend, school backend source, exact deployed backend ZIP and compiled worker, matching Firebase rules, assets, dependency lock, reproducible build script, tests, verification screenshots and a SHA-256 manifest. It contains no live passwords, private service-account key or school database export.

Archive SHA-256:

```text
f16b8462dd0a3d938a4238ac4e4696b821e513aa47c3fc1f0da5e7f103a808f0
```

Fresh verification of the packaged production source passed 41 unit/security/restore tests, 12 Firestore/Auth integration tests and the Chrome UI round trip, including individual teacher-password management. Separate live school checks covered fresh administrator login at the original URL, teacher login, booking submission, admin approval and the teacher's live approval update.

Frontend cutover commit: https://github.com/aali-alt/regent-lab/commit/6d34da6b9daa48ae69f1ccfd228c6707f42f4417

## Historical review files

The older loose files and earlier numbered archives on this branch are preserved review checkpoints. They are not the current school deployment source. Their earlier pilot-only notes describe that earlier stage. Do not deploy them over the current school app or substitute their synthetic accounts for school accounts.

No claim is made that every device, physical printer or UI edge case has been tested. See the production archive for the tested flows, operational limits and recovery boundaries.
