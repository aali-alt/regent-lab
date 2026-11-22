# Regent Lab

The repaired school app is now live at https://aali-alt.github.io/regent-lab/ .

## Current production source checkpoint

`2-regent-lab-checkpoint-2026-11-23.zip` is the complete production source checkpoint dated 2026-11-23 (per-bottle stock records with persistent unit-aware editor labels, detail cards, booking edit/cancel release). Extract it and start with its own REVIEW-CHECKPOINT-2026-11-23.md, README and OPERATIONS files.

It includes the exact published frontend (index.html, 319311 bytes, sha256 9bd46877db36c303e397ba0c27e61a0d44a3375a7d5278fb80d34a5822dc3f12), school backend source, the exact deployed Workers backend bundle (worker version f4bcb63d-085d-413a-b488-07a879d346c8, wrangler.toml, static assets), matching Firebase rules, assets, dependency lock, reproducible tests and the emulator UI evidence (verification/2026-11-23-bottle-*.png).

Archive SHA-256: 92d76d0e157049f08b5622f39d06a5de7f11c5ec24be71cb85bea0375411044f

Verified 2026-11-23: 62/62 backend tests pass; emulator UI evidence passes (over-capacity rejection, two identified mL containers across two cabinets, cabinet filtering, explicit selected-bottle dispense of 100 mL and exact restore, mobile rendering, successful cloud snapshot); live site hash matches the packaged frontend; /health ready; /requests/amend and /requests/cancel live.

The older `5-28-28-regent-lab-school-production-20261122.zip` (reliability update 2026-11-22c) is superseded and kept only for history.
