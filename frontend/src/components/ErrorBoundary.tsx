import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import i18n from '../i18n.ts';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Inboxora render error:', error, errorInfo.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <main role="alert" style={{ minHeight: '100svh', display: 'grid', placeItems: 'center', padding: 24, background: 'var(--bg-primary)', color: 'var(--text-primary)' }}>
          <section style={{ maxWidth: 440, textAlign: 'center' }}>
            <h1>{i18n.t('errorBoundary.title')}</h1>
            <p>{i18n.t('errorBoundary.body')}</p>
            <button type="button" onClick={() => window.location.reload()}>{i18n.t('errorBoundary.reload')}</button>
          </section>
        </main>
      );
    }

    return this.props.children;
  }
}
