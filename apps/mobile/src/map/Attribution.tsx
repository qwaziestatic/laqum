import { Linking, StyleSheet, Text } from 'react-native';
import { MAP_ATTRIBUTION, OSM_COPYRIGHT_URL } from './tiles.js';
import { useTheme } from '../theme.js';

/**
 * The map credit. Permanent, visible, and not dismissible.
 *
 * OpenFreeMap requires this attribution and OpenStreetMap's ODbL requires the
 * data credit. Neither is decorative: shipping the map without them would be a
 * licence breach, which is why this is a component with a test rather than a
 * string dropped inline in a screen someone may later restructure.
 *
 * Rendered whenever the map is, including when tiles fail to load — the
 * credit is for the data and the service, not for a successful render.
 */
export function MapAttribution(): React.JSX.Element {
  const theme = useTheme();

  return (
    <Text
      testID="map-attribution"
      accessibilityRole="text"
      style={[styles.text, { color: theme.muted, backgroundColor: theme.card }]}
      onPress={() => {
        void Linking.openURL(OSM_COPYRIGHT_URL);
      }}
    >
      {MAP_ATTRIBUTION}
    </Text>
  );
}

const styles = StyleSheet.create({
  text: {
    fontSize: 11,
    fontWeight: '600',
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
});
