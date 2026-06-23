import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import App from './App';

describe('Downloads Butler app', () => {
  it('shows scan suggestions and keeps Unknown files out of high-confidence apply', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: /scan sample folder/i }));
    expect(screen.getByText('invoice-final-final.pdf')).toBeInTheDocument();
    expect(screen.getByText('mystery-download.bin')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /apply high confidence/i }));

    expect(screen.getByText(/Applied 3 careful moves/i)).toBeInTheDocument();
    expect(screen.queryByText(/mystery-download.bin moved/i)).not.toBeInTheDocument();
  });
});
