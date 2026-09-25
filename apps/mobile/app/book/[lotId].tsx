import { billableLotFromSummary, computeBill, haversineMeters } from '@laqum/shared';
import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import type { LotSummary } from '../../src/api/endpoints.js';
import { errorPhrase } from '../../src/api/messages.js';
import { type MessageKey, type Phrase, phrase, verbatim } from '../../src/i18n/core.js';
import { useT } from '../../src/i18n/react.js';
import { decide, gate, type GateDecision } from '../../src/location/gate.js';
import { getFix, type FixAccuracy, type PermissionPrompt } from '../../src/location/useLocation.js';
import { bookButton } from '../../src/booking/button.js';
import { afterBooking } from '../../src/booking/deposit.js';
import { bookingRequest } from '../../src/booking/request.js';
import { useApp } from '../../src/state/app.js';
import { useTheme } from '../../src/theme.js';
import { Body, Button, Card, Loading, Notice, Title, useBottomInset } from '../../src/ui.js';

/**
 * Duration, plate, cost preview, and the location gate.
 *
 * THE GATE runs before the request, not instead of it. It exists to give the
 * driver an immediate, specific answer when the fix clearly settles the
 * question, and to avoid burning a round trip on a fix that settles nothing.
 * The server is still the authority: a `proceed` here can still come back
 * TOO_FAR, and that answer wins.
 */
/** A location failure on screen, with the recovery that actually helps. */
type LocationProblem =
  | { kind: 'blocked'; message: MessageKey }
  | { kind: 'unavailable'; message: MessageKey; retryAccuracy: FixAccuracy };

export default function Book(): React.JSX.Element {
  const { lotId } = useLocalSearchParams<{ lotId: string }>();
  const theme = useTheme();
  const t = useT();
  const { api } = useApp();
  const bottomInset = useBottomInset(20);

  const [lot, setLot] = useState<LotSummary | null>(null);
  const [blocks, setBlocks] = useState(2);
  const [plate, setPlate] = useState('');
  const [decision, setDecision] = useState<GateDecision | null>(null);
  // The accuracy of the check in flight; false when none is running.
  const [locating, setLocating] = useState<false | FixAccuracy>(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Phrase | null>(null);
  const [locationProblem, setLocationProblem] = useState<LocationProblem | null>(null);

  useEffect(() => {
    if (!lotId) return;
    void api.lot(lotId).then((result) => {
      if (result.ok) setLot(result.data);
      else setError(errorPhrase(result.error));
    });
  }, [api, lotId]);

  /**
   * Get a fix and run the gate against THIS lot's radius.
   *
   * `prompt`: 'first-time' when it runs by itself, 'on-tap' from a button.
   * See PermissionPrompt for why an automatic check must never re-ask.
   * `accuracy`: 'highest' only for the Retry after need_better_fix.
   */
  const checkLocation = useCallback(
    async (
      prompt: PermissionPrompt,
      accuracy: FixAccuracy = 'balanced',
    ): Promise<GateDecision | null> => {
      if (!lot) return null;
      setLocating(accuracy);
      setLocationProblem(null);
      try {
        const fix = await getFix(prompt, accuracy);
        // A failed check replaces the last decision, so the screen never shows
        // a stale gate notice next to the new problem.
        if (fix.kind !== 'fix') setDecision(null);

        if (fix.kind === 'services_off') {
          setLocationProblem({
            kind: 'blocked',
            message: 'book.locationServicesOff',
          });
          return null;
        }
        if (fix.kind === 'permission_denied') {
          setLocationProblem({
            kind: 'blocked',
            message: fix.canAskAgain ? 'book.locationDenied' : 'book.locationBlocked',
          });
          return null;
        }
        if (fix.kind === 'unavailable') {
          setLocationProblem({
            kind: 'unavailable',
            message:
              accuracy === 'highest' ? 'book.locationPreciseTimeout' : 'book.locationNotFound',
            retryAccuracy: accuracy,
          });
          return null;
        }

        // The SAME haversine the server uses, so the two cannot disagree at the
        // boundary — a second implementation would be a second set of rounding.
        const distanceM = haversineMeters(
          { latitude: fix.fix.latitude, longitude: fix.fix.longitude },
          { latitude: lot.latitude, longitude: lot.longitude },
        );

        const result = gate(
          fix.fix,
          { distanceM, accuracyM: fix.fix.accuracyM, limitM: lot.maxBookingDistanceM },
          Date.now(),
        );
        setDecision(result);
        return result;
      } finally {
        setLocating(false);
      }
    },
    [lot],
  );

  useEffect(() => {
    if (lot) void checkLocation('first-time');
  }, [lot, checkLocation]);

  async function book(): Promise<void> {
    if (!lot) return;

    // Re-check immediately before sending: the driver may have walked, and a
    // decision from two minutes ago is exactly the staleness the gate rejects.
    const fresh = await checkLocation('on-tap');
    if (fresh?.kind !== 'proceed') return;

    setBusy(true);
    setError(null);

    const fix = await getFix('on-tap');
    if (fix.kind !== 'fix') {
      setBusy(false);
      setLocationProblem({
        kind: 'unavailable',
        message: 'book.locationNotConfirmed',
        retryAccuracy: 'balanced',
      });
      return;
    }

    // Built by bookingRequest, which the API's contract test also calls.
    const result = await api.createBooking(
      bookingRequest({
        lotId: lot.id,
        blocks,
        blockMinutes: lot.blockMinutes,
        position: fix.fix,
        plate,
      }),
    );
    setBusy(false);

    if (!result.ok) {
      // TOO_FAR carries the server's own numbers; show those rather than ours.
      const details = result.error.details as
        { distanceM?: number; maxDistanceM?: number } | undefined;
      setError(
        result.error.code === 'TOO_FAR' && details?.distanceM !== undefined
          ? phrase('book.tooFarServer', {
              distance: Math.round(details.distanceM),
              limit: details.maxDistanceM ?? lot.maxBookingDistanceM,
            })
          : errorPhrase(result.error),
      );
      return;
    }

    // A deposit means Chapa, in an in-app browser so the driver keeps their
    // place in the app. When it could not start, the booking screen says so
    // and offers the retry (src/booking/deposit.ts).
    const next = afterBooking(result.data);
    if (next.checkoutUrl !== null) await WebBrowser.openBrowserAsync(next.checkoutUrl);
    router.replace({ pathname: '/booking/[id]', params: next.params });
  }

  if (error && !lot) return <Notice tone="error" message={t.phrase(error)} />;
  if (!lot) return <Loading label={t('lot.loading')} />;

  const minutes = blocks * lot.blockMinutes;
  const preview = computeBill(
    {
      source: 'app',
      planned_minutes: minutes,
      checked_in_at: new Date(0),
      planned_end_at: new Date(minutes * 60_000),
      deposit_paid_santim: 0,
    },
    // The API sends camelCase; computeBill bills from the DB row's names.
    // This bridge replaced a double cast that crashed the device test.
    billableLotFromSummary(lot),
    new Date(minutes * 60_000),
  );

  const button = bookButton({
    locating,
    decision,
    locationProblem: locationProblem?.kind ?? false,
    booking: busy,
  });

  return (
    <ScrollView contentContainerStyle={[styles.content, { paddingBottom: bottomInset }]}>
      <Title>{verbatim(lot.name)}</Title>

      <Card>
        <Body>{t('book.howLong')}</Body>
        <View style={styles.blocks}>
          {[1, 2, 4, 8].map((count) => (
            <Pressable
              key={count}
              testID={`blocks-${String(count)}`}
              accessibilityRole="button"
              accessibilityState={{ selected: blocks === count }}
              onPress={() => {
                setBlocks(count);
              }}
              style={[
                styles.block,
                {
                  borderColor: blocks === count ? theme.accent : theme.line,
                  backgroundColor: blocks === count ? theme.accent : 'transparent',
                },
              ]}
            >
              <Body>{t('book.minutes', { count: count * lot.blockMinutes })}</Body>
            </Pressable>
          ))}
        </View>
      </Card>

      <Card>
        <Body>{t('book.plate')}</Body>
        <TextInput
          testID="plate-input"
          value={plate}
          onChangeText={(value) => {
            setPlate(value.toUpperCase());
          }}
          autoCapitalize="characters"
          placeholder="AA-12345"
          placeholderTextColor={theme.muted}
          accessibilityLabel={t('book.plateLabel')}
          style={[styles.input, { color: theme.text, borderColor: theme.line }]}
        />
      </Card>

      <Card>
        <Title>{t.money(preview.amountDueSantim)}</Title>
        <Body muted>{t('book.totalMinutes', { count: minutes })}</Body>
        {lot.depositAmountSantim > 0 ? (
          <Body muted>{t('book.depositNow', { amount: t.money(lot.depositAmountSantim) })}</Body>
        ) : (
          <Body muted>{t('book.payOnExit')}</Body>
        )}
      </Card>

      {/* The three gate outcomes, each with its own recovery. */}
      {locationProblem ? (
        <Notice
          tone="warn"
          testID="location-problem"
          message={t(locationProblem.message)}
          // Settings fixes a switch or a permission; only retrying fixes a
          // position that did not arrive.
          actionLabel={
            locationProblem.kind === 'blocked' ? t('common.openSettings') : t('common.retry')
          }
          onAction={() => {
            if (locationProblem.kind === 'blocked') void Linking.openSettings();
            else void checkLocation('on-tap', locationProblem.retryAccuracy);
          }}
        />
      ) : null}

      {decision?.kind === 'too_far' ? (
        <Notice
          tone="error"
          testID="gate-too-far"
          message={t('book.tooFar', {
            distance: Math.round(decision.distanceM),
            limit: decision.limitM,
          })}
        />
      ) : null}

      {decision?.kind === 'need_better_fix' ? (
        <Notice
          tone="warn"
          testID="gate-need-better-fix"
          message={t('book.needBetterFix', { accuracy: Math.round(decision.accuracyM) })}
          actionLabel={t('book.retryPrecisely')}
          // Balanced just said it was not precise enough; asking Balanced again
          // gets the same answer. The platform's highest accuracy, bounded.
          onAction={() => void checkLocation('on-tap', 'highest')}
        />
      ) : null}

      {decision?.kind === 'stale' ? (
        <Notice
          tone="warn"
          testID="gate-stale"
          message={t('book.stale')}
          actionLabel={t('common.retry')}
          onAction={() => void checkLocation('on-tap')}
        />
      ) : null}

      {error ? <Notice tone="error" message={t.phrase(error)} testID="book-error" /> : null}

      <Button
        testID="confirm-booking"
        label={t(button.label)}
        busy={busy || locating !== false}
        disabled={!button.enabled}
        onPress={() => void book()}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 20, gap: 14 },
  blocks: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  block: {
    borderWidth: 2,
    borderRadius: 12,
    paddingHorizontal: 14,
    minHeight: 48,
    justifyContent: 'center',
  },
  input: {
    minHeight: 52,
    borderWidth: 2,
    borderRadius: 12,
    paddingHorizontal: 14,
    fontSize: 18,
    fontWeight: '700',
  },
});

// Re-exported so the gate's pure decision can be exercised in tests without
// mounting the screen.
export { decide };
