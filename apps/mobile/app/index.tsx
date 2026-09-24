import { formatBirr } from '@laqum/shared';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { Camera, Map, Marker, UserLocation } from '@maplibre/maplibre-react-native';
import type { NearbyLot } from '../src/api/endpoints.js';
import { MapAttribution } from '../src/map/Attribution.js';
import { mapStyleFor } from '../src/map/tiles.js';
import { getFix, type LocationResult, type PermissionPrompt } from '../src/location/useLocation.js';
import { useApp } from '../src/state/app.js';
import { useTheme } from '../src/theme.js';
import { Body, Button, Card, Loading, Notice, Title, useBottomInset } from '../src/ui.js';

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
  // The Refresh bar is the last thing on screen; without this it sat under
  // Android's navigation bar.
  const bottomInset = useBottomInset(16);

  const [lots, setLots] = useState<NearbyLot[] | null>(null);
  const [location, setLocation] = useState<LocationResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeBookingId, setActiveBookingId] = useState<string | null>(null);

  // Signed out? Go to login. Waits for `ready` so a restored session is not
  // beaten to the redirect.
  useEffect(() => {
    if (ready && !session) router.replace('/login');
  }, [ready, session]);

  // `prompt`: see PermissionPrompt. Automatic reloads must never re-ask: on
  // Android every ask pauses and resumes the activity, which is itself a
  // "return to the foreground" and would reload, and ask, again.
  const load = useCallback(
    async (prompt: PermissionPrompt) => {
      setError(null);
      const fix = await getFix(prompt);
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
    },
    [api],
  );

  // On focus AND on return to the foreground: free counts go stale fast.
  useFocusEffect(
    useCallback(() => {
      void load('first-time');
      void api.currentBooking().then((result) => {
        if (result.ok) setActiveBookingId(result.data.booking?.id ?? null);
      });
    }, [load, api]),
  );

  useEffect(() => {
    if (foregroundEpoch > 0) void load('first-time');
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
          onAction={() => void load('on-tap')}
        />
      ) : null}

      {error ? <Notice tone="error" message={error} testID="home-error" /> : null}

      {/*
       * MapLibre over OpenFreeMap — no API key, no account, no card.
       * See src/map/tiles.ts for the terms and the attribution obligation.
       *
       * Tiles need INTERNET, unlike the rest of the app, which only needs to
       * reach the LAN API. A phone on Wi-Fi with no WAN gets a working lot
       * list and a blank map, which is why the list is never gated on this.
       */}
      <View style={styles.map}>
        <Map
          testID="map"
          style={StyleSheet.absoluteFill}
          mapStyle={mapStyleFor(theme.scheme)}
          // MapLibre's own ornament is an attribution BUTTON that opens a
          // dialog; the visible credit is MapAttribution below. Both are on.
          attribution
          logo={false}
          compass
        >
          <Camera
            initialViewState={{
              center: [fix?.longitude ?? 38.7525, fix?.latitude ?? 9.0192],
              zoom: 13,
            }}
          />

          {fix ? <UserLocation /> : null}

          {lots.map((lot) => (
            <Marker
              key={lot.id}
              id={lot.id}
              // LngLat is [longitude, latitude] — the opposite order to the
              // API's {latitude, longitude}, and a silent bug if swapped.
              lngLat={[lot.longitude, lot.latitude]}
              onPress={() => {
                router.push(`/lot/${lot.id}`);
              }}
            >
              <View
                testID={`pin-${lot.id}`}
                style={[
                  styles.pin,
                  {
                    backgroundColor: lot.freeSlots > 0 ? theme.ok : theme.danger,
                    borderColor: theme.card,
                  },
                ]}
              >
                {/* The count is the whole reason to look at the map. */}
                <Text style={styles.pinText}>{String(lot.freeSlots)}</Text>
              </View>
            </Marker>
          ))}
        </Map>
      </View>

      <MapAttribution />

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

      <View style={[styles.actions, { paddingBottom: bottomInset }]}>
        <Button label="Refresh" tone="plain" onPress={() => void load('on-tap')} testID="refresh" />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  map: { flex: 1, minHeight: 180 },
  pin: {
    minWidth: 34,
    height: 34,
    borderRadius: 17,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  pinText: { color: '#ffffff', fontSize: 14, fontWeight: '800' },
  sheet: { flex: 1.2, borderTopWidth: 2, borderTopLeftRadius: 20, borderTopRightRadius: 20 },
  sheetContent: { padding: 16, gap: 12 },
  actions: { padding: 16 },
});
