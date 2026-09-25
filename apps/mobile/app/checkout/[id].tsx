import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { errorPhrase } from '../../src/api/messages.js';
import type { Phrase } from '../../src/i18n/core.js';
import { clockTime, useT } from '../../src/i18n/react.js';
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
  const t = useT();
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
  const [actionError, setError] = useState<Phrase | null>(null);
  const error = actionError ?? (loadError ? errorPhrase(loadError) : null);
  const [busy, setBusy] = useState(false);

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
  if (!booking) return <Loading label={t('checkout.loading')} />;

  if (booking.status === 'PAID') {
    return (
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: bottomInset }]}>
        <Title>{t('checkout.paidTitle')}</Title>
        <Body muted>{t('checkout.paidBody')}</Body>
        <Button
          testID="done"
          label={t('checkout.done')}
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
      <Title>{t('checkout.amountDue')}</Title>

      <Card>
        <Title testID="amount-due">{t.money(due)}</Title>
        {booking.checkedInAt ? (
          <Body muted>
            {t('checkout.parkedFrom', { time: clockTime(new Date(booking.checkedInAt)) })}
          </Body>
        ) : null}
        {booking.plannedEndAt ? (
          <Body muted>
            {t('checkout.bookedUntil', { time: clockTime(new Date(booking.plannedEndAt)) })}
          </Body>
        ) : null}
      </Card>

      <Notice tone="info" message={t('checkout.cashHint')} />

      {error ? <Notice tone="error" message={t.phrase(error)} testID="checkout-error" /> : null}

      <Button
        testID="pay"
        label={t('checkout.pay', { amount: t.money(due) })}
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
              setError(errorPhrase(result.error));
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
