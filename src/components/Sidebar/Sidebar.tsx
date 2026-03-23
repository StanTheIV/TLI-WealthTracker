import {useTranslation} from 'react-i18next';

export type NavItemId = 'dashboard' | 'items' | 'sessions' | 'filters' | 'settings';

const NAV_ITEMS: {id: NavItemId; labelKey: string}[] = [
  {id: 'dashboard', labelKey: 'nav.dashboard'},
  {id: 'items',     labelKey: 'nav.items'},
  {id: 'sessions',  labelKey: 'nav.sessions'},
  {id: 'filters',   labelKey: 'nav.filters'},
  {id: 'settings',  labelKey: 'nav.settings'},
];

interface Props {
  activeItem: NavItemId;
  onNavChange: (id: NavItemId) => void;
}

export default function Sidebar({activeItem, onNavChange}: Props) {
  const {t} = useTranslation('sidebar');
  const {t: tCommon} = useTranslation('common');

  return (
    <nav className="flex flex-col shrink-0 w-[18%] min-w-[160px] bg-surface border-r border-border py-6">
      <div className="px-4 mb-6">
        <span className="text-base font-bold text-accent tracking-wide">
          {tCommon('appName')}
        </span>
      </div>

      <div className="mx-4 h-px bg-border mb-4" />

      <div className="flex-1">
        {NAV_ITEMS.map(item => {
          const active = item.id === activeItem;
          return (
            <button
              key={item.id}
              onClick={() => onNavChange(item.id)}
              className={[
                'relative flex items-center w-[calc(100%-16px)] mx-2 px-4 py-2.5 rounded-md text-sm transition-colors cursor-pointer',
                active
                  ? 'bg-[var(--color-accent)]/15 text-accent font-semibold'
                  : 'text-text-secondary font-medium hover:bg-white/5',
              ].join(' ')}>
              {active && (
                <div className="absolute left-0 top-[20%] w-[3px] h-[60%] rounded-full bg-accent" />
              )}
              <span className={active ? 'pl-2.5' : ''}>{t(item.labelKey as never)}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
