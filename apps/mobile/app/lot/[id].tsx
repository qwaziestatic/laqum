import { formatBirr } from '@laqum/shared';
import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Linking, ScrollView, StyleSheet } from 'react-native';
import type { NearbyLot } from '../../src/api/endpoints.js';
import { useApp } from '../../src/state/app.js';
import { Body, Button, Card, Loading, Notice, Title } from '../../src/ui.js';

/** Rates, live free count, and a call button — per the brief. */
export default function LotDetail(): React.JSX.Element {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { api, foregroundEpoch } = useApp();
  const [lot, setLot] = useState<NearbyLot | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    const result = await api.lot(id);
    if (result.ok) setLot(result.data);
    else setError(result.error.message);
  }, [api, id]);

  useEffect(() => {
    void load();
  }, [load, foregroundEpoch]);

  if (error)
    return <Notice tone="error" message={error} actionLabel="Retry" onAction={() => void load()} />;
  if (!lot) return <Loading label="Loading lot…" />;

  const full = lot.freeSlots === 0;

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Title>{lot.name}</Title>
      {lot.address ? <Body muted>{lot.address}</Body> : null}

      <Card>
        <Title>{`${String(lot.freeSlots)} free`}</Title>
        <Body muted>{`of ${String(lot.totalAppBookableSlots)} bookable slots`}</Body>
      </Card>

      <Card>
        <Body>{`${formatBirr(lot.ratePerBlockSantim)} per ${String(lot.blockMinutes)} minutes`}</Body>
        <Body
          muted
        >{`Overstay ${formatBirr(lot.overstayRatePerBlockSantim)} per ${String(lot.blockMinutes)} minutes`}</Body>
        {lot.depositAmountSantim > 0 ? (
          <Body
            muted
          >{`Deposit ${formatBirr(lot.depositAmountSantim)}, held for ${String(lot.paymentWindowMinutes)} minutes`}</Body>
        ) : (
          <Body muted>{`No deposit. Slot held for ${String(lot.holdMinutes)} minutes.`}</Body>
        )}
      </Card>

      {full ? (
        <Notice
          tone="warn"
          testID="lot-full"
          message="This lot is full right now. Counts update live — try again in a moment."
        />
      ) : null}

      <Button
        testID="book"
        label={full ? 'Lot full' : 'Book a slot'}
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
        label={`Call the lot · ${lot.contactPhone}`}
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
