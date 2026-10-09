import {useState} from 'react';
import {useTranslation} from 'react-i18next';
import {Flag} from 'lucide-react';
import {useCurrentLeague, useLeaguesStore} from '@/state/leaguesStore';
import {fromLocalInputValue, toLocalInputValue, type League} from '@/lib/leagues';
import HoldButton from '@/components/ui/HoldButton';

function formatStart(ts: number): string {
  return new Intl.DateTimeFormat(undefined, {dateStyle: 'medium', timeStyle: 'short'}).format(new Date(ts));
}

function LeagueRow({league}: {league: League}) {
  const {t}      = useTranslation('settings');
  const setStart = useLeaguesStore(s => s.setStart);
  const isUser   = league.source === 'user';
  // Draft while editing; commit on blur/Enter so half-typed dates never reach the DB.
  const [draft, setDraft] = useState<string | null>(null);

  const commit = () => {
    if (draft === null) return;
    const ts = fromLocalInputValue(draft);
    setDraft(null);
    if (ts !== null && ts !== league.startsAt) void setStart(league.id, ts);
  };

  return (
    <li className="flex items-center justify-between gap-3 py-1.5">
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-sm text-text-primary truncate">{league.name}</span>
        <span className={[
          'text-[9px] font-bold uppercase tracking-wider px-1.5 py-px rounded-full shrink-0',
          isUser ? 'bg-accent/20 text-accent' : 'bg-white/10 text-text-secondary',
        ].join(' ')}>
          {isUser ? t('league.manual') : t('league.official')}
        </span>
        {league.startsAt > Date.now() && (
          <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-px rounded-full shrink-0 bg-gold/15 text-gold">
            {t('league.upcoming')}
          </span>
        )}
      </div>
      {isUser ? (
        <input
          type="datetime-local"
          aria-label={t('league.editStart', {name: league.name})}
          value={draft ?? toLocalInputValue(league.startsAt)}
          onChange={e => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={e => {
            if (e.key === 'Enter') commit();
            else if (e.key === 'Escape') setDraft(null);
          }}
          className="bg-bg border border-border rounded-lg px-2 py-1 text-xs font-mono tabular-nums text-text-primary outline-none focus:border-accent/50 transition-colors"
        />
      ) : (
        <span className="text-xs text-text-secondary tabular-nums shrink-0">{formatStart(league.startsAt)}</span>
      )}
    </li>
  );
}

export default function LeagueSection() {
  const {t}      = useTranslation('settings');
  const leagues  = useLeaguesStore(s => s.leagues);
  const startNow = useLeaguesStore(s => s.startNow);
  const current  = useCurrentLeague();
  const [name, setName] = useState('');

  const sorted = [...leagues].sort((a, b) => b.startsAt - a.startsAt);

  return (
    <section className="mb-8">
      <h2 className="text-[11px] font-semibold text-text-secondary uppercase tracking-widest mb-4">
        {t('league.heading')}
      </h2>
      <div className="bg-surface rounded-lg p-4 border border-border mb-3">
        <p className="text-xs text-text-secondary mb-1">{t('league.current')}</p>
        {current ? (
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-semibold text-accent">{current.name}</span>
            <span className="text-xs text-text-secondary">
              {t('league.startsOn', {date: formatStart(current.from)})}
            </span>
          </div>
        ) : (
          <span className="text-sm text-text-disabled">{t('league.none')}</span>
        )}
      </div>

      {sorted.length > 0 && (
        <div className="bg-surface rounded-lg p-4 border border-border mb-3">
          <p className="text-sm text-text-primary mb-2">{t('league.known')}</p>
          <ul className="divide-y divide-border">
            {sorted.map(l => <LeagueRow key={l.id} league={l} />)}
          </ul>
        </div>
      )}

      <div className="bg-surface rounded-lg p-4 border border-border">
        <div className="flex items-center justify-between gap-3 mb-2">
          <p className="text-sm text-text-primary">{t('league.startNow.label')}</p>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={name}
              maxLength={100}
              onChange={e => setName(e.target.value)}
              placeholder={t('league.startNow.namePlaceholder')}
              className="w-48 bg-bg border border-border rounded-lg px-3 py-1.5 text-sm text-text-primary outline-none focus:border-accent/50 transition-colors placeholder:text-text-disabled"
            />
            <HoldButton
              title={t('league.startNow.hold')}
              onConfirm={() => {
                void startNow(name.trim() || undefined);
                setName('');
              }}
              className="bg-surface-elevated border border-border text-text-secondary hover:text-accent hover:border-accent"
            >
              <Flag className="w-4 h-4" />
            </HoldButton>
          </div>
        </div>
        <p className="text-xs text-text-secondary">{t('league.hint')}</p>
      </div>
    </section>
  );
}
