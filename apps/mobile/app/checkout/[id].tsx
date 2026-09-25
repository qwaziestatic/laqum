import { formatBirr } from '@laqum/shared';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { useLiveBooking } from '../../src/realtime/useLiveBooking.js';
import { useApp } from '../../src/state/app.js';
import { Body, Button, Card, Loading, Notice, Title, useBottomInset } from '../../src/ui.js';

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
  const { api } = useApp();
  const bottomInset = useBottomInset(20);

  /*
   * Kept current by pushed changes, and refetched on return from the Chapa
   * browser (src/realtime/useLiveBooking.ts). The webhook may land while the
   * driver is still on Chapa's page, and an attendant may take cash while
   * this screen is open: either way the booking turns PAID here without a
   * tap, rather than leaving a "Pay" button on a settled booking.
   */
  const { booking, error: loadError, reload: load } = useLiveBooking(id);
  const [actionError, setError] = useState<string | null>(null);
  const error = actionError ?? loadError;
  const [busy, setBusy] = useState(false);

  if (error && !booking) {
    return <Notice tone="error" message={error} actionLabel="Retry" onAction={() => void load()} />;
  }
  if (!booking) return <Loading label="Loading your bill…" />;

  if (booking.status === 'PAID') {
    return (
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: bottomInset }]}>
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
    <ScrollView contentContainerStyle={[styles.content, { paddingBottom: bottomInset }]}>
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
