import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import type { LotSummary } from '../../src/api/endpoints.js';
import { errorPhrase } from '../../src/api/messages.js';
import {
  DEPOSIT_NOT_STARTED,
  DEPOSIT_NOT_STARTED_PARAM,
  type DepositNotice,
  depositAttempt,
  depositNoticeAfter,
} from '../../src/booking/deposit.js';
import { bookingView } from '../../src/booking/view.js';
import { type Phrase, verbatim } from '../../src/i18n/core.js';
import { useT } from '../../src/i18n/react.js';
import { navigateTo } from '../../src/nav/mapsLink.js';
import { bookingEarnsPushAsk, maybeRegisterForPush } from '../../src/push/registration.js';
import { pushDeps } from '../../src/push/expoDeps.js';
import { useLiveBooking } from '../../src/realtime/useLiveBooking.js';
import { useApp } from '../../src/state/app.js';
import { formatRemaining } from '../../src/time/serverClock.js';
import { Body, Button, Card, Loading, Notice, Title, useBottomInset } from '../../src/ui.js';

/**
 * The booking, in whichever state it is in.
 *
 * PENDING_PAYMENT → the time left to pay, and Pay deposit.
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
  const { id, deposit } = useLocalSearchParams<{ id: string; deposit?: string }>();
  const t = useT();
  const { api, client } = useApp();
  const bottomInset = useBottomInset(20);

  /*
   * The booking, kept current by pushed changes; refetched on entry, on
   * foreground and on every reconnect; polled only while the socket is down.
   * A pending deposit is verified on entry and on return from the checkout.
   * All of it: src/realtime/useLiveBooking.ts.
   */
  const { booking, error: loadError, reload: load } = useLiveBooking(id);
  const [lot, setLot] = useState<LotSummary | null>(null);
  const [actionError, setError] = useState<Phrase | null>(null);
  const error = actionError ?? (loadError ? errorPhrase(loadError) : null);
  const [busy, setBusy] = useState(false);
  const [coordinates, setCoordinates] = useState<string | null>(null);
  // ONE deposit notice: "not started" from the Book screen, replaced by a
  // retry's outcome, never stacked under it (src/booking/deposit.ts).
  const [depositNotice, setDepositNotice] = useState<DepositNotice | null>(
    deposit === DEPOSIT_NOT_STARTED_PARAM ? DEPOSIT_NOT_STARTED : null,
  );
  const [tick, setTick] = useState(0);
  const askedForPush = useRef(false);

  // A booking never changes lot, so the lot is read once per booking.
  const lotId = booking?.lotId;
  useEffect(() => {
    if (!lotId) return;
    void api.lot(lotId).then((result) => {
      if (result.ok) setLot(result.data);
    });
  }, [api, lotId]);

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

  /*
   * THE PUSH ASK, once the driver holds a slot — never at launch, and never
   * while paying the deposit. See push/registration.ts for why the timing is
   * the whole design. "Too early" is not final: the booking may reach a held
   * slot while this screen is open (the deposit confirms), so it asks then.
   */
  const status = booking?.status;
  useEffect(() => {
    if (!status || askedForPush.current) return;
    askedForPush.current = true;
    void maybeRegisterForPush(pushDeps(api, bookingEarnsPushAsk(status))).then((outcome) => {
      if (outcome.kind === 'too_early') askedForPush.current = false;
    });
  }, [status, api]);

  if (error && !booking) {
    return (
      <Notice
        tone="error"
        message={t.phrase(error)}
        actionLabel={t('common.retry')}
        onAction={() => void load()}
      />
    );
  }
  if (!booking) return <Loading label={t('booking.loading')} />;

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
      <Title>{lot ? verbatim(lot.name) : t('booking.titleFallback')}</Title>
      <Body muted>{t(view.sentence)}</Body>

      {!client.clock.synced ? (
        <Notice tone="info" testID="clock-unsynced" message={t('booking.clockUnsynced')} />
      ) : null}

      {view.timer && timerMs !== null ? (
        <Card>
          <Body muted>{t(view.timer.label)}</Body>
          <Title>{verbatim(formatRemaining(timerMs))}</Title>
          {/* A countdown at zero on a LIVE status: the server has yet to move it
              on (expire, overstay). A finished booking has no card at all. */}
          {view.timer.counts === 'down' && timerMs === 0 ? (
            <Body muted>{t('booking.checking')}</Body>
          ) : null}
        </Card>
      ) : null}

      {booking.status === 'OVERSTAY' ? (
        <Notice tone="error" testID="overstay-notice" message={t('booking.overstay')} />
      ) : null}

      {view.actions.payDeposit && depositNotice ? (
        <Notice
          tone={depositNotice.tone}
          testID="deposit-notice"
          message={t.phrase(depositNotice.message)}
        />
      ) : null}

      {view.actions.payDeposit ? (
        <Button
          testID="pay-deposit"
          // The amount is the lot's; unknown until the lot loads.
          label={
            lot
              ? t('booking.payDeposit', { amount: t.money(lot.depositAmountSantim) })
              : t('booking.payDepositNoAmount')
          }
          busy={busy}
          onPress={() => {
            setBusy(true);
            void api.payDeposit(booking.id).then(async (result) => {
              setBusy(false);
              const attempt = depositAttempt(result);
              // The outcome REPLACES the deposit notice; it never goes in the
              // screen's general error box, which is how two boxes stacked.
              setDepositNotice((current) => depositNoticeAfter(current, attempt));
              if (attempt.kind === 'notice') return;
              setError(null);
              if (attempt.kind === 'open') {
                // Android resolves as the browser OPENS, iOS as it closes; the
                // foreground refetch covers the return on both.
                await WebBrowser.openBrowserAsync(attempt.checkoutUrl);
              }
              await load({ verify: true });
            });
          }}
        />
      ) : null}

      {view.actions.showQr && booking.qrToken ? (
        <Card>
          <Body muted>{t('booking.showAtGate')}</Body>
          <View style={styles.qr}>
            <QRCode value={booking.qrToken} size={200} backgroundColor="white" />
          </View>
          {booking.shortCode ? (
            <Title testID="short-code">{verbatim(booking.shortCode)}</Title>
          ) : null}
          <Body muted>{t('booking.readCode')}</Body>
        </Card>
      ) : null}

      {view.actions.findAnotherSlot ? (
        <Button
          testID="find-another-slot"
          label={t('booking.findAnother')}
          onPress={() => {
            router.replace('/');
          }}
        />
      ) : null}

      {lot && view.actions.navigate ? (
        <Button
          testID="navigate"
          label={t('booking.navigate')}
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
          message={t('booking.noMapsApp', { coordinates })}
        />
      ) : null}

      {view.actions.extend ? (
        <Button
          testID="extend"
          // One block: its length is the lot's, and unknown until the lot loads.
          label={
            lot ? t('booking.extend', { minutes: lot.blockMinutes }) : t('booking.extendBlock')
          }
          busy={busy}
          onPress={() => {
            setBusy(true);
            // One block, as the label says. The API counts BLOCKS; the app once
            // sent the block length in minutes under a field it does not know.
            void api.extend(booking.id, { additionalBlocks: 1 }).then(async (result) => {
              setBusy(false);
              if (!result.ok) setError(errorPhrase(result.error));
              else await load();
            });
          }}
        />
      ) : null}

      {view.actions.pay ? (
        <Button
          testID="go-to-checkout"
          label={t('booking.pay', { amount: t.money(booking.amountDueSantim ?? 0) })}
          onPress={() => {
            router.push(`/checkout/${booking.id}`);
          }}
        />
      ) : null}

      {view.actions.cancel ? (
        <Button
          testID="cancel-booking"
          label={t('booking.cancel')}
          tone="danger"
          busy={busy}
          onPress={() => {
            setBusy(true);
            void api.cancel(booking.id).then(async (result) => {
              setBusy(false);
              if (!result.ok) setError(errorPhrase(result.error));
              else {
                await load();
                router.replace('/');
              }
            });
          }}
        />
      ) : null}

      {error ? <Notice tone="error" message={t.phrase(error)} testID="booking-error" /> : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 20, gap: 14 },
  qr: { alignItems: 'center', padding: 16, backgroundColor: 'white', borderRadius: 12 },
});
