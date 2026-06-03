import { useState } from 'react';
import { ActivityIndicator, Linking, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useAuth, useClerk, useUser } from '@clerk/clerk-expo';
import { BottomNav, BOTTOM_NAV_HEIGHT } from '@/components/BottomNav';
import { ContributorAuthGate } from '@/components/ContributorAuthGate';

const SUPPORT_EMAIL = 'jeanbaptiste.dindane@studio.unibo.it';
const SUPPORT_LINKEDIN_URL = 'https://www.linkedin.com/in/jean-dindane-629a91304/';
const SUPPORT_EMAIL_SUBJECT = 'CarZam support request';

export default function AccountScreen() {
  const insets = useSafeAreaInsets();
  const { isLoaded, userId } = useAuth();
  const { signOut } = useClerk();
  const { user } = useUser();
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [supportMessage, setSupportMessage] = useState<string | null>(null);
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

  const openSupportEmail = async () => {
    const subject = encodeURIComponent(SUPPORT_EMAIL_SUBJECT);
    const body = encodeURIComponent('Hi Jean,\n\nI need help with CarZam.\n\n');
    const url = `mailto:${SUPPORT_EMAIL}?subject=${subject}&body=${body}`;

    try {
      setSupportMessage(null);
      await Linking.openURL(url);
    } catch {
      setSupportMessage('Unable to open your mail app. You can email support manually.');
    }
  };

  const openLinkedIn = async () => {
    try {
      setSupportMessage(null);
      await Linking.openURL(SUPPORT_LINKEDIN_URL);
    } catch {
      setSupportMessage('Unable to open LinkedIn. Try again from your browser.');
    }
  };

  return (
    <View style={[styles.safeArea, { paddingTop: insets.top }]}> 
      <StatusBar style="light" />
      <ScrollView
        contentContainerStyle={[
          styles.screen,
          { paddingBottom: BOTTOM_NAV_HEIGHT + Math.max(insets.bottom, 10) + 24 },
        ]}
        showsVerticalScrollIndicator={false}
      > 
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

        <View style={styles.supportCard}>
          <View style={styles.supportIcon}>
            <Ionicons name="help-buoy-outline" size={24} color="#38BDF8" />
          </View>
          <View style={styles.supportTextBlock}>
            <Text style={styles.supportTitle}>Tech support</Text>
            <Text style={styles.supportBody}>Need help testing or collecting data? Contact our team.</Text>
            <Text selectable style={styles.supportDetail}>{SUPPORT_EMAIL}</Text>
          </View>

          <View style={styles.supportActions}>
            <TouchableOpacity activeOpacity={0.86} onPress={openSupportEmail} style={styles.supportButton}>
              <Ionicons name="mail-outline" size={18} color="#0F172A" />
              <Text style={styles.supportButtonText}>Email</Text>
            </TouchableOpacity>
            <TouchableOpacity activeOpacity={0.86} onPress={openLinkedIn} style={styles.supportSecondaryButton}>
              <Ionicons name="logo-linkedin" size={18} color="#BAE6FD" />
              <Text style={styles.supportSecondaryButtonText}>LinkedIn</Text>
            </TouchableOpacity>
          </View>

          {supportMessage ? (
            <Text style={styles.supportMessage}>{supportMessage}</Text>
          ) : null}
        </View>
      </ScrollView>
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
  supportCard: {
    borderRadius: 24,
    backgroundColor: '#0B1220',
    borderWidth: 1,
    borderColor: 'rgba(56, 189, 248, 0.16)',
    padding: 20,
    marginTop: 18,
    gap: 14,
  },
  supportIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(56, 189, 248, 0.12)',
    borderWidth: 1,
    borderColor: 'rgba(56, 189, 248, 0.22)',
  },
  supportTextBlock: {
    gap: 6,
  },
  supportTitle: {
    color: '#F8FAFC',
    fontSize: 18,
    fontWeight: '900',
  },
  supportBody: {
    color: '#94A3B8',
    fontSize: 14,
    lineHeight: 20,
  },
  supportDetail: {
    color: '#BAE6FD',
    fontSize: 13,
    fontWeight: '800',
  },
  supportActions: {
    flexDirection: 'row',
    gap: 10,
  },
  supportButton: {
    flex: 1,
    minHeight: 46,
    borderRadius: 16,
    backgroundColor: '#38BDF8',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  supportButtonText: {
    color: '#0F172A',
    fontSize: 14,
    fontWeight: '900',
  },
  supportSecondaryButton: {
    flex: 1,
    minHeight: 46,
    borderRadius: 16,
    backgroundColor: '#111827',
    borderWidth: 1,
    borderColor: 'rgba(56, 189, 248, 0.2)',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  supportSecondaryButtonText: {
    color: '#BAE6FD',
    fontSize: 14,
    fontWeight: '900',
  },
  supportMessage: {
    color: '#FECACA',
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '700',
  },
});
