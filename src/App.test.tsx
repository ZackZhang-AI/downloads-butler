import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { buildScanResult, makeSuggestion, type ApplyItem, type FileSuggestion, type ScannedFile } from './core/downloadsButler';
import { sampleFiles } from './tauriClient';

const mocks = vi.hoisted(() => ({
  undoLastOperation: vi.fn(),
  getOperationHistory: vi.fn(),
}));

const scannedFiles = (folderPath: string): ScannedFile[] => [
  ...sampleFiles(folderPath),
  {
    id: 'sample-invoice-copy',
    name: 'invoice-final-final copy.pdf',
    path: `${folderPath}/invoice-final-final copy.pdf`,
    size: 421_000,
    hash: 'hash-invoice',
    modifiedAt: '2026-06-23T10:20:00.000Z',
  },
];

vi.mock('./tauriClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./tauriClient')>();
  return {
    ...actual,
    chooseFolder: vi.fn(async () => 'C:/Users/you/Downloads'),
    scanFolder: vi.fn(async (folderPath: string) => buildScanResult(scannedFiles(folderPath), ['Subfolders are skipped in this version.'])),
    applySuggestions: vi.fn(async (items: ApplyItem[]) => ({
      id: 'batch-test',
      timestamp: '2026-06-24T10:00:00.000Z',
      status: 'applied',
      succeeded: items.length,
      failed: 0,
      operations: items.map((item) => ({
        id: `op-${item.id}`,
        beforePath: item.path,
        afterPath: `C:/Users/you/Downloads/${item.suggestedRelativePath}`,
        fileName: item.path.split('/').at(-1) ?? item.id,
        status: 'applied',
      })),
    })),
    getOperationHistory: mocks.getOperationHistory,
    undoLastOperation: mocks.undoLastOperation,
  };
});

describe('Downloads Butler app', () => {
  beforeEach(() => {
    mocks.undoLastOperation.mockClear();
    mocks.undoLastOperation.mockResolvedValue({ restored: 1, failed: [{ fileName: 'setup.exe', reason: 'destination missing' }] });
    mocks.getOperationHistory.mockClear();
    mocks.getOperationHistory.mockResolvedValue([
      {
        id: 'batch-history',
        timestamp: '2026-06-24T10:00:00.000Z',
        status: 'applied',
        succeeded: 1,
        failed: 1,
        operations: [
          {
            id: 'op-ok',
            beforePath: 'C:/Users/you/Downloads/setup.exe',
            afterPath: 'C:/Users/you/Downloads/Installers/setup-2026-06-22.exe',
            fileName: 'setup.exe',
            status: 'applied',
          },
          {
            id: 'op-failed',
            beforePath: 'C:/Users/you/Downloads/missing.bin',
            afterPath: 'C:/Users/you/Downloads/Unknown/missing.bin',
            fileName: 'missing.bin',
            status: 'failed',
            error: 'source file does not exist',
          },
        ],
      },
    ]);
  });

  it('shows scan suggestions, warnings, and keeps Unknown files out of high-confidence apply', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: /scan sample folder/i }));
    expect(screen.getByText('invoice-final-final.pdf')).toBeInTheDocument();
    expect(screen.getByText('mystery-download.bin')).toBeInTheDocument();
    expect(screen.getByText(/Subfolders are skipped/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /apply high confidence/i }));
    await user.click(screen.getByRole('button', { name: /confirm apply/i }));

    expect(screen.getByText(/Applied 4 careful moves/i)).toBeInTheDocument();
    expect(screen.queryByText(/mystery-download.bin moved/i)).not.toBeInTheDocument();
  });

  it('filters suggestions by Unknown category', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: /scan sample folder/i }));
    await user.click(screen.getByRole('button', { name: /^unknown$/i }));

    expect(screen.getByText('mystery-download.bin')).toBeInTheDocument();
    expect(screen.queryByText('invoice-final-final.pdf')).not.toBeInTheDocument();
  });

  it('searches suggestions by file name', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: /scan sample folder/i }));
    await user.type(screen.getByRole('searchbox', { name: /search suggestions/i }), 'setup');

    expect(screen.getByText('setup.exe')).toBeInTheDocument();
    expect(screen.queryByText('invoice-final-final.pdf')).not.toBeInTheDocument();
  });

  it('selects visible suggestions and clears the selection', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: /scan sample folder/i }));
    await user.click(screen.getByRole('button', { name: /^unknown$/i }));
    await user.click(screen.getByRole('button', { name: /select visible/i }));

    expect(screen.getByText(/1 selected for approval/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /clear selection/i }));

    expect(screen.getByText(/0 selected for approval/i)).toBeInTheDocument();
  });

  it('previews final absolute move targets before applying them', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: /scan sample folder/i }));
    await user.click(screen.getByRole('button', { name: /apply selected/i }));

    const dialog = screen.getByRole('dialog', { name: /confirm careful moves/i });
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByText(/Preflight checks complete/i)).toBeInTheDocument();
    expect(within(dialog).getByText('C:/Users/you/Downloads/Invoices/invoice-unknown-2026-06-23.pdf')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /confirm apply/i }));

    expect(screen.queryByRole('dialog', { name: /confirm careful moves/i })).not.toBeInTheDocument();
    expect(screen.getByText(/Applied 4 careful moves/i)).toBeInTheDocument();
  });

  it('shows duplicate groups and can stage duplicate suspects for the Duplicates folder', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: /scan sample folder/i }));
    await user.click(screen.getByRole('button', { name: /^duplicates$/i }));

    expect(screen.getByText(/Duplicate groups/i)).toBeInTheDocument();
    expect(screen.getByText(/invoice-final-final copy.pdf/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /move duplicate suspects to duplicates/i }));

    expect(screen.getByText(/2 selected for approval/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Duplicates\//i).length).toBeGreaterThan(0);
  });

  it('renders operation history with successful and failed operations', async () => {
    render(<App />);

    expect(await screen.findByText(/Recent operations/i)).toBeInTheDocument();
    expect(screen.getByText(/batch-history/i)).toBeInTheDocument();
    expect(screen.getByText(/1 succeeded, 1 failed/i)).toBeInTheDocument();
    expect(screen.getByText(/source file does not exist/i)).toBeInTheDocument();
  });

  it('calls the native undo operation and reports partial failures', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: /scan sample folder/i }));
    await user.click(screen.getByRole('button', { name: /apply high confidence/i }));
    await user.click(screen.getByRole('button', { name: /confirm apply/i }));
    await user.click(screen.getByRole('button', { name: /undo last operation/i }));

    expect(mocks.undoLastOperation).toHaveBeenCalledOnce();
    expect(screen.getByText(/Undo restored 1 files/i)).toBeInTheDocument();
    expect(screen.getByText(/setup.exe: destination missing/i)).toBeInTheDocument();
  });

  it('keeps the browser sample data available for preview', () => {
    expect(sampleFiles()).toHaveLength(4);
  });

  it('keeps selected apply payloads narrow and safety-oriented', async () => {
    const suggestion: FileSuggestion = makeSuggestion({
      id: 'payload-check',
      name: 'setup.exe',
      path: 'C:/Users/you/Downloads/setup.exe',
      size: 8_192_000,
      hash: 'hash-installer',
      modifiedAt: '2026-06-22T09:00:00.000Z',
    });

    expect({
      id: suggestion.id,
      path: suggestion.path,
      suggestedRelativePath: suggestion.suggestedRelativePath,
      expectedHash: suggestion.hash,
      expectedSize: suggestion.size,
    }).toEqual({
      id: 'payload-check',
      path: 'C:/Users/you/Downloads/setup.exe',
      suggestedRelativePath: 'Installers/setup-2026-06-22.exe',
      expectedHash: 'hash-installer',
      expectedSize: 8_192_000,
    });
  });
});
