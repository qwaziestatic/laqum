import { formatBirr } from '@laqum/shared';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';
import MapView, { Marker, PROVIDER_GOOGLE } from 'react-native-maps';
import type { NearbyLot } from '../src/api/endpoints.js';
import { getFix, type LocationResult } from '../src/location/useLocation.js';
import { useApp } from '../src/state/app.js';
import { useTheme } from '../src/theme.js';
import { Body, Button, Card, Loading, Notice, Title } from '../src/ui.js';

/**
 * Map home: pins with free counts, and a list sorted by distance.
 *
 * Location is needed to sort and to show the map, but a driver who refuses it
 * still gets the lot LIST — refusing to show anything would be a worse app
 * than one that asks again later.
 */
export default function Home(): React.JSX.Element {
  const theme = useTheme();
  const { api, session, ready, foregroundEpoch } = useApp();

  const [lots, setLots] = useState<NearbyLot[] | null>(null);
  const [location, setLocation] = useState<LocationResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeBookingId, setActiveBookingId] = useState<string | null>(null);

  // Signed out? Go to login. Waits for `ready` so a restored session is not
  // beaten to the redirect.
  useEffect(() => {
    if (ready && !session) router.replace('/login');
  }, [ready, session]);

  const load = useCallback(async () => {
    setError(null);
    const fix = await getFix();
    setLocation(fix);

    if (fix.kind !== 'fix') {
      // No position: fall back to the city centre so the driver still sees
      // lots and can browse. Distances will be wrong until they allow it,
      // and the banner says so.
      const result = await api.nearbyLots(9.0192, 38.7525, 10_000);
      if (result.ok) setLots(result.data.lots);
      else setError(result.error.message);
      return;
    }

    const result = await api.nearbyLots(fix.fix.latitude, fix.fix.longitude);
    if (result.ok) setLots(result.data.lots);
    else setError(result.error.message);
  }, [api]);

  // On focus AND on return to the foreground: free counts go stale fast.
  useFocusEffect(
    useCallback(() => {
      void load();
      void api.currentBooking().then((result) => {
        if (result.ok) setActiveBookingId(result.data.booking?.id ?? null);
      });
    }, [load, api]),
  );

  useEffect(() => {
    if (foregroundEpoch > 0) void load();
  }, [foregroundEpoch, load]);

  if (!ready || lots === null) return <Loading label="Finding parking near you…" />;

  const fix = location?.kind === 'fix' ? location.fix : null;

  return (
    <View style={styles.flex}>
      {activeBookingId ? (
        <Notice
          tone="info"
          message="You have an active booking."
          actionLabel="Open it"
          onAction={() => {
            router.push(`/booking/${activeBookingId}`);
          }}
          testID="active-booking-banner"
        />
      ) : null}

      {location && location.kind !== 'fix' ? (
        <Notice
          tone="warn"
          testID="location-warning"
          message={
            location.kind === 'services_off'
              ? 'Location is switched off, so distances are estimated. Turn it on to book.'
              : location.kind === 'permission_denied'
                ? 'Laqum needs your location to confirm you are close enough to a lot.'
                : 'Your location could not be found, so distances are estimated.'
          }
          actionLabel="Try again"
          onAction={() => void load()}
        />
      ) : null}

      {error ? <Notice tone="error" message={error} testID="home-error" /> : null}

      <MapView
        testID="map"
        provider={PROVIDER_GOOGLE}
        style={styles.map}
        showsUserLocation={fix !== null}
        initialRegion={{
          latitude: fix?.latitude ?? 9.0192,
          longitude: fix?.longitude ?? 38.7525,
          latitudeDelta: 0.05,
          longitudeDelta: 0.05,
        }}
      >
        {lots.map((lot) => (
          <Marker
            key={lot.id}
            coordinate={{ latitude: lot.latitude, longitude: lot.longitude }}
            title={lot.name}
            // The count is the whole reason to look at the map.
            description={`${String(lot.freeSlots)} free`}
            onCalloutPress={() => {
              router.push(`/lot/${lot.id}`);
            }}
          />
        ))}
      </MapView>

      <FlatList
        style={[styles.sheet, { backgroundColor: theme.card, borderColor: theme.line }]}
        data={lots}
        keyExtractor={(lot) => lot.id}
        ListHeaderComponent={<Title>Nearby lots</Title>}
        contentContainerStyle={styles.sheetContent}
        ListEmptyComponent={<Body muted>No lots within range.</Body>}
        renderItem={({ item }) => (
          <Pressable
            testID={`lot-${item.id}`}
            accessibilityRole="button"
            onPress={() => {
              router.push(`/lot/${item.id}`);
            }}
          >
            <Card>
              <Title>{item.name}</Title>
              <Body muted>
                {`${String(item.freeSlots)} of ${String(item.totalAppBookableSlots)} free · ${formatBirr(item.ratePerBlockSantim)} per ${String(item.blockMinutes)} min`}
              </Body>
              <Body muted>
                {fix
                  ? `${String(Math.round(item.distanceM))} m away`
                  : 'Distance needs your location'}
              </Body>
            </Card>
          </Pressable>
        )}
      />

      <View style={styles.actions}>
        <Button label="Refresh" tone="plain" onPress={() => void load()} testID="refresh" />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  map: { flex: 1, minHeight: 180 },
  sheet: { flex: 1.2, borderTopWidth: 2, borderTopLeftRadius: 20, borderTopRightRadius: 20 },
  sheetContent: { padding: 16, gap: 12 },
  actions: { padding: 16 },
});
