import { BRAND, BRAND_ARTWORK } from '@laqum/shared';
import { useEffect, useState } from 'react';
import illustration from '../brand/intro-illustration.jpg';
import illustration2x from '../brand/intro-illustration@2x.jpg';
import wordmark from '../brand/intro-wordmark.svg';
import type { IntroPlan } from '../intro.js';

/**
 * The opening animation: the illustration fades and scales in on a card of
 * its own paper colour, then the wordmark settles into its place.
 *
 * It sits OVER the app, never in front of its work: App mounts beside it at
 * the same moment, so sign-in and the realtime connection start at once;
 * pointer-events are off, so nothing underneath waits for it; and it is
 * aria-hidden, so the page's name (its <title>) is what a screen reader
 * hears. The motion is CSS (index.css); this only removes it when done.
 */
export function Intro({ plan }: { plan: IntroPlan | null }): React.JSX.Element | null {
  const [done, setDone] = useState(plan === null);

  useEffect(() => {
    if (plan === null) return;
    const timer = setTimeout(() => {
      setDone(true);
    }, plan.durationMs);
    return () => {
      clearTimeout(timer);
    };
  }, [plan]);

  if (plan === null || done) return null;

  const box = BRAND_ARTWORK.wordmark;
  return (
    <div
      className="laqum-intro"
      data-testid="intro"
      data-reduced-motion={plan.reducedMotion ? 'true' : 'false'}
      aria-hidden="true"
    >
      <div className="laqum-intro-card" style={{ backgroundColor: BRAND.paper }}>
        <div className="laqum-intro-picture" style={{ aspectRatio: String(BRAND_ARTWORK.aspect) }}>
          <img src={illustration} srcSet={`${illustration} 1x, ${illustration2x} 2x`} alt="" />
          <img
            className="laqum-intro-wordmark"
            src={wordmark}
            alt=""
            style={{
              left: `${String(box.left * 100)}%`,
              top: `${String(box.top * 100)}%`,
              width: `${String(box.width * 100)}%`,
              height: `${String(box.height * 100)}%`,
            }}
          />
        </div>
      </div>
    </div>
  );
}
