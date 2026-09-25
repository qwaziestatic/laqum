import { billableLotFromSummary, computeBill, formatBirr, haversineMeters } from '@laqum/shared';
import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import type { LotSummary } from '../../src/api/endpoints.js';
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
  | { kind: 'blocked'; message: string }
  | { kind: 'unavailable'; message: string; retryAccuracy: FixAccuracy };

export default function Book(): React.JSX.Element {
  const { lotId } = useLocalSearchParams<{ lotId: string }>();
  const theme = useTheme();
  const { api } = useApp();
  const bottomInset = useBottomInset(20);

  const [lot, setLot] = useState<LotSummary | null>(null);
  const [blocks, setBlocks] = useState(2);
  const [plate, setPlate] = useState('');
  const [decision, setDecision] = useState<GateDecision | null>(null);
  // The accuracy of the check in flight; false when none is running.
  const [locating, setLocating] = useState<false | FixAccuracy>(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [locationProblem, setLocationProblem] = useState<LocationProblem | null>(null);

  useEffect(() => {
    if (!lotId) return;
    void api.lot(lotId).then((result) => {
      if (result.ok) setLot(result.data);
      else setError(result.error.message);
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
            message: 'Location is switched off. Turn it on to book a slot.',
          });
          return null;
        }
        if (fix.kind === 'permission_denied') {
          setLocationProblem({
            kind: 'blocked',
            message: fix.canAskAgain
              ? 'Laqum needs your location to confirm you are close enough to this lot.'
              : 'Location permission is blocked. Allow it in Settings to book.',
          });
          return null;
        }
        if (fix.kind === 'unavailable') {
          setLocationProblem({
            kind: 'unavailable',
            message:
              accuracy === 'highest'
                ? 'A precise position did not arrive in time. Step into the open, away from buildings, and try again.'
                : 'Your position could not be found. Step outside and try again.',
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
        message: 'Your position could not be confirmed. Try again.',
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
          ? `You are ${String(Math.round(details.distanceM))} m away. This lot only holds slots within ${String(details.maxDistanceM ?? lot.maxBookingDistanceM)} m.`
          : result.error.message,
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

  if (error && !lot) return <Notice tone="error" message={error} />;
  if (!lot) return <Loading label="Loading lot…" />;

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
      <Title>{lot.name}</Title>

      <Card>
        <Body>How long?</Body>
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
              <Body>{`${String(count * lot.blockMinutes)} min`}</Body>
            </Pressable>
          ))}
        </View>
      </Card>

      <Card>
        <Body>Plate (optional)</Body>
        <TextInput
          testID="plate-input"
          value={plate}
          onChangeText={(value) => {
            setPlate(value.toUpperCase());
          }}
          autoCapitalize="characters"
          placeholder="AA-12345"
          placeholderTextColor={theme.muted}
          accessibilityLabel="Vehicle plate"
          style={[styles.input, { color: theme.text, borderColor: theme.line }]}
        />
      </Card>

      <Card>
        <Title>{formatBirr(preview.amountDueSantim)}</Title>
        <Body muted>{`${String(minutes)} minutes`}</Body>
        {lot.depositAmountSantim > 0 ? (
          <Body
            muted
          >{`${formatBirr(lot.depositAmountSantim)} deposit now, the rest on exit`}</Body>
        ) : (
          <Body muted>Pay on exit. No deposit.</Body>
        )}
      </Card>

      {/* The three gate outcomes, each with its own recovery. */}
      {locationProblem ? (
        <Notice
          tone="warn"
          testID="location-problem"
          message={locationProblem.message}
          // Settings fixes a switch or a permission; only retrying fixes a
          // position that did not arrive.
          actionLabel={locationProblem.kind === 'blocked' ? 'Open settings' : 'Retry'}
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
          message={`You are about ${String(Math.round(decision.distanceM))} m away. This lot only holds slots within ${String(decision.limitM)} m.`}
        />
      ) : null}

      {decision?.kind === 'need_better_fix' ? (
        <Notice
          tone="warn"
          testID="gate-need-better-fix"
          message={`Your position is accurate to about ${String(Math.round(decision.accuracyM))} m, which is not precise enough this close to the limit. Step into the open and try again.`}
          actionLabel="Retry precisely"
          // Balanced just said it was not precise enough; asking Balanced again
          // gets the same answer. The platform's highest accuracy, bounded.
          onAction={() => void checkLocation('on-tap', 'highest')}
        />
      ) : null}

      {decision?.kind === 'stale' ? (
        <Notice
          tone="warn"
          testID="gate-stale"
          message="Your last position is too old to trust."
          actionLabel="Retry"
          onAction={() => void checkLocation('on-tap')}
        />
      ) : null}

      {error ? <Notice tone="error" message={error} testID="book-error" /> : null}

      <Button
        testID="confirm-booking"
        label={button.label}
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
