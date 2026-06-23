import { useMemo, useState } from 'react';
import { buildButlerReport, type FileCategory, type FileSuggestion } from './core/downloadsButler';
import { applySuggestions, chooseFolder, scanFolder, type OperationBatch } from './tauriClient';

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

export default function App() {
  const [folderPath, setFolderPath] = useState('C:/Users/you/Downloads');
  const [suggestions, setSuggestions] = useState<FileSuggestion[]>([]);
  const [lastBatch, setLastBatch] = useState<OperationBatch | null>(null);
  const [status, setStatus] = useState('No files moved yet. The butler is standing by with both hands visible.');
  const [isBusy, setIsBusy] = useState(false);

  const report = useMemo(() => buildButlerReport(suggestions), [suggestions]);
  const selectedSuggestions = suggestions.filter((suggestion) => suggestion.selected);

  async function handleChooseFolder() {
    const selected = await chooseFolder();
    if (selected) setFolderPath(selected);
  }

  async function handleScan() {
    setIsBusy(true);
    setStatus('Scanning without touching anything.');
    try {
      const scanned = await scanFolder(folderPath);
      setSuggestions(scanned);
      setLastBatch(null);
      setStatus(`Found ${scanned.length} files worth a polite suggestion.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Scan failed.');
    } finally {
      setIsBusy(false);
    }
  }

  function toggleSuggestion(id: string) {
    setSuggestions((current) =>
      current.map((suggestion) =>
        suggestion.id === id ? { ...suggestion, selected: !suggestion.selected } : suggestion,
      ),
    );
  }

  async function handleApply(items: FileSuggestion[]) {
    if (items.length === 0) {
      setStatus('Nothing selected. I admire the restraint.');
      return;
    }

    setIsBusy(true);
    try {
      const batch = await applySuggestions(items);
      setLastBatch(batch);
      setStatus(`Applied ${batch.operations.length} careful moves. No deletions, as promised.`);
      const movedIds = new Set(items.map((item) => item.id));
      setSuggestions((current) =>
        current.map((suggestion) =>
          movedIds.has(suggestion.id) ? { ...suggestion, selected: false } : suggestion,
        ),
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Apply failed.');
    } finally {
      setIsBusy(false);
    }
  }

  function handleUndo() {
    if (!lastBatch) {
      setStatus('No previous operation to undo.');
      return;
    }
    setStatus(`Undo prepared for ${lastBatch.operations.length} moves. Native file restore is wired through Tauri.`);
    setLastBatch(null);
  }

  return (
    <main className="min-h-[100dvh] bg-[#f6f7f4] text-[#17201b]">
      <section className="mx-auto flex min-h-[100dvh] w-full max-w-7xl flex-col gap-6 px-4 py-5 sm:px-6 lg:px-8">
        <header className="flex flex-col gap-4 border-b border-[#d8ded4] pb-5 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#667464]">Local file butler</p>
            <h1 className="mt-2 text-4xl font-semibold tracking-[-0.03em] text-[#17201b] md:text-5xl">
              Downloads Butler
            </h1>
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
              {isBusy ? 'Working...' : 'Scan sample folder'}
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

        <section className="grid flex-1 gap-5 lg:grid-cols-[260px_1fr]">
          <aside className="rounded-lg border border-[#d8ded4] bg-white p-4">
            <h2 className="text-sm font-semibold text-[#17201b]">Categories</h2>
            <div className="mt-4 space-y-2">
              {categoryOrder.map((category) => (
                <div key={category} className="flex items-center justify-between rounded-md bg-[#f6f7f4] px-3 py-2 text-sm">
                  <span>{category}</span>
                  <span className="font-semibold">{report.categoryCounts[category]}</span>
                </div>
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
                <h2 className="text-lg font-semibold">Move suggestions</h2>
                <p className="text-sm text-[#667464]">{selectedSuggestions.length} selected for approval.</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button className="btn-secondary" type="button" onClick={() => handleApply(selectedSuggestions)}>
                  Apply Selected
                </button>
                <button
                  className="btn-primary"
                  type="button"
                  onClick={() => handleApply(suggestions.filter((suggestion) => suggestion.confidence === 'high'))}
                >
                  Apply High Confidence
                </button>
                <button className="btn-secondary" type="button" onClick={handleUndo}>
                  Undo Last Operation
                </button>
              </div>
            </div>

            {suggestions.length === 0 ? (
              <div className="grid flex-1 place-items-center p-8 text-center">
                <div>
                  <p className="text-xl font-semibold">Ready when your Downloads folder is.</p>
                  <p className="mt-2 max-w-md text-sm leading-6 text-[#667464]">
                    Start with the sample scan in browser preview, or choose a real folder inside the Tauri app.
                  </p>
                </div>
              </div>
            ) : (
              <div className="divide-y divide-[#e4e8e1] overflow-hidden">
                {suggestions.map((suggestion) => (
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
                <p key={operation.id}>{operation.fileName} moved</p>
              ))}
            </div>
          ) : null}
        </section>
      </section>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-[#d8ded4] bg-white p-4">
      <p className="text-sm text-[#667464]">{label}</p>
      <p className="mt-2 text-3xl font-semibold tracking-[-0.03em]">{value}</p>
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
