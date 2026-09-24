import { billableLotFromSummary, computeBill, formatBirr, haversineMeters } from '@laqum/shared';
import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import type { LotSummary } from '../../src/api/endpoints.js';
import { decide, gate, type GateDecision } from '../../src/location/gate.js';
import { getFix, type PermissionPrompt } from '../../src/location/useLocation.js';
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
export default function Book(): React.JSX.Element {
  const { lotId } = useLocalSearchParams<{ lotId: string }>();
  const theme = useTheme();
  const { api } = useApp();
  const bottomInset = useBottomInset(20);

  const [lot, setLot] = useState<LotSummary | null>(null);
  const [blocks, setBlocks] = useState(2);
  const [plate, setPlate] = useState('');
  const [decision, setDecision] = useState<GateDecision | null>(null);
  const [locating, setLocating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [locationProblem, setLocationProblem] = useState<string | null>(null);

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
   */
  const checkLocation = useCallback(
    async (prompt: PermissionPrompt): Promise<GateDecision | null> => {
      if (!lot) return null;
      setLocating(true);
      setLocationProblem(null);
      try {
        const fix = await getFix(prompt);

        if (fix.kind === 'services_off') {
          setLocationProblem('Location is switched off. Turn it on to book a slot.');
          return null;
        }
        if (fix.kind === 'permission_denied') {
          setLocationProblem(
            fix.canAskAgain
              ? 'Laqum needs your location to confirm you are close enough to this lot.'
              : 'Location permission is blocked. Allow it in Settings to book.',
          );
          return null;
        }
        if (fix.kind === 'unavailable') {
          setLocationProblem('Your position could not be found. Step outside and try again.');
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
      setLocationProblem('Your position could not be confirmed. Try again.');
      return;
    }

    const result = await api.createBooking({
      lotId: lot.id,
      plannedMinutes: blocks * lot.blockMinutes,
      latitude: fix.fix.latitude,
      longitude: fix.fix.longitude,
      ...(plate.trim() ? { vehiclePlate: plate.trim() } : {}),
    });
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
    // place in the app.
    if (result.data.paymentRequired && result.data.checkoutUrl) {
      await WebBrowser.openBrowserAsync(result.data.checkoutUrl);
    }
    router.replace(`/booking/${result.data.booking.id}`);
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

  const canBook = decision?.kind === 'proceed';

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
          message={locationProblem}
          actionLabel="Open settings"
          onAction={() => void Linking.openSettings()}
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
          actionLabel="Retry"
          onAction={() => void checkLocation('on-tap')}
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
        label={canBook ? 'Hold this slot' : 'Checking your location…'}
        busy={busy || locating}
        disabled={!canBook}
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
