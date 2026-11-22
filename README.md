# Regent Lab

The repaired school app is now live at https://aali-alt.github.io/regent-lab/ .

## Current production source checkpoint

`7-regent-lab-checkpoint-2026-11-23.zip` is the complete production source checkpoint dated 2026-11-23 (per-bottle stock records, detail cards, booking edit/cancel release). Extract it and start with its own REVIEW-CHECKPOINT-2026-11-23.md, README and OPERATIONS files.

It includes the exact published frontend (index.html, sha256 3afa81995a8b85a5f21b4fda2d9cd88b4257be20aeb0d5a2f24b3d5ff6ecf6ec), school backend source, the exact deployed Workers backend bundle (worker version f4bcb63d-085d-413a-b488-07a879d346c8, wrangler.toml, static assets), matching Firebase rules, assets, dependency lock, reproducible tests and the emulator UI evidence (verification/2026-11-23-bottle-*.png).

Archive SHA-256: 372da0f187c83b77a44f0aa67db5c26ca8fee1e76f541b7eb857ba18b7fbbe20

Verified 2026-11-23: 62/62 backend tests pass; emulator UI evidence passes (over-capacity rejection, two identified mL containers across two cabinets, cabinet filtering, explicit selected-bottle dispense of 100 mL and exact restore, mobile rendering); live site hash matches the packaged frontend; /health ready; /requests/amend and /requests/cancel live.

The older `5-28-28-regent-lab-school-production-20261122.zip` (reliability update 2026-11-22c) is superseded and kept only for history.
