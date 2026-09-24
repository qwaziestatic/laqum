import { phoneSchema } from '@laqum/shared';
import { router } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, TextInput } from 'react-native';
import { useApp } from '../src/state/app.js';
import { useTheme } from '../src/theme.js';
import { Body, Button, Notice, Title, useBottomInset } from '../src/ui.js';

/**
 * Phone, then OTP. Two steps in one screen so the driver never loses the
 * number they typed by navigating.
 */
export default function Login(): React.JSX.Element {
  const theme = useTheme();
  const { api, setSession, signedOutReason } = useApp();
  const bottomInset = useBottomInset(24);

  const [phone, setPhone] = useState('+251');
  const [code, setCode] = useState('');
  const [stage, setStage] = useState<'phone' | 'code'>('phone');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const phoneValid = phoneSchema.safeParse(phone).success;

  async function sendCode(): Promise<void> {
    setBusy(true);
    setError(null);
    const result = await api.requestOtp({ phone: phone.trim() });
    setBusy(false);
    if (result.ok) setStage('code');
    // The server never says whether the number is registered, so neither do
    // we — the message is about delivery, not about the account.
    else setError(result.error.message);
  }

  async function verify(): Promise<void> {
    setBusy(true);
    setError(null);
    const result = await api.verifyOtp({ phone: phone.trim(), code: code.trim() });
    setBusy(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    await setSession(result.data);
    router.replace('/');
  }

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: bottomInset }]}
        keyboardShouldPersistTaps="handled"
      >
        <Title>ላቁም?</Title>
        <Body muted>Find and hold a parking slot in Addis Ababa.</Body>

        {signedOutReason ? (
          <Notice tone="warn" message={signedOutReason} testID="signed-out-notice" />
        ) : null}
        {error ? <Notice tone="error" message={error} testID="login-error" /> : null}

        {stage === 'phone' ? (
          <>
            <TextInput
              testID="phone-input"
              value={phone}
              onChangeText={setPhone}
              keyboardType="phone-pad"
              autoComplete="tel"
              accessibilityLabel="Phone number"
              placeholder="+251911000002"
              placeholderTextColor={theme.muted}
              style={[styles.input, { color: theme.text, borderColor: theme.line }]}
            />
            <Button
              testID="send-code"
              label="Send code"
              busy={busy}
              disabled={!phoneValid}
              onPress={() => void sendCode()}
            />
          </>
        ) : (
          <>
            <Body muted>{`We sent a 6-digit code to ${phone}.`}</Body>
            <TextInput
              testID="code-input"
              value={code}
              onChangeText={setCode}
              keyboardType="number-pad"
              maxLength={6}
              autoComplete="sms-otp"
              accessibilityLabel="Verification code"
              placeholder="000000"
              placeholderTextColor={theme.muted}
              style={[styles.input, styles.code, { color: theme.text, borderColor: theme.line }]}
            />
            <Button
              testID="verify-code"
              label="Sign in"
              busy={busy}
              disabled={code.trim().length !== 6}
              onPress={() => void verify()}
            />
            <Button
              label="Use a different number"
              tone="plain"
              onPress={() => {
                setStage('phone');
                setCode('');
                setError(null);
              }}
            />
          </>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { padding: 24, gap: 16, flexGrow: 1, justifyContent: 'center' },
  input: {
    minHeight: 56,
    borderWidth: 2,
    borderRadius: 14,
    paddingHorizontal: 16,
    fontSize: 18,
    fontWeight: '700',
  },
  code: { textAlign: 'center', letterSpacing: 8, fontSize: 24 },
});
