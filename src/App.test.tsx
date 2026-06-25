import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { attachDuplicateGroups, makeSuggestion, type FileSuggestion } from './core/downloadsButler';
import { sampleFiles } from './tauriClient';

const mocks = vi.hoisted(() => ({
  undoLastOperation: vi.fn(),
}));

vi.mock('./tauriClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./tauriClient')>();
  return {
    ...actual,
    chooseFolder: vi.fn(async () => 'C:/Users/you/Downloads'),
    scanFolder: vi.fn(async (folderPath: string) => attachDuplicateGroups(actual.sampleFiles(folderPath).map(makeSuggestion))),
    applySuggestions: vi.fn(async (suggestions: FileSuggestion[]) => ({
      id: 'batch-test',
      timestamp: '2026-06-24T10:00:00.000Z',
      operations: suggestions.map((suggestion) => ({
        id: `op-${suggestion.id}`,
        beforePath: suggestion.path,
        afterPath: `C:/Users/you/Downloads/${suggestion.suggestedRelativePath}`,
        fileName: suggestion.name,
      })),
    })),
    undoLastOperation: mocks.undoLastOperation,
  };
});

describe('Downloads Butler app', () => {
  beforeEach(() => {
    mocks.undoLastOperation.mockClear();
    mocks.undoLastOperation.mockResolvedValue({ restored: 3 });
  });

  it('shows scan suggestions and keeps Unknown files out of high-confidence apply', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: /scan sample folder/i }));
    expect(screen.getByText('invoice-final-final.pdf')).toBeInTheDocument();
    expect(screen.getByText('mystery-download.bin')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /apply high confidence/i }));
    await user.click(screen.getByRole('button', { name: /confirm apply/i }));

    expect(screen.getByText(/Applied 3 careful moves/i)).toBeInTheDocument();
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

  it('previews selected moves before applying them', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: /scan sample folder/i }));
    await user.click(screen.getByRole('button', { name: /apply selected/i }));

    expect(screen.getByRole('dialog', { name: /confirm careful moves/i })).toBeInTheDocument();
    expect(screen.getByText(/3 files selected/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /confirm apply/i }));

    expect(screen.queryByRole('dialog', { name: /confirm careful moves/i })).not.toBeInTheDocument();
    expect(screen.getByText(/Applied 3 careful moves/i)).toBeInTheDocument();
  });

  it('calls the native undo operation and reports restored files', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: /scan sample folder/i }));
    await user.click(screen.getByRole('button', { name: /apply high confidence/i }));
    await user.click(screen.getByRole('button', { name: /confirm apply/i }));
    await user.click(screen.getByRole('button', { name: /undo last operation/i }));

    expect(mocks.undoLastOperation).toHaveBeenCalledOnce();
    expect(screen.getByText(/Undo restored 3 files/i)).toBeInTheDocument();
  });

  it('keeps the browser sample data available for preview', () => {
    expect(sampleFiles()).toHaveLength(4);
  });
});
