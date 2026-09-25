import type { Locale } from '@laqum/shared';
import { Pressable, StyleSheet, Text } from 'react-native';
import { useTheme } from '../theme.js';
import { chooseLanguage, useT } from './react.js';

/**
 * The language switch, in every screen's header.
 *
 * It offers the OTHER language, named in that language ("English" on an
 * Amharic screen, "አማርኛ" on an English one), so whoever needs it can read
 * it. The choice is remembered over the phone's language (i18n/react.tsx).
 */
export function LanguageSwitch(): React.JSX.Element {
  const t = useT();
  const theme = useTheme();
  const other: Locale = t.language === 'am' ? 'en' : 'am';
  const name = t(`language.${other}`);

  return (
    <Pressable
      testID="language-switch"
      accessibilityRole="button"
      accessibilityLabel={t('language.switchTo', { language: name })}
      hitSlop={10}
      onPress={() => void chooseLanguage(other)}
      style={styles.switch}
    >
      <Text style={[styles.label, { color: theme.accent }]}>{name}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  switch: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 8 },
  label: { fontSize: 15, fontWeight: '800' },
});
