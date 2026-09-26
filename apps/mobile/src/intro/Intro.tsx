import { BRAND, BRAND_ARTWORK } from '@laqum/shared';
import * as Linking from 'expo-linking';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Animated,
  Easing,
  Image,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';
import illustration from '../../assets/brand/intro-illustration.jpg';
import wordmark from '../../assets/brand/intro-wordmark.png';
import { restoreLanguage, useT } from '../i18n/react.js';
import {
  INTRO_EXIT,
  INTRO_SETTLED_MS,
  INTRO_TRACKS,
  type IntroPlan,
  type IntroTrack,
  claimColdStart,
  introCard,
  introPlan,
  introStage,
} from './timeline.js';

/**
 * THE OPENING ANIMATION, over the app while it restores the session.
 *
 * What plays and when is decided in timeline.ts, which the tests check; this
 * only draws it. The native splash (navy, the white mark) hands over to a
 * navy backdrop, so there is no flash between the two; the illustration sits
 * on a card of its own paper colour, which is also what keeps it from being
 * a white rectangle floating on a dark screen.
 *
 * Built on React Native's Animated with the native driver: opacity and
 * transform only. No animation library is added (Reanimated happens to be
 * linked through expo-router's peers; it is not used).
 *
 * Where the wordmark lands on the picture (BRAND_ARTWORK) is generated with
 * the images by scripts/brand/build.mjs, from the one source.
 */

const { wordmark: WORDMARK, aspect: ILLUSTRATION_ASPECT } = BRAND_ARTWORK;
/** The app's own scheme (app.config.ts); a link in it skips the intro. */
const APP_SCHEME = 'laqum';
/** Never let the decision itself hold the app: without an answer, skip. */
const DECIDE_TIMEOUT_MS = 300;

const EASINGS: Record<IntroTrack['easing'], (value: number) => number> = {
  'out-cubic': Easing.out(Easing.cubic),
  'in-quad': Easing.in(Easing.quad),
};

function timing(value: Animated.Value, track: IntroTrack): Animated.CompositeAnimation {
  return Animated.timing(value, {
    toValue: track.to,
    duration: track.durationMs,
    delay: track.delayMs,
    easing: EASINGS[track.easing],
    useNativeDriver: true,
  });
}

/** Only on a cold start: the launch URL and the motion setting decide the rest. */
async function decide(): Promise<IntroPlan> {
  const answer = Promise.all([
    Linking.getInitialURL().catch(() => null),
    AccessibilityInfo.isReduceMotionEnabled().catch(() => false),
  ]).then(([initialUrl, reduceMotion]) =>
    introPlan({ coldStart: true, initialUrl, appScheme: APP_SCHEME, reduceMotion }),
  );
  const timeout = new Promise<IntroPlan>((resolve) => {
    setTimeout(() => {
      resolve({ kind: 'skip', reason: 'undecided' });
    }, DECIDE_TIMEOUT_MS);
  });
  return Promise.race([answer, timeout]);
}

export function Intro({ ready }: { ready: boolean }): React.JSX.Element | null {
  const t = useT();
  // Read when the announcement is made, after the language is restored.
  const translate = useRef(t);
  translate.current = t;
  const { width: screenWidth } = useWindowDimensions();
  // Claimed synchronously, so a warm start never draws even one navy frame.
  const [coldStart] = useState(claimColdStart);
  const [plan, setPlan] = useState<IntroPlan | null>(
    coldStart ? null : { kind: 'skip', reason: 'not-cold-start' },
  );
  const [entranceDone, setEntranceDone] = useState(false);
  const [exitDone, setExitDone] = useState(false);
  const readyNow = useRef(ready);
  readyNow.current = ready;
  const [readyWhenEntranceEnded, setReadyWhenEntranceEnded] = useState(false);

  const values = useRef({
    illustrationOpacity: new Animated.Value(0),
    illustrationScale: new Animated.Value(0.94),
    wordmarkOpacity: new Animated.Value(0),
    wordmarkY: new Animated.Value(14),
    overlayOpacity: new Animated.Value(1),
  }).current;

  // Decide once, on a cold start's mount.
  useEffect(() => {
    if (!coldStart) return;
    let cancelled = false;
    void decide().then((decided) => {
      if (!cancelled) setPlan(decided);
    });
    return () => {
      cancelled = true;
    };
  }, [coldStart]);

  // Play the entrance, or hold the static frame.
  useEffect(() => {
    if (plan === null || plan.kind === 'skip') return;
    const finish = (): void => {
      setReadyWhenEntranceEnded(readyNow.current);
      setEntranceDone(true);
    };
    // One announcement, in the driver's language: wait for it to be restored.
    void restoreLanguage().then(() => {
      AccessibilityInfo.announceForAccessibility(translate.current('intro.loading'));
    });
    if (plan.kind === 'static') {
      values.illustrationOpacity.setValue(1);
      values.illustrationScale.setValue(1);
      values.wordmarkOpacity.setValue(1);
      values.wordmarkY.setValue(0);
      const timer = setTimeout(finish, plan.holdMs);
      return () => {
        clearTimeout(timer);
      };
    }
    const byTrack: Record<string, Animated.Value> = {
      'illustration.opacity': values.illustrationOpacity,
      'illustration.scale': values.illustrationScale,
      'wordmark.opacity': values.wordmarkOpacity,
      'wordmark.translateY': values.wordmarkY,
    };
    const animations = INTRO_TRACKS.map((track) => {
      const value = byTrack[`${track.target}.${track.property}`];
      if (!value) throw new Error(`no value for ${track.target}.${track.property}`);
      return timing(value, track);
    });
    Animated.parallel(animations).start();
    // The entrance ends at a fixed moment, whatever the animations report.
    const timer = setTimeout(finish, INTRO_SETTLED_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [plan, values]);

  const stage = introStage({ plan, entranceDone, ready, readyWhenEntranceEnded, exitDone });

  useEffect(() => {
    if (stage !== 'exit') return;
    timing(values.overlayOpacity, INTRO_EXIT).start(({ finished }) => {
      if (finished) setExitDone(true);
    });
  }, [stage, values]);

  if (stage === 'gone') return null;

  const card = introCard(screenWidth);
  const pictureWidth = card.width - 2 * card.padding;
  const pictureHeight = pictureWidth / ILLUSTRATION_ASPECT;

  return (
    <Animated.View
      testID="intro"
      // Decorative: a screen reader hears the one announcement, not the picture.
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
      pointerEvents={stage === 'exit' ? 'none' : 'auto'}
      style={[styles.overlay, { opacity: values.overlayOpacity }]}
    >
      {/* Light icons on the navy; the app's own bar returns with the app. */}
      <StatusBar style="light" />
      {stage === 'deciding' ? null : (
        <>
          <Animated.View
            style={[
              styles.card,
              {
                width: card.width,
                padding: card.padding,
                borderRadius: card.radius,
                opacity: values.illustrationOpacity,
                transform: [{ scale: values.illustrationScale }],
              },
            ]}
          >
            <View style={{ width: pictureWidth, height: pictureHeight }}>
              <Image
                source={illustration}
                style={{ width: pictureWidth, height: pictureHeight }}
                resizeMode="contain"
              />
              <Animated.Image
                source={wordmark}
                resizeMode="stretch"
                style={{
                  position: 'absolute',
                  left: WORDMARK.left * pictureWidth,
                  top: WORDMARK.top * pictureHeight,
                  width: WORDMARK.width * pictureWidth,
                  height: WORDMARK.height * pictureHeight,
                  opacity: values.wordmarkOpacity,
                  transform: [{ translateY: values.wordmarkY }],
                }}
              />
            </View>
          </Animated.View>
          {/* Still restoring once the entrance is over: wait calmly, no replay. */}
          <View style={styles.waiting}>
            {stage === 'waiting' ? <ActivityIndicator color={BRAND.onNavy} /> : null}
          </View>
        </>
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFill,
    backgroundColor: BRAND.navy,
    alignItems: 'center',
    justifyContent: 'center',
  },
  card: { backgroundColor: BRAND.paper, overflow: 'hidden' },
  waiting: { height: 48, marginTop: 24, justifyContent: 'center' },
});
