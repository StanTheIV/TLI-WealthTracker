import {useEffect} from 'react';
import {useTranslation} from 'react-i18next';
import {useLoggingStore} from '@/state/loggingStore';
import type {LogFeature, LogType} from '@/main/logger';

const ALL_FEATURES: LogFeature[] = [
  'engine', 'worker', 'database', 'ipc', 'overlay',
  'session', 'price', 'wealth', 'app', 'filter',
];

const ALL_TYPES: LogType[] = ['info', 'warn', 'error', 'debug'];

// ---------------------------------------------------------------------------
// Sub-component: pill toggle button
// ---------------------------------------------------------------------------

interface PillProps {
  active: boolean;
  onClick: () => void;
  label: string;
}

function Pill({active, onClick, label}: PillProps) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1.5 rounded-md border text-xs transition-colors ${
        active
          ? 'bg-accent/15 border-accent text-accent'
          : 'bg-surface-elevated border-border text-text-secondary hover:bg-accent/10 hover:border-accent'
      }`}
    >
      {label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Sub-component: target config card (Console or File)
// ---------------------------------------------------------------------------

interface TargetCardProps {
  heading: string;
  description: string;
  enabled: boolean;
  features: LogFeature[];
  types: LogType[];
  onToggleEnabled: () => void;
  onToggleFeature: (f: LogFeature) => void;
  onToggleType: (t: LogType) => void;
  children?: React.ReactNode;
}

function TargetCard({
  heading, description, enabled,
  features, types,
  onToggleEnabled, onToggleFeature, onToggleType,
  children,
}: TargetCardProps) {
  const {t} = useTranslation('settings');

  return (
    <div className="bg-surface rounded-lg p-4 border border-border">
      {/* Header row */}
      <div className="flex items-center justify-between mb-3">
        <div>
          <p className="text-sm font-medium text-text-primary">{heading}</p>
          <p className="text-xs text-text-secondary mt-0.5">{description}</p>
        </div>
        <button
          onClick={onToggleEnabled}
          className={`px-3 py-1.5 rounded-md border text-xs font-medium transition-colors ${
            enabled
              ? 'bg-accent/15 border-accent text-accent'
              : 'bg-surface-elevated border-border text-text-secondary hover:bg-accent/10 hover:border-accent'
          }`}
        >
          {enabled ? t('logging.enabled') : t('logging.disabled')}
        </button>
      </div>

      {/* Extra slot (e.g. file path) */}
      {children}

      {/* Features */}
      <div className="mt-4">
        <p className="text-[11px] font-semibold text-text-secondary uppercase tracking-widest mb-2">
          {t('logging.features')}
        </p>
        <div className="flex flex-wrap gap-1.5">
          {ALL_FEATURES.map(f => (
            <Pill
              key={f}
              active={features.includes(f)}
              onClick={() => onToggleFeature(f)}
              label={t(`logging.featureNames.${f}` as never)}
            />
          ))}
        </div>
      </div>

      {/* Types */}
      <div className="mt-4">
        <p className="text-[11px] font-semibold text-text-secondary uppercase tracking-widest mb-2">
          {t('logging.types')}
        </p>
        <div className="flex flex-wrap gap-1.5">
          {ALL_TYPES.map(tp => (
            <Pill
              key={tp}
              active={types.includes(tp)}
              onClick={() => onToggleType(tp)}
              label={t(`logging.typeNames.${tp}` as never)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// LoggingTab
// ---------------------------------------------------------------------------

export default function LoggingTab() {
  const {t} = useTranslation('settings');

  const isLoaded           = useLoggingStore(s => s.isLoaded);
  const load               = useLoggingStore(s => s.load);
  const logFilePath        = useLoggingStore(s => s.logFilePath);

  const consoleConfig      = useLoggingStore(s => s.console);
  const fileConfig         = useLoggingStore(s => s.file);

  const setConsoleEnabled  = useLoggingStore(s => s.setConsoleEnabled);
  const setFileEnabled     = useLoggingStore(s => s.setFileEnabled);
  const toggleConsoleFeature = useLoggingStore(s => s.toggleConsoleFeature);
  const toggleConsoleType    = useLoggingStore(s => s.toggleConsoleType);
  const toggleFileFeature    = useLoggingStore(s => s.toggleFileFeature);
  const toggleFileType       = useLoggingStore(s => s.toggleFileType);

  useEffect(() => {
    if (!isLoaded) load();
  }, [isLoaded, load]);

  if (!isLoaded) return null;

  return (
    <>
      <section className="mb-8">
        <h2 className="text-[11px] font-semibold text-text-secondary uppercase tracking-widest mb-4">
          {t('logging.console.heading')}
        </h2>
        <TargetCard
          heading={t('logging.console.heading')}
          description={t('logging.console.description')}
          enabled={consoleConfig.enabled}
          features={consoleConfig.features}
          types={consoleConfig.types}
          onToggleEnabled={() => setConsoleEnabled(!consoleConfig.enabled)}
          onToggleFeature={toggleConsoleFeature}
          onToggleType={toggleConsoleType}
        />
      </section>

      <section className="mb-8">
        <h2 className="text-[11px] font-semibold text-text-secondary uppercase tracking-widest mb-4">
          {t('logging.file.heading')}
        </h2>
        <TargetCard
          heading={t('logging.file.heading')}
          description={t('logging.file.description')}
          enabled={fileConfig.enabled}
          features={fileConfig.features}
          types={fileConfig.types}
          onToggleEnabled={() => setFileEnabled(!fileConfig.enabled)}
          onToggleFeature={toggleFileFeature}
          onToggleType={toggleFileType}
        >
          {logFilePath && (
            <div className="mt-3 mb-1">
              <p className="text-[11px] font-semibold text-text-secondary uppercase tracking-widest mb-1.5">
                {t('logging.file.pathLabel')}
              </p>
              <div className="bg-bg border border-border rounded-lg px-3 py-2 text-xs font-mono text-text-secondary truncate">
                {logFilePath}
              </div>
            </div>
          )}
        </TargetCard>
      </section>
    </>
  );
}
