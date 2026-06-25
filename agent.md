# Downloads Butler Agent Handoff

## Product Positioning

Downloads Butler is a local desktop file organizer for messy download folders. It scans a user-selected folder, proposes safe move and rename actions, waits for explicit confirmation, logs every operation, and supports undoing the last applied batch.

The product should feel like a lightweight file butler: cautious, useful, and mildly humorous. It must never delete files in the MVP.

## MVP Requirements

1. Let the user select a folder, defaulting to the system Downloads folder when available.
2. Scan first-level files in the selected folder. Do not recursively scan subfolders in v1.
3. Classify files using extension, filename keywords, and timestamps.
4. Supported categories: `Invoices`, `Screenshots`, `PDFs`, `Images`, `Installers`, `Archives`, `Documents`, `Unknown`.
5. Detect duplicate files using `size + sha256 hash`.
6. Generate suggested move and rename paths, but do not move anything automatically.
7. Let the user select files and apply only those selected operations.
8. Record operation history for every applied batch.
9. Support `Undo Last Operation` for the latest applied batch.
10. Show a compact organizing report with a little butler personality.

## Explicit Non-Goals For MVP

- No automatic deletion.
- No background scheduled cleanup.
- No AI-based naming.
- No recursive hard-drive cleanup.
- No rule editor.
- No cloud sync or account system.

## Classification Rules

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

- `high`: clear keyword or extension match.
- `medium`: generic category by extension.
- `low`: Unknown or ambiguous.

## Suggested Naming Behavior

Suggested paths should be deterministic and safe:

- `invoice-final-final.pdf` -> `Invoices/invoice-unknown-YYYY-MM-DD.pdf`
- `Screenshot 2026-06-23 at 10.41.22.png` -> `Screenshots/screenshot-2026-06-23-104122.png`
- `微信图片_20260623102039.jpg` -> `Screenshots/wechat-image-2026-06-23-102039.jpg`

If the target path exists, append `-1`, `-2`, etc.

## Data Model

Recommended SQLite tables:

- `files`
  - `id`
  - `original_path`
  - `suggested_path`
  - `file_hash`
  - `size`
  - `category`
  - `confidence`
  - `status`

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
  - `reversible`
  - `status`
  - `error`

## Technical Stack

- Tauri for the local desktop shell and filesystem operations.
- React + TypeScript for the UI.
- Tailwind CSS for styling.
- SQLite for operation history.
- Vitest for frontend/core logic tests.

## Tauri Command Contract

- `select_folder() -> FolderSelection`
- `scan_folder(path: string) -> ScanResult`
- `apply_operations(items: ApplyItem[]) -> OperationBatch`
- `undo_last_operation() -> UndoResult`
- `get_operation_history() -> OperationBatch[]`

## UI Requirements

The first screen should be the actual tool, not a marketing page.

Primary areas:

- Top bar: app name, selected folder, choose folder button, scan button.
- Summary strip: category counts, duplicate count, unknown count.
- Main list: checkbox, original file, suggested destination, category, confidence, duplicate marker.
- Action bar: `Apply Selected`, `Apply High Confidence`, `Undo Last Operation`.
- Butler report: concise summary plus a cautious, lightly humorous line.

Tone:

- Calm, local, and safety-first.
- Never pressure users into deleting.
- Humor should stay short and optional-feeling.

## Implementation Milestones

1. Project scaffold: Tauri + React + TypeScript + Tailwind + Vitest.
2. Core rules: classification, confidence, suggested path, duplicate grouping.
3. UI: folder selection state, scan result display, selection, filters, report.
4. Tauri backend: scan files, hash files, apply moves, undo latest batch.
5. Persistence: operation logs in SQLite.
6. Verification: unit tests for rules and integration-style tests for temporary file operations where tooling allows.

## Acceptance Criteria

- App can scan a sample folder and show categorized suggestions.
- No file moves before explicit user action.
- User can select files and apply suggested moves.
- Undo restores the latest applied batch where source and destination paths still allow it.
- Duplicate files are grouped by same size and hash.
- Unknown files are not included in high-confidence auto-selection.
- Core rules have automated tests.

## Current Implementation Notes

When resuming work, read this file first, then inspect `package.json`, `src/`, and `src-tauri/`.

Status as of 2026-06-24:

- React preview, Tailwind UI, core rules, sample scan flow, apply flow, and frontend tests are implemented.
- `Undo Last Operation` is now wired through `undoLastOperation()` in `src/tauriClient.ts`; browser preview falls back to a harmless mock result.
- Browser preview shows `Scan sample folder`; Tauri runtime shows `Scan Folder`.
- Chinese keyword tests cover `发票` and `微信图片`.
- Native Tauri verification is still blocked in this environment because `cargo`/Rust is not installed or not on `PATH`.

Additional status as of 2026-06-24:

- Category filter controls are implemented in the sidebar, including `All` and every MVP category.
- Apply actions now open a confirmation preview dialog before any move operation is invoked.
- The confirmation dialog lists selected files and suggested destinations, and reiterates that nothing is deleted.
- Frontend tests cover category filtering and the confirmation-before-apply flow.

Status as of 2026-06-25:

- The suggestions list supports search by original file name or suggested destination.
- `Select Visible` now selects only the currently visible filtered/searched rows, replacing the previous selection.
- `Clear Selection` resets all suggestion checkboxes.
- Frontend tests cover search and visible-row bulk selection behavior.
