import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { LanguageSwitch } from '../src/i18n/LanguageSwitch.js';
import { useT } from '../src/i18n/react.js';
import { Intro } from '../src/intro/Intro.js';
import { AppProvider, useApp } from '../src/state/app.js';
import { useTheme } from '../src/theme.js';

/**
 * The root. One AppProvider for the whole tree — see state/app.tsx for why
 * that matters to the refresh.
 */
export default function RootLayout(): React.JSX.Element {
  return (
    <AppProvider>
      <Shell />
    </AppProvider>
  );
}

function Shell(): React.JSX.Element {
  const theme = useTheme();
  const t = useT();
  const { ready } = useApp();

  return (
    <>
      <StatusBar style={theme.scheme === 'dark' ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: theme.card },
          headerTintColor: theme.text,
          contentStyle: { backgroundColor: theme.bg },
          // Nothing renders until the persisted session is known, or the app
          // would flash the login screen at an already-signed-in driver.
          animation: ready ? 'default' : 'none',
          // On every screen, sign-in included: a driver who cannot read the
          // current language must be able to leave it from anywhere.
          headerRight: () => <LanguageSwitch />,
        }}
      >
        <Stack.Screen name="index" options={{ title: t('app.name') }} />
        <Stack.Screen name="login" options={{ title: t('nav.signIn'), headerBackVisible: false }} />
        <Stack.Screen name="lot/[id]" options={{ title: t('nav.lot') }} />
        <Stack.Screen name="book/[lotId]" options={{ title: t('nav.book') }} />
        <Stack.Screen name="booking/[id]" options={{ title: t('nav.booking') }} />
        <Stack.Screen name="checkout/[id]" options={{ title: t('nav.checkout') }} />
      </Stack>
      {/* Over everything, on a cold start only, while the session restores. */}
      <Intro ready={ready} />
    </>
  );
}
