import { formatBirr, isLiveStatus } from '@laqum/shared';
import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import * as Linking from 'expo-linking';
import type { DriverBooking, LotSummary } from '../../src/api/endpoints.js';
import { bookingView } from '../../src/booking/view.js';
import { navigateTo } from '../../src/nav/mapsLink.js';
import { maybeRegisterForPush } from '../../src/push/registration.js';
import { pushDeps } from '../../src/push/expoDeps.js';
import { useApp } from '../../src/state/app.js';
import { formatRemaining } from '../../src/time/serverClock.js';
import { Body, Button, Card, Loading, Notice, Title, useBottomInset } from '../../src/ui.js';

/**
 * The booking, in whichever state it is in.
 *
 * RESERVED → the hold countdown, navigate, and the QR to show at the gate.
 * CHECKED_IN / OVERSTAY → time remaining and extend.
 * CHECKED_OUT → straight to payment.
 * PAID / EXPIRED / CANCELLED → a sentence and "Find another slot".
 *
 * WHAT shows in each state — sentence, timer, actions — is decided in one
 * table, src/booking/view.ts, which view.test.ts checks for every status.
 *
 * One screen rather than three because the booking moves between these states
 * WHILE the driver is looking at it, and a navigation on every transition
 * would yank the screen out from under them mid-tap.
 */
export default function BookingScreen(): React.JSX.Element {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { api, client, foregroundEpoch } = useApp();
  const bottomInset = useBottomInset(20);

  const [booking, setBooking] = useState<DriverBooking | null>(null);
  const [lot, setLot] = useState<LotSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [coordinates, setCoordinates] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const askedForPush = useRef(false);

  const load = useCallback(async () => {
    if (!id) return;
    const result = await api.booking(id);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setBooking(result.data.booking);
    setError(null);

    const lotResult = await api.lot(result.data.booking.lotId);
    if (lotResult.ok) setLot(lotResult.data);
  }, [api, id]);

  useEffect(() => {
    void load();
  }, [load]);

  /*
   * FOREGROUND REFETCHES, it does not extrapolate.
   *
   * While the app slept the server may have expired the hold or an attendant
   * may have checked the car in. Continuing the old countdown would show a
   * confident, wrong number.
   */
  useEffect(() => {
    if (foregroundEpoch > 0) void load();
  }, [foregroundEpoch, load]);

  // A display tick. The VALUE comes from the server clock; this only decides
  // how often it is re-rendered.
  useEffect(() => {
    const timer = setInterval(() => {
      setTick((value) => value + 1);
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, []);

  // Poll while a deadline is running, so a server-side expiry lands here even
  // if the driver never leaves the screen.
  useEffect(() => {
    if (!booking) return;
    // LIVE_STATUSES is the one definition of "live"; never a local copy.
    if (!isLiveStatus(booking.status)) return;
    const timer = setInterval(() => void load(), 20_000);
    return () => {
      clearInterval(timer);
    };
  }, [booking, load]);

  /*
   * THE PUSH ASK, after the first successful booking — never at launch.
   * See push/registration.ts for why the timing is the whole design.
   */
  useEffect(() => {
    if (!booking || askedForPush.current) return;
    askedForPush.current = true;
    void maybeRegisterForPush(pushDeps(api, true));
  }, [booking, api]);

  if (error && !booking) {
    return <Notice tone="error" message={error} actionLabel="Retry" onAction={() => void load()} />;
  }
  if (!booking) return <Loading label="Loading your booking…" />;

  // Everything this screen shows for the status: src/booking/view.ts.
  const view = bookingView(booking);

  // The VALUE comes from the server clock; `tick` only re-renders each second.
  // Overstay counts UP from the planned end (remainingMs clamps at zero).
  const _renderTick = tick;
  const timerMs = view.timer
    ? view.timer.counts === 'down'
      ? client.clock.remainingMs(view.timer.deadline, performance.now(), Date.now())
      : client.clock.elapsedMs(view.timer.deadline, performance.now(), Date.now())
    : null;

  return (
    <ScrollView contentContainerStyle={[styles.content, { paddingBottom: bottomInset }]}>
      <Title>{lot?.name ?? 'Your booking'}</Title>
      <Body muted>{view.sentence}</Body>

      {!client.clock.synced ? (
        <Notice
          tone="info"
          testID="clock-unsynced"
          message="Times are approximate until the app reaches the server."
        />
      ) : null}

      {view.timer && timerMs !== null ? (
        <Card>
          <Body muted>{view.timer.label}</Body>
          <Title>{formatRemaining(timerMs)}</Title>
          {/* A countdown at zero on a LIVE status: the server has yet to move it
              on (expire, overstay). A finished booking has no card at all. */}
          {view.timer.counts === 'down' && timerMs === 0 ? (
            <Body muted>Checking with the server…</Body>
          ) : null}
        </Card>
      ) : null}

      {booking.status === 'OVERSTAY' ? (
        <Notice
          tone="error"
          testID="overstay-notice"
          message="You are over your booked time. Overstay is charged at a higher rate."
        />
      ) : null}

      {view.actions.showQr && booking.qrToken ? (
        <Card>
          <Body muted>Show this at the gate</Body>
          <View style={styles.qr}>
            <QRCode value={booking.qrToken} size={200} backgroundColor="white" />
          </View>
          {booking.shortCode ? <Title testID="short-code">{booking.shortCode}</Title> : null}
          <Body muted>Or read the code above to the attendant.</Body>
        </Card>
      ) : null}

      {view.actions.findAnotherSlot ? (
        <Button
          testID="find-another-slot"
          label="Find another slot"
          onPress={() => {
            router.replace('/');
          }}
        />
      ) : null}

      {lot && view.actions.navigate ? (
        <Button
          testID="navigate"
          label="Navigate"
          tone="plain"
          onPress={() => {
            void navigateTo(
              { latitude: lot.latitude, longitude: lot.longitude, label: lot.name },
              {
                canOpen: (url) => Linking.canOpenURL(url),
                open: async (url) => {
                  await Linking.openURL(url);
                },
              },
            ).then((outcome) => {
              // Nothing could open a map: give the driver the numbers.
              if (!outcome.opened) setCoordinates(outcome.coordinates);
            });
          }}
        />
      ) : null}

      {coordinates ? (
        <Notice
          tone="info"
          testID="no-maps-app"
          message={`No maps app could be opened. The lot is at ${coordinates}.`}
        />
      ) : null}

      {view.actions.extend ? (
        <Button
          testID="extend"
          // One block: its length is the lot's, and unknown until the lot loads.
          label={lot ? `Extend by ${String(lot.blockMinutes)} minutes` : 'Extend by one block'}
          busy={busy}
          onPress={() => {
            setBusy(true);
            // One block, as the label says. The API counts BLOCKS; the app once
            // sent the block length in minutes under a field it does not know.
            void api.extend(booking.id, { additionalBlocks: 1 }).then(async (result) => {
              setBusy(false);
              if (!result.ok) setError(result.error.message);
              else await load();
            });
          }}
        />
      ) : null}

      {view.actions.pay ? (
        <Button
          testID="go-to-checkout"
          label={`Pay ${formatBirr(booking.amountDueSantim ?? 0)}`}
          onPress={() => {
            router.push(`/checkout/${booking.id}`);
          }}
        />
      ) : null}

      {view.actions.cancel ? (
        <Button
          testID="cancel-booking"
          label="Cancel booking"
          tone="danger"
          busy={busy}
          onPress={() => {
            setBusy(true);
            void api.cancel(booking.id).then(async (result) => {
              setBusy(false);
              if (!result.ok) setError(result.error.message);
              else {
                await load();
                router.replace('/');
              }
            });
          }}
        />
      ) : null}

      {error ? <Notice tone="error" message={error} testID="booking-error" /> : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 20, gap: 14 },
  qr: { alignItems: 'center', padding: 16, backgroundColor: 'white', borderRadius: 12 },
});
