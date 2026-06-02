import { useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useAuth, useClerk, useUser } from '@clerk/clerk-expo';
import { BottomNav, BOTTOM_NAV_HEIGHT } from '@/components/BottomNav';
import { ContributorAuthGate } from '@/components/ContributorAuthGate';

export default function AccountScreen() {
  const insets = useSafeAreaInsets();
  const { isLoaded, userId } = useAuth();
  const { signOut } = useClerk();
  const { user } = useUser();
  const [isSigningOut, setIsSigningOut] = useState(false);
  const displayName = user?.fullName ?? user?.username ?? 'Contributor';
  const email = user?.primaryEmailAddress?.emailAddress;

  if (isLoaded && !userId) {
    return <ContributorAuthGate />;
  }

  const handleSignOut = async () => {
    if (isSigningOut) {
      return;
    }

    try {
      setIsSigningOut(true);
      await signOut();
    } finally {
      setIsSigningOut(false);
    }
  };

  return (
    <View style={[styles.safeArea, { paddingTop: insets.top }]}> 
      <StatusBar style="light" />
      <View style={[styles.screen, { paddingBottom: BOTTOM_NAV_HEIGHT + Math.max(insets.bottom, 10) + 24 }]}> 
        <Text style={styles.heading}>Account</Text>
        <View style={styles.card}>
          <View style={styles.avatar}>
            <Ionicons name="person-outline" size={34} color="#38BDF8" />
          </View>
          {!isLoaded ? (
            <ActivityIndicator size="small" color="#38BDF8" />
          ) : (
            <>
              <Text numberOfLines={1} style={styles.title}>{displayName}</Text>
              {email ? <Text numberOfLines={1} style={styles.body}>{email}</Text> : null}
              <TouchableOpacity
                activeOpacity={0.86}
                disabled={isSigningOut}
                onPress={handleSignOut}
                style={[styles.signOutButton, isSigningOut && styles.buttonDisabled]}
              >
                {isSigningOut ? (
                  <ActivityIndicator size="small" color="#0F172A" />
                ) : (
                  <Ionicons name="log-out-outline" size={18} color="#0F172A" />
                )}
                <Text style={styles.signOutText}>{isSigningOut ? 'Signing out' : 'Sign out'}</Text>
              </TouchableOpacity>
            </>
          )}
        </View>
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
  screen: {
    flex: 1,
    paddingHorizontal: 24,
    paddingTop: 26,
  },
  heading: {
    color: '#F8FAFC',
    fontSize: 31,
    fontWeight: '800',
    marginBottom: 24,
  },
  card: {
    borderRadius: 24,
    backgroundColor: '#0B1220',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    padding: 22,
    alignItems: 'center',
    gap: 10,
  },
  avatar: {
    width: 74,
    height: 74,
    borderRadius: 37,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(56, 189, 248, 0.12)',
    marginBottom: 4,
  },
  title: {
    color: '#F8FAFC',
    fontSize: 18,
    fontWeight: '800',
  },
  body: {
    color: '#94A3B8',
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 20,
  },
  signOutButton: {
    minHeight: 46,
    borderRadius: 18,
    backgroundColor: '#38BDF8',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 18,
    marginTop: 10,
  },
  signOutText: {
    color: '#0F172A',
    fontSize: 14,
    fontWeight: '800',
  },
  buttonDisabled: {
    opacity: 0.55,
  },
});
