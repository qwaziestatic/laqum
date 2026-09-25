import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Linking, ScrollView, StyleSheet } from 'react-native';
import type { ApiError } from '../../src/api/client.js';
import type { LotSummary } from '../../src/api/endpoints.js';
import { errorPhrase } from '../../src/api/messages.js';
import { verbatim } from '../../src/i18n/core.js';
import { useT } from '../../src/i18n/react.js';
import { useApp } from '../../src/state/app.js';
import { Body, Button, Card, Loading, Notice, Title, useBottomInset } from '../../src/ui.js';

/** Rates, live free count, and a call button — per the brief. */
export default function LotDetail(): React.JSX.Element {
  const { id } = useLocalSearchParams<{ id: string }>();
  const t = useT();
  const { api, foregroundEpoch } = useApp();
  const bottomInset = useBottomInset(20);
  const [lot, setLot] = useState<LotSummary | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    const result = await api.lot(id);
    if (result.ok) setLot(result.data);
    else setError(result.error);
  }, [api, id]);

  useEffect(() => {
    void load();
  }, [load, foregroundEpoch]);

  if (error)
    return (
      <Notice
        tone="error"
        message={t.phrase(errorPhrase(error))}
        actionLabel={t('common.retry')}
        onAction={() => void load()}
      />
    );
  if (!lot) return <Loading label={t('lot.loading')} />;

  const full = lot.freeSlots === 0;

  return (
    <ScrollView contentContainerStyle={[styles.content, { paddingBottom: bottomInset }]}>
      <Title>{verbatim(lot.name)}</Title>
      {lot.address ? <Body muted>{verbatim(lot.address)}</Body> : null}

      <Card>
        <Title>{t('lot.free', { count: lot.freeSlots })}</Title>
        <Body muted>{t('lot.bookable', { total: lot.totalAppBookableSlots })}</Body>
      </Card>

      <Card>
        <Body>
          {t('lot.rate', { rate: t.money(lot.ratePerBlockSantim), minutes: lot.blockMinutes })}
        </Body>
        <Body muted>
          {t('lot.overstayRate', {
            rate: t.money(lot.overstayRatePerBlockSantim),
            minutes: lot.blockMinutes,
          })}
        </Body>
        {lot.depositAmountSantim > 0 ? (
          <Body muted>
            {t('lot.deposit', {
              amount: t.money(lot.depositAmountSantim),
              minutes: lot.paymentWindowMinutes,
            })}
          </Body>
        ) : (
          <Body muted>{t('lot.noDeposit', { minutes: lot.holdMinutes })}</Body>
        )}
      </Card>

      {full ? <Notice tone="warn" testID="lot-full" message={t('lot.full')} /> : null}

      <Button
        testID="book"
        label={full ? t('lot.fullButton') : t('lot.book')}
        disabled={full}
        onPress={() => {
          router.push(`/book/${lot.id}`);
        }}
      />

      {/*
       * A phone call is the escape hatch for everything this app cannot do:
       * a blocked entrance, a barrier that will not lift, a dispute. It is a
       * first-class button, not a footnote.
       */}
      <Button
        testID="call-lot"
        label={t('lot.call', { phone: lot.contactPhone })}
        tone="plain"
        onPress={() => {
          void Linking.openURL(`tel:${lot.contactPhone}`);
        }}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 20, gap: 14 },
});
