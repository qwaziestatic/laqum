import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
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
        }}
      >
        <Stack.Screen name="index" options={{ title: 'ላቁም?' }} />
        <Stack.Screen name="login" options={{ title: 'Sign in', headerBackVisible: false }} />
        <Stack.Screen name="lot/[id]" options={{ title: 'Parking lot' }} />
        <Stack.Screen name="book/[lotId]" options={{ title: 'Book a slot' }} />
        <Stack.Screen name="booking/[id]" options={{ title: 'Your booking' }} />
        <Stack.Screen name="checkout/[id]" options={{ title: 'Pay' }} />
      </Stack>
    </>
  );
}
