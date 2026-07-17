# Downloads Butler Agent Handoff

## Product Positioning

Downloads Butler is a local desktop file organizer for messy download folders. It scans a user-selected folder, proposes safe move and rename actions, waits for explicit confirmation, logs every operation, and supports undoing the latest applied batch.

The product should feel like a lightweight file butler: cautious, useful, and mildly humorous. It must never delete files in the MVP.

## MVP Requirements

1. Let the user select a folder, defaulting to the system Downloads folder when available.
2. Scan first-level files in the selected folder. Do not recursively scan subfolders in v1.
3. Classify files using shared extension and filename keyword rules.
4. Supported categories: `Invoices`, `Screenshots`, `PDFs`, `Images`, `Installers`, `Archives`, `Documents`, `Unknown`.
5. Detect duplicate files using `size + sha256 hash`.
6. Generate suggested move and rename paths, but do not move anything automatically.
7. Let the user select files and apply only those selected operations.
8. Record operation history for every applied batch, including success and failure details.
9. Support `Undo Last Operation` for the latest applied batch, with partial failure reporting.
10. Show a compact organizing report with a little butler personality.

## Explicit Non-Goals For MVP

- No automatic deletion.
- No background scheduled cleanup.
- No AI-based naming.
- No recursive hard-drive cleanup.
- No rule editor.
- No cloud sync or account system.

## Classification Rules

Rules live in `src/shared/classificationRules.json` and are consumed by both the TypeScript preview logic and the Rust Tauri backend.

Priority:

1. Duplicate status is an additional flag and does not replace the base category.
2. Invoice and billing keywords take priority over generic PDF classification.
3. Screenshot keywords take priority over generic image classification.
4. Installers and archives are extension-based.
5. Unknown is the fallback.

Keywords:

- Invoices: `invoice`, `receipt`, `bill`, `order`, `payment`, `发票`, `收据`, `账单`
- Screenshots: `screenshot`, `screen shot`, `截屏`, `屏幕截图`, `wx`, `wechat image`, `微信图片`
- Installers: `.dmg`, `.exe`, `.pkg`, `.msi`, `.deb`
- Archives: `.zip`, `.rar`, `.7z`, `.tar.gz`
- Images: `.png`, `.jpg`, `.jpeg`, `.webp`, `.heic`
- Documents: `.docx`, `.xlsx`, `.pptx`, `.txt`, `.md`
- PDFs: `.pdf` files without stronger invoice or billing keywords
- Unknown: all other files

Confidence defaults:

- `high`: clear keyword or installer/archive extension match.
- `medium`: generic PDF, image, or document extension match.
- `low`: Unknown or ambiguous.

## Suggested Naming Behavior

Suggested paths should be deterministic and safe:

- `invoice-final-final.pdf` -> `Invoices/invoice-unknown-YYYY-MM-DD.pdf`
- `Screenshot 2026-06-23 at 10.41.22.png` -> `Screenshots/screenshot-2026-06-23-104122.png`
- `微信图片_20260623102039.jpg` -> `Screenshots/wechat-image-2026-06-23-102039.jpg`

If the target path exists or a selected batch has duplicate target paths, append `-1`, `-2`, etc.

## Current Command Contract

- `scan_folder(folderPath: string) -> ScanResult`
- `apply_operations(items: ApplyItem[]) -> OperationBatch`
- `undo_last_operation() -> UndoResult`
- `get_operation_history() -> OperationBatch[]`

Core types:

- `ScanResult`: `{ suggestions, duplicateGroups, report, warnings }`
- `ApplyItem`: `{ id, path, suggestedRelativePath, expectedHash?, expectedSize? }`
- `OperationBatch`: `{ id, timestamp, status, operations, succeeded, failed }`
- `AppliedOperation`: `{ id, beforePath, afterPath, fileName, status, error? }`
- `UndoResult`: `{ restored, failed }`

## Data Model

SQLite tables:

- `operation_batches`
  - `id`
  - `timestamp`
  - `status`

- `operations`
  - `id`
  - `batch_id`
  - `action_type`
  - `before_path`
  - `after_path`
  - `file_name`
  - `reversible`
  - `status`
  - `error`

Existing local databases are migrated by adding `operations.file_name` when missing.

## UI Requirements

The first screen is the actual tool, not a marketing page.

Primary areas:

- Top bar: app name, selected folder, choose folder button, scan button.
- Summary strip: category counts, duplicate count, unknown count.
- Main list: checkbox, original file, suggested destination, category, confidence, duplicate marker.
- Duplicate filter: shows duplicate groups and lets the user stage duplicate suspects into `Duplicates/` without deleting anything.
- Action bar: `Select Visible`, `Clear Selection`, `Apply Selected`, `Apply High Confidence`, `Undo Last Operation`.
- Confirmation dialog: shows final absolute target paths and reiterates that nothing is deleted.
- History panel: shows recent batches, success/failure counts, operations, and errors.
- Butler report: concise summary plus a cautious, lightly humorous line.

## Implementation Status

Status as of 2026-06-29:

- Shared classification rules are stored in `src/shared/classificationRules.json`.
- Mojibake Chinese keywords were replaced with real Chinese keywords in docs, TypeScript tests, TypeScript logic, and Rust logic.
- `scanFolder()` now returns `ScanResult` in TypeScript, and the Tauri `scan_folder` command mirrors that structure.
- Frontend scan state now stores suggestions, duplicate groups, report, and warnings.
- The UI includes a `Duplicates` filter, duplicate group summary, and `Move duplicate suspects to Duplicates` staging action.
- Apply now sends narrow `ApplyItem` payloads with expected size/hash metadata.
- Apply confirmation shows final absolute target paths and resolves same-batch target conflicts with numeric suffixes.
- `getOperationHistory()` is wired into a Recent operations panel.
- Undo reports partial failures in the UI.
- Rust backend records `file_name`, operation status, and error details for history reconstruction.
- Rust backend performs safety checks before moves: source exists, expected size matches, expected hash matches, and target directory creation succeeds.

## Verification Status

Verified on 2026-06-29:

- `npm.cmd test` passes: 2 test files, 20 tests.
- `npm.cmd run build` passes.

Blocked:

- Native Rust/Tauri verification is still blocked in this environment because `cargo`/Rust is not installed or not on `PATH`.
- Rust unit tests were added for shared-rule Chinese classification and duplicate grouping, but they still need to be run once Rust is available.

## Git Notes

The current branch is `codex/improve-safe-apply-flow`. Previous GitHub sync used the GitHub API because ordinary `git push` could not connect to GitHub over port 443 from this machine, so local `origin/*` tracking may appear stale until network access is restored.
