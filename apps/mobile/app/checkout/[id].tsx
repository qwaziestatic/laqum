import { formatBirr } from '@laqum/shared';
import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import type { DriverBooking } from '../../src/api/endpoints.js';
import { useApp } from '../../src/state/app.js';
import { Body, Button, Card, Loading, Notice, Title } from '../../src/ui.js';

/**
 * The itemised bill, and pay.
 *
 * The amount is the SERVER's. It is not recomputed here: the driver must see
 * exactly what they will be charged, and a client-side figure that differs by
 * a santim — through rounding, a clock difference, or a stale rate — is worse
 * than no figure at all.
 */
export default function Checkout(): React.JSX.Element {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { api, foregroundEpoch } = useApp();

  const [booking, setBooking] = useState<DriverBooking | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    const result = await api.booking(id);
    if (result.ok) {
      setBooking(result.data.booking);
      setError(null);
    } else setError(result.error.message);
  }, [api, id]);

  useEffect(() => {
    void load();
  }, [load]);

  /*
   * Refetch on return from the Chapa browser.
   *
   * The webhook may land while the driver is still on Chapa's page, so the
   * booking can already be PAID by the time they come back. Extrapolating
   * would leave a "Pay" button on a settled booking.
   */
  useEffect(() => {
    if (foregroundEpoch > 0) void load();
  }, [foregroundEpoch, load]);

  if (error && !booking) {
    return <Notice tone="error" message={error} actionLabel="Retry" onAction={() => void load()} />;
  }
  if (!booking) return <Loading label="Loading your bill…" />;

  if (booking.status === 'PAID') {
    return (
      <ScrollView contentContainerStyle={styles.content}>
        <Title>Paid</Title>
        <Body muted>Thank you. Your booking is settled.</Body>
        <Button
          testID="done"
          label="Done"
          onPress={() => {
            router.replace('/');
          }}
        />
      </ScrollView>
    );
  }

  const due = booking.amountDueSantim ?? 0;

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Title>Amount due</Title>

      <Card>
        <Title testID="amount-due">{formatBirr(due)}</Title>
        {booking.checkedInAt ? (
          <Body muted>{`Parked from ${new Date(booking.checkedInAt).toLocaleTimeString()}`}</Body>
        ) : null}
        {booking.plannedEndAt ? (
          <Body muted>{`Booked until ${new Date(booking.plannedEndAt).toLocaleTimeString()}`}</Body>
        ) : null}
      </Card>

      <Notice
        tone="info"
        message="You can also pay the attendant in cash. Ask them to record it."
      />

      {error ? <Notice tone="error" message={error} testID="checkout-error" /> : null}

      <Button
        testID="pay"
        label={`Pay ${formatBirr(due)}`}
        busy={busy}
        onPress={() => {
          setBusy(true);
          void api.pay(booking.id).then(async (result) => {
            setBusy(false);
            if (!result.ok) {
              // ALREADY_PAID is the cash race: the attendant took the money
              // while this screen was open. Not an error — just refetch.
              if (result.error.code === 'ALREADY_PAID') {
                await load();
                return;
              }
              setError(result.error.message);
              return;
            }
            await WebBrowser.openBrowserAsync(result.data.checkoutUrl);
            await load();
          });
        }}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 20, gap: 14 },
});
