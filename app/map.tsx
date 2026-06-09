import { useEffect, useRef } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { useAuth } from '@clerk/clerk-expo';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useQuery } from 'convex/react';
import MapView, { Callout, Marker, PROVIDER_DEFAULT, Region } from 'react-native-maps';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BottomNav, BOTTOM_NAV_HEIGHT } from '@/components/BottomNav';
import { api } from '@/convex/_generated/api';

const CONVEX_URL = process.env.EXPO_PUBLIC_CONVEX_URL;

const EUROPE_REGION: Region = {
  latitude: 50.5,
  longitude: 10,
  latitudeDelta: 28,
  longitudeDelta: 36,
};

function formatDuration(durationMillis: number) {
  const totalSeconds = Math.max(0, Math.floor(durationMillis / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = (totalSeconds % 60).toString().padStart(2, '0');

  return `${minutes}:${seconds}`;
}

function formatDate(timestamp: number) {
  return new Date(timestamp).toLocaleDateString([], {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

function LoadingScreen({ title }: { title: string }) {
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.safeArea, { paddingTop: insets.top }]}>
      <StatusBar style="light" />
      <View style={styles.centeredScreen}>
        <ActivityIndicator size="small" color="#38BDF8" />
        <Text style={styles.loadingText}>{title}</Text>
      </View>
      <BottomNav />
    </View>
  );
}

function MissingConvexConfig() {
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.safeArea, { paddingTop: insets.top }]}>
      <StatusBar style="light" />
      <View style={styles.centeredScreen}>
        <View style={styles.emptyIcon}>
          <Ionicons name="cloud-offline-outline" size={34} color="#38BDF8" />
        </View>
        <Text style={styles.emptyTitle}>Map unavailable</Text>
        <Text style={styles.emptyText}>Add EXPO_PUBLIC_CONVEX_URL to .env, then restart Expo.</Text>
      </View>
      <BottomNav />
    </View>
  );
}

export default function DatasetMapScreen() {
  const insets = useSafeAreaInsets();
  const { isLoaded, userId } = useAuth();
  const mapRef = useRef<MapView>(null);
  const mapSessions = useQuery(api.dataset.listMapSessions, isLoaded && userId ? {} : 'skip');

  useEffect(() => {
    if (isLoaded && !userId) {
      router.replace('/account');
    }
  }, [isLoaded, userId]);

  useEffect(() => {
    if (!mapSessions || mapSessions.length === 0) {
      return;
    }

    const timeout = setTimeout(() => {
      if (mapSessions.length === 1) {
        const session = mapSessions[0];
        mapRef.current?.animateToRegion(
          {
            latitude: session.latitude,
            longitude: session.longitude,
            latitudeDelta: 0.08,
            longitudeDelta: 0.08,
          },
          700,
        );
        return;
      }

      mapRef.current?.fitToCoordinates(
        mapSessions.map((session) => ({
          latitude: session.latitude,
          longitude: session.longitude,
        })),
        {
          animated: true,
          edgePadding: {
            top: Math.max(insets.top + 130, 170),
            right: 48,
            bottom: BOTTOM_NAV_HEIGHT + Math.max(insets.bottom, 10) + 72,
            left: 48,
          },
        },
      );
    }, 350);

    return () => {
      clearTimeout(timeout);
    };
  }, [insets.bottom, insets.top, mapSessions]);

  if (!CONVEX_URL) {
    return <MissingConvexConfig />;
  }

  if (!isLoaded) {
    return <LoadingScreen title="Checking account" />;
  }

  if (!userId) {
    return <LoadingScreen title="Opening account" />;
  }

  return (
    <View style={styles.safeArea}>
      <StatusBar style="light" />
      <MapView
        ref={mapRef}
        provider={PROVIDER_DEFAULT}
        style={styles.map}
        initialRegion={EUROPE_REGION}
        showsUserLocation={false}
        showsMyLocationButton={false}
      >
        {mapSessions?.map((session) => (
          <Marker
            key={session.id}
            coordinate={{
              latitude: session.latitude,
              longitude: session.longitude,
            }}
            pinColor="#38BDF8"
            title={session.locationName}
          >
            <Callout tooltip={false}>
              <View style={styles.callout}>
                <Text numberOfLines={1} style={styles.calloutTitle}>{session.locationName}</Text>
                <Text style={styles.calloutText}>{formatDate(session.createdAt)}</Text>
                <Text style={styles.calloutText}>Duration {formatDuration(session.durationMillis)}</Text>
              </View>
            </Callout>
          </Marker>
        ))}
      </MapView>

      <View pointerEvents="none" style={[styles.headerOverlay, { top: insets.top + 14 }]}>
        <Text style={styles.heading}>Dataset map</Text>
        <Text style={styles.subtitle}>
          {mapSessions ? `${mapSessions.length} collection point${mapSessions.length === 1 ? '' : 's'}` : 'Loading collection points'}
        </Text>
      </View>

      {mapSessions === undefined ? (
        <View style={styles.statusCard}>
          <ActivityIndicator size="small" color="#38BDF8" />
          <Text style={styles.statusText}>Loading map points</Text>
        </View>
      ) : mapSessions.length === 0 ? (
        <View style={styles.statusCard}>
          <Ionicons name="map-outline" size={24} color="#38BDF8" />
          <Text style={styles.statusTitle}>No collection locations yet</Text>
          <Text style={styles.statusText}>Uploaded sessions with location data will appear here.</Text>
        </View>
      ) : null}

      <View pointerEvents="none" style={[styles.privacyBadge, { bottom: BOTTOM_NAV_HEIGHT + Math.max(insets.bottom, 10) + 12 }]}>
        <Ionicons name="shield-checkmark-outline" size={14} color="#BAE6FD" />
        <Text style={styles.privacyText}>Locations are rounded for privacy</Text>
      </View>

      <BottomNav />
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#05060A',
  },
  map: {
    flex: 1,
  },
  centeredScreen: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 28,
    paddingBottom: BOTTOM_NAV_HEIGHT,
    gap: 12,
  },
  loadingText: {
    color: '#CBD5E1',
    fontSize: 14,
    fontWeight: '700',
  },
  headerOverlay: {
    position: 'absolute',
    left: 18,
    right: 18,
    borderRadius: 24,
    backgroundColor: 'rgba(5, 6, 10, 0.82)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    padding: 18,
  },
  heading: {
    color: '#F8FAFC',
    fontSize: 26,
    fontWeight: '900',
    letterSpacing: 0.2,
  },
  subtitle: {
    color: '#94A3B8',
    fontSize: 13,
    fontWeight: '700',
    marginTop: 4,
  },
  statusCard: {
    position: 'absolute',
    left: 24,
    right: 24,
    top: '42%',
    borderRadius: 22,
    backgroundColor: 'rgba(11, 18, 32, 0.94)',
    borderWidth: 1,
    borderColor: 'rgba(56, 189, 248, 0.22)',
    padding: 18,
    alignItems: 'center',
    gap: 8,
  },
  statusTitle: {
    color: '#F8FAFC',
    fontSize: 17,
    fontWeight: '900',
    textAlign: 'center',
  },
  statusText: {
    color: '#94A3B8',
    fontSize: 13,
    fontWeight: '700',
    textAlign: 'center',
    lineHeight: 18,
  },
  privacyBadge: {
    position: 'absolute',
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 999,
    backgroundColor: 'rgba(5, 6, 10, 0.82)',
    borderWidth: 1,
    borderColor: 'rgba(56, 189, 248, 0.18)',
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  privacyText: {
    color: '#BAE6FD',
    fontSize: 11,
    fontWeight: '800',
  },
  callout: {
    width: 190,
    padding: 4,
    gap: 4,
  },
  calloutTitle: {
    color: '#0F172A',
    fontSize: 15,
    fontWeight: '900',
  },
  calloutText: {
    color: '#334155',
    fontSize: 12,
    fontWeight: '700',
  },
  emptyIcon: {
    width: 74,
    height: 74,
    borderRadius: 37,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(56, 189, 248, 0.12)',
    borderWidth: 1,
    borderColor: 'rgba(56, 189, 248, 0.24)',
  },
  emptyTitle: {
    color: '#F8FAFC',
    fontSize: 20,
    fontWeight: '900',
    textAlign: 'center',
  },
  emptyText: {
    color: '#94A3B8',
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
  },
});
