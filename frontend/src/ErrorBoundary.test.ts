import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const read = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');

describe('application error boundary contract', () => {
  it('renders a translated fallback and records descendant render errors', () => {
    const boundary = read('components/ErrorBoundary.tsx');
    assert.match(boundary, /class ErrorBoundary extends Component/);
    assert.match(boundary, /static getDerivedStateFromError/);
    assert.match(boundary, /componentDidCatch\(error: Error, errorInfo: ErrorInfo\)/);
    assert.match(boundary, /i18n\.t\('errorBoundary\.title'\)/);
    assert.match(boundary, /i18n\.t\('errorBoundary\.body'\)/);
    assert.match(boundary, /window\.location\.reload\(\)/);
  });

  it('wraps the router and application at the React entrypoint', () => {
    const main = read('main.tsx');
    assert.match(main, /<ErrorBoundary>[\s\S]*?<BrowserRouter>[\s\S]*?<App \/>[\s\S]*?<\/BrowserRouter>[\s\S]*?<\/ErrorBoundary>/);
  });
});
