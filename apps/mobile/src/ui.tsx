import { ActivityIndicator, Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from './theme.js';

/**
 * Bottom padding that keeps a screen's last control clear of the system
 * navigation bar: `base`, the screen's own spacing, plus the inset.
 *
 * Android 16 makes edge-to-edge mandatory, so every screen draws BEHIND the
 * navigation bar, and nothing did anything about it: the device test found
 * Home's Refresh button under the bar. Every screen uses this
 * (layout.test.ts checks), and the insets come from the SafeAreaProvider
 * expo-router already mounts — which only works because the app and
 * expo-router resolve the same copy of react-native-safe-area-context
 * (resolution.test.ts checks).
 */
export function useBottomInset(base: number): number {
  return base + useSafeAreaInsets().bottom;
}

/**
 * The handful of primitives every screen uses.
 *
 * Touch targets are at least 48dp and primary actions considerably larger:
 * this is used one-handed, outdoors, often in a hurry, sometimes in the rain.
 */

export function Button({
  label,
  onPress,
  tone = 'accent',
  busy = false,
  disabled = false,
  testID,
}: {
  label: string;
  onPress: () => void;
  tone?: 'accent' | 'plain' | 'danger';
  busy?: boolean;
  disabled?: boolean;
  testID?: string;
}): React.JSX.Element {
  const theme = useTheme();
  const background =
    tone === 'accent' ? theme.accent : tone === 'danger' ? theme.danger : 'transparent';
  const color = tone === 'plain' ? theme.text : theme.accentInk;

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled || busy, busy }}
      onPress={onPress}
      disabled={disabled || busy}
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor: background,
          borderColor: tone === 'plain' ? theme.line : background,
          opacity: disabled ? 0.5 : pressed ? 0.85 : 1,
        },
      ]}
    >
      {busy ? (
        <ActivityIndicator color={color} />
      ) : (
        <Text style={[styles.buttonLabel, { color }]}>{label}</Text>
      )}
    </Pressable>
  );
}

export function Card({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: ViewStyle;
}): React.JSX.Element {
  const theme = useTheme();
  return (
    <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.line }, style]}>
      {children}
    </View>
  );
}

export function Title({
  children,
  testID,
}: {
  children: React.ReactNode;
  testID?: string;
}): React.JSX.Element {
  const theme = useTheme();
  return (
    <Text testID={testID} style={[styles.title, { color: theme.text }]}>
      {children}
    </Text>
  );
}

export function Body({
  children,
  muted = false,
}: {
  children: React.ReactNode;
  muted?: boolean;
}): React.JSX.Element {
  const theme = useTheme();
  return <Text style={[styles.body, { color: muted ? theme.muted : theme.text }]}>{children}</Text>;
}

/**
 * A problem the driver can act on.
 *
 * Takes an action, because a message with no way forward is just an apology —
 * and every failure this app shows has a next step (retry, open settings,
 * call the lot).
 */
export function Notice({
  tone,
  message,
  actionLabel,
  onAction,
  testID,
}: {
  tone: 'error' | 'warn' | 'info';
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  testID?: string;
}): React.JSX.Element {
  const theme = useTheme();
  const color = tone === 'error' ? theme.danger : tone === 'warn' ? '#c2410c' : theme.muted;

  return (
    <View
      testID={testID}
      accessibilityRole="alert"
      style={[styles.notice, { borderColor: color, backgroundColor: theme.card }]}
    >
      <Text style={[styles.body, { color }]}>{message}</Text>
      {actionLabel && onAction ? (
        <Pressable onPress={onAction} accessibilityRole="button" style={styles.noticeAction}>
          <Text style={[styles.buttonLabel, { color: theme.accent }]}>{actionLabel}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function Loading({ label }: { label: string }): React.JSX.Element {
  const theme = useTheme();
  return (
    <View style={styles.loading}>
      <ActivityIndicator color={theme.accent} size="large" />
      <Text style={[styles.body, { color: theme.muted, marginTop: 12 }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: 56,
    borderRadius: 14,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  buttonLabel: { fontSize: 17, fontWeight: '800' },
  card: { borderRadius: 16, borderWidth: 1, padding: 16, gap: 8 },
  title: { fontSize: 22, fontWeight: '800' },
  body: { fontSize: 15, fontWeight: '600' },
  notice: { borderRadius: 12, borderWidth: 2, padding: 12, gap: 8 },
  noticeAction: { minHeight: 44, justifyContent: 'center' },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
});
