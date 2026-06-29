import { useEffect, useMemo, useState } from 'react';
import {
  buildAbsoluteTargetPath,
  buildScanResult,
  moveDuplicateToDuplicates,
  resolvePathConflict,
  toApplyItems,
  type ApplyItem,
  type FileCategory,
  type FileSuggestion,
  type OperationBatch,
  type ScanResult,
} from './core/downloadsButler';
import {
  applySuggestions,
  chooseFolder,
  getDefaultDownloadsFolder,
  getOperationHistory,
  getRuntimeMode,
  scanFolder,
  undoLastOperation,
} from './tauriClient';

const categoryOrder: FileCategory[] = [
  'Invoices',
  'Screenshots',
  'PDFs',
  'Images',
  'Installers',
  'Archives',
  'Documents',
  'Unknown',
];

type ActiveFilter = FileCategory | 'All' | 'Duplicates';

type PendingApplyItem = {
  suggestion: FileSuggestion;
  applyItem: ApplyItem;
  targetPath: string;
};

export default function App() {
  const [folderPath, setFolderPath] = useState('Loading Downloads folder...');
  const [scanResult, setScanResult] = useState<ScanResult>(() => buildScanResult([]));
  const [activeFilter, setActiveFilter] = useState<ActiveFilter>('All');
  const [searchQuery, setSearchQuery] = useState('');
  const [history, setHistory] = useState<OperationBatch[]>([]);
  const [lastBatch, setLastBatch] = useState<OperationBatch | null>(null);
  const [pendingApplyItems, setPendingApplyItems] = useState<PendingApplyItem[] | null>(null);
  const [status, setStatus] = useState('No files moved yet. The butler is standing by with both hands visible.');
  const [isBusy, setIsBusy] = useState(false);

  const suggestions = scanResult.suggestions;
  const report = scanResult.report;
  const selectedSuggestions = suggestions.filter((suggestion) => suggestion.selected);
  const normalizedSearch = searchQuery.trim().toLowerCase();
  const visibleSuggestions = suggestions.filter((suggestion) => {
    const matchesCategory =
      activeFilter === 'All'
        ? true
        : activeFilter === 'Duplicates'
          ? Boolean(suggestion.duplicateGroupId)
          : suggestion.category === activeFilter;
    const matchesSearch =
      normalizedSearch.length === 0 ||
      suggestion.name.toLowerCase().includes(normalizedSearch) ||
      suggestion.suggestedRelativePath.toLowerCase().includes(normalizedSearch);

    return matchesCategory && matchesSearch;
  });
  const duplicateSuggestions = suggestions.filter((suggestion) => suggestion.duplicateGroupId);
  const isBrowserPreview = getRuntimeMode() === 'browser';

  useEffect(() => {
    getDefaultDownloadsFolder().then(setFolderPath).catch(() => setFolderPath('Choose a Downloads folder'));
    refreshHistory();
  }, []);

  async function refreshHistory() {
    try {
      setHistory(await getOperationHistory());
    } catch {
      setHistory([]);
    }
  }

  async function handleChooseFolder() {
    const selected = await chooseFolder();
    if (selected) setFolderPath(selected);
  }

  async function handleScan() {
    setIsBusy(true);
    setStatus('Scanning without touching anything.');
    try {
      const result = await scanFolder(folderPath);
      setScanResult(result);
      setActiveFilter('All');
      setSearchQuery('');
      setLastBatch(null);
      setStatus(`Found ${result.suggestions.length} files worth a polite suggestion.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Scan failed.');
    } finally {
      setIsBusy(false);
    }
  }

  function toggleSuggestion(id: string) {
    setScanResult((current) => ({
      ...current,
      suggestions: current.suggestions.map((suggestion) =>
        suggestion.id === id ? { ...suggestion, selected: !suggestion.selected } : suggestion,
      ),
    }));
  }

  function selectVisibleSuggestions() {
    const visibleIds = new Set(visibleSuggestions.map((suggestion) => suggestion.id));
    setScanResult((current) => ({
      ...current,
      suggestions: current.suggestions.map((suggestion) => ({ ...suggestion, selected: visibleIds.has(suggestion.id) })),
    }));
  }

  function clearSelection() {
    setScanResult((current) => ({
      ...current,
      suggestions: current.suggestions.map((suggestion) => ({ ...suggestion, selected: false })),
    }));
  }

  function stageDuplicateSuggestions() {
    const duplicateIds = new Set(duplicateSuggestions.map((suggestion) => suggestion.id));
    setActiveFilter('Duplicates');
    setScanResult((current) => ({
      ...current,
      suggestions: current.suggestions.map((suggestion) =>
        duplicateIds.has(suggestion.id) ? moveDuplicateToDuplicates(suggestion) : { ...suggestion, selected: false },
      ),
    }));
  }

  function requestApply(items: FileSuggestion[]) {
    if (items.length === 0) {
      setStatus('Nothing selected. I admire the restraint.');
      return;
    }

    const seenTargets = new Set<string>();
    const applyItems = toApplyItems(items).map((item) => {
      const suggestedRelativePath = resolvePathConflict(item.suggestedRelativePath, seenTargets);
      seenTargets.add(suggestedRelativePath);
      return { ...item, suggestedRelativePath };
    });
    setPendingApplyItems(
      items.map((suggestion, index) => ({
        suggestion,
        applyItem: applyItems[index],
        targetPath: buildAbsoluteTargetPath(applyItems[index]),
      })),
    );
  }

  async function handleApply(items: PendingApplyItem[]) {
    setIsBusy(true);
    try {
      const batch = await applySuggestions(items.map((item) => item.applyItem));
      setLastBatch(batch);
      setPendingApplyItems(null);
      setStatus(`Applied ${batch.succeeded} careful moves. ${batch.failed} failed. No deletions, as promised.`);
      const movedIds = new Set(items.map((item) => item.suggestion.id));
      setScanResult((current) => ({
        ...current,
        suggestions: current.suggestions.map((suggestion) =>
          movedIds.has(suggestion.id) ? { ...suggestion, selected: false } : suggestion,
        ),
      }));
      await refreshHistory();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Apply failed.');
    } finally {
      setIsBusy(false);
    }
  }

  async function handleUndo() {
    setIsBusy(true);
    try {
      const result = await undoLastOperation();
      const failures = result.failed.map((failure) => `${failure.fileName}: ${failure.reason}`).join(' ');
      setStatus(
        failures
          ? `Undo restored ${result.restored} files. ${result.failed.length} could not be restored. ${failures}`
          : `Undo restored ${result.restored} files from the last operation.`,
      );
      setLastBatch(null);
      await refreshHistory();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Undo failed.');
    } finally {
      setIsBusy(false);
    }
  }

  const visibleTitle = activeFilter === 'Duplicates' ? 'Duplicate groups' : 'Move suggestions';

  return (
    <main className="min-h-[100dvh] bg-[#f6f7f4] text-[#17201b]">
      <section className="mx-auto flex min-h-[100dvh] w-full max-w-7xl flex-col gap-6 px-4 py-5 sm:px-6 lg:px-8">
        <header className="flex flex-col gap-4 border-b border-[#d8ded4] pb-5 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#667464]">Local file butler</p>
            <h1 className="mt-2 text-4xl font-semibold text-[#17201b] md:text-5xl">Downloads Butler</h1>
            <p className="mt-3 max-w-2xl text-base leading-7 text-[#596359]">
              Scan first, suggest second, move only after you approve. A tiny desktop steward for the folder where
              everything somehow lands.
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <button className="btn-secondary" type="button" onClick={handleChooseFolder}>
              Choose folder
            </button>
            <button className="btn-primary" type="button" onClick={handleScan} disabled={isBusy}>
              {isBusy ? 'Working...' : isBrowserPreview ? 'Scan sample folder' : 'Scan Folder'}
            </button>
          </div>
        </header>

        <section className="rounded-lg border border-[#d8ded4] bg-white/80 p-4 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[#667464]">Selected folder</p>
          <p className="mt-1 break-all font-mono text-sm text-[#263128]">{folderPath}</p>
        </section>

        <section className="grid gap-3 md:grid-cols-4">
          <Metric label="Suggested files" value={report.total} />
          <Metric label="High confidence" value={report.highConfidence} />
          <Metric label="Duplicate suspects" value={report.duplicates} />
          <Metric label="Unknown" value={report.unknown} />
        </section>

        {scanResult.warnings.length > 0 ? (
          <section className="rounded-lg border border-[#dfc8aa] bg-[#fff8ed] px-4 py-3 text-sm text-[#755018]">
            {scanResult.warnings.map((warning) => (
              <p key={warning}>{warning}</p>
            ))}
          </section>
        ) : null}

        <section className="grid flex-1 gap-5 lg:grid-cols-[260px_1fr]">
          <aside className="rounded-lg border border-[#d8ded4] bg-white p-4">
            <h2 className="text-sm font-semibold text-[#17201b]">Categories</h2>
            <div className="mt-4 space-y-2">
              <FilterButton active={activeFilter === 'All'} count={suggestions.length} label="All" onClick={() => setActiveFilter('All')} />
              <FilterButton
                active={activeFilter === 'Duplicates'}
                count={duplicateSuggestions.length}
                label="Duplicates"
                onClick={() => setActiveFilter('Duplicates')}
              />
              {categoryOrder.map((category) => (
                <FilterButton
                  active={activeFilter === category}
                  count={report.categoryCounts[category]}
                  key={category}
                  label={category}
                  onClick={() => setActiveFilter(category)}
                />
              ))}
            </div>

            <div className="mt-5 rounded-lg bg-[#17201b] p-4 text-white">
              <p className="text-sm font-semibold">Butler report</p>
              <p className="mt-2 text-sm leading-6 text-[#dce7db]">{report.message}</p>
            </div>
          </aside>

          <section className="flex min-h-[420px] flex-col rounded-lg border border-[#d8ded4] bg-white">
            <div className="flex flex-col gap-3 border-b border-[#d8ded4] p-4 md:flex-row md:items-center md:justify-between">
              <div>
                <h2 className="text-lg font-semibold">{visibleTitle}</h2>
                <p className="text-sm text-[#667464]">
                  {selectedSuggestions.length} selected for approval. {visibleSuggestions.length} visible.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button className="btn-secondary" type="button" onClick={selectVisibleSuggestions}>
                  Select Visible
                </button>
                <button className="btn-secondary" type="button" onClick={clearSelection}>
                  Clear Selection
                </button>
                <button className="btn-secondary" type="button" onClick={stageDuplicateSuggestions}>
                  Move duplicate suspects to Duplicates
                </button>
                <button className="btn-secondary" type="button" onClick={() => requestApply(selectedSuggestions)}>
                  Apply Selected
                </button>
                <button
                  className="btn-primary"
                  type="button"
                  onClick={() => requestApply(suggestions.filter((suggestion) => suggestion.confidence === 'high'))}
                >
                  Apply High Confidence
                </button>
                <button className="btn-secondary" type="button" onClick={handleUndo}>
                  Undo Last Operation
                </button>
              </div>
            </div>

            {suggestions.length > 0 ? (
              <div className="border-b border-[#d8ded4] p-4">
                <label className="block text-xs font-semibold uppercase tracking-[0.14em] text-[#667464]" htmlFor="suggestion-search">
                  Search suggestions
                </label>
                <input
                  aria-label="Search suggestions"
                  className="mt-2 w-full rounded-md border border-[#c8d1c5] bg-white px-3 py-2 text-sm text-[#17201b] outline-none transition focus:border-[#2f6f4e] focus:ring-2 focus:ring-[#2f6f4e]/20"
                  id="suggestion-search"
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder="Search by file name or destination"
                  type="search"
                  value={searchQuery}
                />
              </div>
            ) : null}

            {activeFilter === 'Duplicates' && scanResult.duplicateGroups.length > 0 ? (
              <div className="border-b border-[#d8ded4] bg-[#f9faf7] p-4 text-sm text-[#435044]">
                {scanResult.duplicateGroups.map((group) => (
                  <p key={group.id}>
                    {group.id}: {group.files.length} files, {formatBytes(group.size)} each. Suggested keep:{' '}
                    {group.recommendedKeepId ?? 'first file'}.
                  </p>
                ))}
              </div>
            ) : null}

            {suggestions.length === 0 ? (
              <div className="grid flex-1 place-items-center p-8 text-center">
                <div>
                  <p className="text-xl font-semibold">Ready when your Downloads folder is.</p>
                  <p className="mt-2 max-w-md text-sm leading-6 text-[#667464]">
                    Start with the sample scan in browser preview, or choose a real folder inside the Tauri app.
                  </p>
                </div>
              </div>
            ) : visibleSuggestions.length === 0 ? (
              <div className="grid flex-1 place-items-center p-8 text-center">
                <div>
                  <p className="text-xl font-semibold">Nothing in this filter.</p>
                  <p className="mt-2 max-w-md text-sm leading-6 text-[#667464]">
                    The butler checked twice. Try All or another category.
                  </p>
                </div>
              </div>
            ) : (
              <div className="divide-y divide-[#e4e8e1] overflow-hidden">
                {visibleSuggestions.map((suggestion) => (
                  <label
                    key={suggestion.id}
                    className="grid cursor-pointer gap-3 px-4 py-4 transition hover:bg-[#f9faf7] md:grid-cols-[28px_1.1fr_1fr_130px_110px]"
                  >
                    <input
                      aria-label={`Select ${suggestion.name}`}
                      className="mt-1 h-4 w-4 accent-[#2f6f4e]"
                      type="checkbox"
                      checked={suggestion.selected}
                      onChange={() => toggleSuggestion(suggestion.id)}
                    />
                    <div>
                      <p className="font-medium text-[#17201b]">{suggestion.name}</p>
                      <p className="mt-1 text-xs text-[#667464]">{formatBytes(suggestion.size)}</p>
                    </div>
                    <div>
                      <p className="font-mono text-xs text-[#263128]">{suggestion.suggestedRelativePath}</p>
                      {suggestion.duplicateGroupId ? (
                        <p className="mt-1 text-xs font-semibold text-[#9a4d18]">Duplicate suspect</p>
                      ) : null}
                    </div>
                    <Badge label={suggestion.category} />
                    <Badge label={suggestion.confidence} tone={suggestion.confidence} />
                  </label>
                ))}
              </div>
            )}
          </section>
        </section>

        <section className="rounded-lg border border-[#d8ded4] bg-white px-4 py-3 text-sm text-[#435044]" role="status">
          {status}
          {lastBatch ? (
            <div className="mt-2 space-y-1">
              {lastBatch.operations.map((operation) => (
                <p key={operation.id}>
                  {operation.fileName} {operation.status}
                  {operation.error ? `: ${operation.error}` : ''}
                </p>
              ))}
            </div>
          ) : null}
        </section>

        <HistoryPanel batches={history} />

        {pendingApplyItems ? (
          <div className="fixed inset-0 z-50 grid place-items-center bg-[#17201b]/35 px-4">
            <section
              aria-labelledby="confirm-apply-title"
              aria-modal="true"
              className="w-full max-w-2xl rounded-lg border border-[#d8ded4] bg-white p-5 shadow-2xl"
              role="dialog"
            >
              <div className="flex flex-col gap-3 border-b border-[#d8ded4] pb-4 md:flex-row md:items-start md:justify-between">
                <div>
                  <h2 id="confirm-apply-title" className="text-xl font-semibold text-[#17201b]">
                    Confirm careful moves
                  </h2>
                  <p className="mt-2 text-sm text-[#667464]">
                    Preflight checks complete. {pendingApplyItems.length} files selected. Nothing will be deleted.
                  </p>
                </div>
                <button className="btn-secondary" type="button" onClick={() => setPendingApplyItems(null)}>
                  Cancel
                </button>
              </div>

              <div className="mt-4 max-h-72 space-y-3 overflow-auto">
                {pendingApplyItems.map((item) => (
                  <div key={item.suggestion.id} className="rounded-md bg-[#f6f7f4] p-3">
                    <p className="text-sm font-semibold text-[#17201b]">{item.suggestion.name}</p>
                    <p className="mt-1 break-all font-mono text-xs text-[#596359]">{item.targetPath}</p>
                  </div>
                ))}
              </div>

              <div className="mt-5 flex flex-wrap justify-end gap-2">
                <button className="btn-secondary" type="button" onClick={() => setPendingApplyItems(null)}>
                  Keep Reviewing
                </button>
                <button className="btn-primary" type="button" onClick={() => handleApply(pendingApplyItems)} disabled={isBusy}>
                  Confirm Apply
                </button>
              </div>
            </section>
          </div>
        ) : null}
      </section>
    </main>
  );
}

function FilterButton({ active, count, label, onClick }: { active: boolean; count: number; label: string; onClick: () => void }) {
  return (
    <button aria-label={label} className={`category-button ${active ? 'category-button-active' : ''}`} type="button" onClick={onClick}>
      <span>{label}</span>
      <span className="font-semibold">{count}</span>
    </button>
  );
}

function HistoryPanel({ batches }: { batches: OperationBatch[] }) {
  const recentBatches = useMemo(() => batches.slice(0, 20), [batches]);

  return (
    <section className="rounded-lg border border-[#d8ded4] bg-white p-4">
      <h2 className="text-lg font-semibold text-[#17201b]">Recent operations</h2>
      {recentBatches.length === 0 ? (
        <p className="mt-2 text-sm text-[#667464]">No recorded moves yet.</p>
      ) : (
        <div className="mt-3 space-y-3">
          {recentBatches.map((batch) => (
            <article key={batch.id} className="rounded-md bg-[#f6f7f4] p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-mono text-xs font-semibold text-[#263128]">{batch.id}</p>
                <p className="text-xs text-[#667464]">
                  {batch.succeeded} succeeded, {batch.failed} failed
                </p>
              </div>
              <div className="mt-2 space-y-1 text-xs text-[#435044]">
                {batch.operations.map((operation) => (
                  <p key={operation.id}>
                    {operation.fileName}: {operation.status}
                    {operation.error ? ` - ${operation.error}` : ''}
                  </p>
                ))}
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-[#d8ded4] bg-white p-4">
      <p className="text-sm text-[#667464]">{label}</p>
      <p className="mt-2 text-3xl font-semibold">{value}</p>
    </div>
  );
}

function Badge({ label, tone }: { label: string; tone?: 'high' | 'medium' | 'low' }) {
  const className =
    tone === 'high'
      ? 'bg-[#dcefe2] text-[#24543b]'
      : tone === 'medium'
        ? 'bg-[#edf0e7] text-[#596359]'
        : tone === 'low'
          ? 'bg-[#f3e5da] text-[#7a441c]'
          : 'bg-[#edf0e7] text-[#435044]';

  return <span className={`h-fit rounded-full px-3 py-1 text-xs font-semibold capitalize ${className}`}>{label}</span>;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
