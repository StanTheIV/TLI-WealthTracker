import {useEffect, useRef, useState} from 'react';

interface AnimatedPresence {
  shouldRender: boolean;
  animClass:    string;
}

const ENTER_CLASS = 'animate-[tracker-row-enter_250ms_ease-out_forwards]';
const EXIT_CLASS  = 'animate-[tracker-row-exit_250ms_ease-in_forwards] overflow-hidden';

/**
 * Controls deferred unmount for animated enter/exit of tracker rows.
 *
 * - isPresent → true:  renders immediately, plays entry animation
 * - isPresent → false: plays exit animation, unmounts after durationMs
 */
export function useAnimatedPresence(isPresent: boolean, durationMs = 250): AnimatedPresence {
  const [shouldRender, setShouldRender] = useState(isPresent);
  const [animClass, setAnimClass]       = useState<string>(isPresent ? ENTER_CLASS : '');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);

    if (isPresent) {
      setShouldRender(true);
      setAnimClass(ENTER_CLASS);
      timerRef.current = setTimeout(() => setAnimClass(''), durationMs);
    } else {
      setAnimClass(EXIT_CLASS);
      timerRef.current = setTimeout(() => {
        setShouldRender(false);
        setAnimClass('');
      }, durationMs);
    }

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [isPresent, durationMs]);

  return {shouldRender, animClass};
}
