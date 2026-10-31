import {Component, type ReactNode} from 'react';
import {useTranslation} from 'react-i18next';
import {reportError} from '@/lib/reportError';

interface Props {
  children: ReactNode;
  /** The small one-line panel for the transparent overlay. */
  compact?: boolean;
  /** After an error is reported — e.g. the overlay making its fallback visible and clickable. */
  onError?: () => void;
}

interface State {
  failed: boolean;
}

/**
 * One per window, around everything. A render error (or App init's, rethrown
 * into it) is reported to the main log and replaced by a panel whose Reload
 * button reloads the page — the store singletons make an in-place retry
 * unsafe; reload is safe (all state lives in main, the page catches up).
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = {failed: false};

  static getDerivedStateFromError(): State {
    return {failed: true};
  }

  componentDidCatch(error: unknown): void {
    reportError('render', error);
    try {
      this.props.onError?.();
    } catch (err) {
      reportError('error boundary onError', err);
    }
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return this.props.compact ? <CompactFallback /> : <Fallback />;
  }
}

function reload(): void {
  location.reload();
}

function Fallback() {
  const {t} = useTranslation('common');
  return (
    <div className="flex h-full items-center justify-center bg-bg p-6 text-text-primary">
      <div className="max-w-md rounded-lg border border-border bg-surface p-6 text-center">
        <p className="text-sm font-medium text-danger">{t('error.title')}</p>
        <p className="mt-2 text-xs text-text-secondary">{t('error.message')}</p>
        <button
          type="button"
          onClick={reload}
          className="mt-4 rounded-md border border-accent bg-accent/15 px-4 py-1.5 text-xs font-medium text-accent transition-colors hover:bg-accent/25"
        >
          {t('error.reload')}
        </button>
      </div>
    </div>
  );
}

/** Its height is the overlay window's (OVERLAY_FALLBACK_HEIGHT in App.tsx). */
function CompactFallback() {
  const {t} = useTranslation('common');
  return (
    <div className="flex h-16 items-center justify-between gap-3 rounded-xl border border-border bg-surface px-4 text-text-primary">
      <p className="truncate text-xs font-medium text-danger">{t('error.compact')}</p>
      <button
        type="button"
        onClick={reload}
        className="shrink-0 rounded-md border border-accent bg-accent/15 px-3 py-1 text-xs font-medium text-accent transition-colors hover:bg-accent/25"
      >
        {t('error.reload')}
      </button>
    </div>
  );
}
