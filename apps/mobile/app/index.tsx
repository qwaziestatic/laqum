import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { Camera, Map, Marker, UserLocation } from '@maplibre/maplibre-react-native';
import type { ApiError } from '../src/api/client.js';
import type { NearbyLot } from '../src/api/endpoints.js';
import { errorPhrase } from '../src/api/messages.js';
import { verbatim } from '../src/i18n/core.js';
import { clockTime, useT } from '../src/i18n/react.js';
import { MapAttribution } from '../src/map/Attribution.js';
import { mapStyleFor } from '../src/map/tiles.js';
import {
  getFixQuickThenFresh,
  type LocationResult,
  type PermissionPrompt,
} from '../src/location/useLocation.js';
import { createLotsLoader } from '../src/home/lotsLoader.js';
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
  const t = useT();
  const { api, session, ready, foregroundEpoch } = useApp();
  // The Refresh bar is the last thing on screen; without this it sat under
  // Android's navigation bar.
  const bottomInset = useBottomInset(16);

  const [lots, setLots] = useState<NearbyLot[] | null>(null);
  const [location, setLocation] = useState<LocationResult | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [activeBookingId, setActiveBookingId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  // Not before the saved session is restored: a request sent without the
  // token comes back 401 and would show as an error instead of lots. On the
  // device the first load started ~35 ms before the restore finished.
  const signedIn = ready && session !== null;

  // Signed out? Go to login. Waits for `ready` so a restored session is not
  // beaten to the redirect.
  useEffect(() => {
    if (ready && !session) router.replace('/login');
  }, [ready, session]);

  /*
   * Lots appear from the platform's LAST-KNOWN position at once, then again
   * for a fresh fix. Measured on the device: the fresh fix took 60 ms, 1.4 s
   * and 17 s on three cold starts, the last-known one under 0.3 s at the
   * same accuracy, and the list used to wait for the fresh one. The loader
   * (src/home/lotsLoader.ts) fetches per report and applies only the newest.
   */
  const loader = useMemo(
    () =>
      createLotsLoader({
        locate: getFixQuickThenFresh,
        // No position: fall back to the city centre so the driver still sees
        // lots and can browse. Distances will be wrong until they allow it,
        // and the banner says so.
        fetchLots: (result) =>
          result.kind === 'fix'
            ? api.nearbyLots(result.fix.latitude, result.fix.longitude)
            : api.nearbyLots(9.0192, 38.7525, 10_000),
        onLocation: setLocation,
        onLots: (next) => {
          setLots(next);
          setUpdatedAt(new Date());
        },
        onError: setError,
      }),
    [api],
  );

  /*
   * `prompt`: see PermissionPrompt. Automatic reloads must never re-ask: on
   * Android every ask pauses and resumes the activity, which is itself a
   * "return to the foreground" and would reload, and ask, again.
   */
  const load = useCallback(
    async (prompt: PermissionPrompt) => {
      setError(null);
      await loader.load(prompt);
    },
    [loader],
  );

  /**
   * A tap on Refresh or Try again. Shows that it is working until the new
   * lots have LANDED: the device test found Refresh gave no feedback, so a
   * driver could not tell a refresh that changed nothing from one that never
   * ran.
   */
  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await load('on-tap');
    } finally {
      setRefreshing(false);
    }
  }, [load]);

  // On focus AND on return to the foreground: free counts go stale fast.
  useFocusEffect(
    useCallback(() => {
      if (!signedIn) return;
      void load('first-time');
      void api.currentBooking().then((result) => {
        if (result.ok) setActiveBookingId(result.data.booking?.id ?? null);
      });
    }, [signedIn, load, api]),
  );

  useEffect(() => {
    if (signedIn && foregroundEpoch > 0) void load('first-time');
  }, [signedIn, foregroundEpoch, load]);

  if (!ready || lots === null) return <Loading label={t('home.finding')} />;

  const fix = location?.kind === 'fix' ? location.fix : null;

  return (
    <View style={styles.flex}>
      {activeBookingId ? (
        <Notice
          tone="info"
          message={t('home.activeBooking')}
          actionLabel={t('home.openBooking')}
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
              ? t('home.locationServicesOff')
              : location.kind === 'permission_denied'
                ? t('home.locationDenied')
                : t('home.locationUnavailable')
          }
          actionLabel={t('common.tryAgain')}
          onAction={() => void refresh()}
        />
      ) : null}

      {error ? (
        <Notice tone="error" message={t.phrase(errorPhrase(error))} testID="home-error" />
      ) : null}

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
        ListHeaderComponent={<Title>{t('home.nearby')}</Title>}
        contentContainerStyle={styles.sheetContent}
        ListEmptyComponent={<Body muted>{t('home.empty')}</Body>}
        renderItem={({ item }) => (
          <Pressable
            testID={`lot-${item.id}`}
            accessibilityRole="button"
            onPress={() => {
              router.push(`/lot/${item.id}`);
            }}
          >
            <Card>
              <Title>{verbatim(item.name)}</Title>
              <Body muted>
                {t('home.lotLine', {
                  free: item.freeSlots,
                  total: item.totalAppBookableSlots,
                  rate: t.money(item.ratePerBlockSantim),
                  minutes: item.blockMinutes,
                })}
              </Body>
              <Body muted>
                {fix
                  ? t('home.distance', { meters: Math.round(item.distanceM) })
                  : t('home.distanceUnknown')}
              </Body>
            </Card>
          </Pressable>
        )}
      />

      <View style={[styles.actions, { paddingBottom: bottomInset }]}>
        {updatedAt ? (
          // With seconds: a refresh inside the same minute must still visibly
          // change something, or the driver cannot tell it ran.
          <Body muted>{t('home.updated', { time: clockTime(updatedAt, true) })}</Body>
        ) : null}
        <Button
          label={refreshing ? t('home.refreshing') : t('home.refresh')}
          tone="plain"
          busy={refreshing}
          onPress={() => void refresh()}
          testID="refresh"
        />
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
