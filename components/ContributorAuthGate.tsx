import { useRef, useState } from 'react';
import {
  ActivityIndicator,
  Keyboard,
  LayoutChangeEvent,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  TouchableWithoutFeedback,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSignIn, useSignUp } from '@clerk/clerk-expo';

import { BottomNav, BOTTOM_NAV_HEIGHT } from '@/components/BottomNav';

type SignUpAttemptResult = {
  status: string | null;
  createdSessionId: string | null;
  missingFields?: string[];
  unverifiedFields?: string[];
};

type SignInFactor = {
  strategy?: string;
  emailAddressId?: string;
  safeIdentifier?: string;
};

type SignInAttemptResult = {
  status: string | null;
  createdSessionId: string | null;
  supportedFirstFactors?: SignInFactor[] | null;
};

function getAuthErrorMessage(error: unknown) {
  if (
    typeof error === 'object' &&
    error !== null &&
    'errors' in error &&
    Array.isArray((error as { errors?: unknown }).errors)
  ) {
    const firstError = (error as { errors: { longMessage?: string; message?: string }[] }).errors[0];
    return firstError?.longMessage ?? firstError?.message ?? 'Authentication failed.';
  }

  return error instanceof Error ? error.message : 'Authentication failed.';
}

function formatClerkField(field: string) {
  return field
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase();
}

function getIncompleteSignUpMessage(result: SignUpAttemptResult) {
  const missingFields = result.missingFields ?? [];
  const unverifiedFields = result.unverifiedFields ?? [];

  if (missingFields.length > 0) {
    return `Clerk needs more information before it can finish registration: ${missingFields
      .map(formatClerkField)
      .join(', ')}. Fill those fields or make them optional in the Clerk dashboard.`;
  }

  if (unverifiedFields.includes('email_address')) {
    return 'Email verification is still pending. Check the code and try again.';
  }

  return `Clerk did not finish registration. Current status: ${result.status ?? 'unknown'}.`;
}

function getMissingFields(result: SignUpAttemptResult) {
  return result.missingFields ?? [];
}

function getSupportedSignInStrategies(result: SignInAttemptResult) {
  return (result.supportedFirstFactors ?? [])
    .map((factor) => factor.strategy)
    .filter((strategy): strategy is string => Boolean(strategy));
}

function getUnsupportedSignInMessage(result: SignInAttemptResult) {
  const strategies = getSupportedSignInStrategies(result);

  if (result.status === 'needs_second_factor') {
    return 'This account has multi-factor authentication enabled. This app does not support MFA yet. Disable MFA for this test account or use another contributor account.';
  }

  if (strategies.length > 0) {
    return `This account requires a sign-in method that is not fully enabled in the app yet: ${strategies.join(', ')}. Use an email/password contributor account or enable email code sign-in.`;
  }

  return `This account requires another sign-in step that is not enabled in the app yet. Clerk status: ${result.status ?? 'unknown'}.`;
}

async function prepareEmailCodeSignIn(
  result: SignInAttemptResult,
  prepareFirstFactor: (params: { strategy: 'email_code'; emailAddressId: string }) => Promise<unknown>,
) {
  const emailCodeFactor = result.supportedFirstFactors?.find(
    (factor) => factor.strategy === 'email_code' && factor.emailAddressId,
  );

  if (!emailCodeFactor?.emailAddressId) {
    return false;
  }

  await prepareFirstFactor({
    strategy: 'email_code',
    emailAddressId: emailCodeFactor.emailAddressId,
  });

  return true;
}

export function ContributorAuthGate() {
  const insets = useSafeAreaInsets();
  const signInState = useSignIn();
  const signUpState = useSignUp();
  const scrollViewRef = useRef<ScrollView>(null);
  const inputPositions = useRef<Record<string, number>>({});
  const [mode, setMode] = useState<'signIn' | 'signUp'>('signIn');
  const [username, setUsername] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [verificationCode, setVerificationCode] = useState('');
  const [pendingVerification, setPendingVerification] = useState(false);
  const [pendingVerificationFlow, setPendingVerificationFlow] = useState<'signIn' | 'signUp' | null>(null);
  const [missingSignUpFields, setMissingSignUpFields] = useState<string[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const isSignUp = mode === 'signUp';
  const isLoaded = signInState.isLoaded && signUpState.isLoaded;
  const hasMissingSignUpFields = missingSignUpFields.length > 0;

  const registerInputPosition = (key: string) => (event: LayoutChangeEvent) => {
    inputPositions.current[key] = event.nativeEvent.layout.y;
  };

  const focusInput = (key: string) => {
    setTimeout(() => {
      const y = inputPositions.current[key] ?? 0;
      scrollViewRef.current?.scrollTo({
        y: Math.max(y - 120, 0),
        animated: true,
      });
    }, 180);
  };

  const switchMode = (nextMode: 'signIn' | 'signUp') => {
    setMode(nextMode);
    setPendingVerification(false);
    setPendingVerificationFlow(null);
    setMissingSignUpFields([]);
    setVerificationCode('');
    setStatusMessage(null);
    setErrorMessage(null);
  };

  const submitAuth = async () => {
    if (!isLoaded || isSubmitting) {
      return;
    }

    const nextEmail = email.trim();
    const nextUsername = username.trim();
    const nextFirstName = firstName.trim();
    const nextLastName = lastName.trim();
    if (!nextEmail || (mode === 'signUp' && !password)) {
      setErrorMessage(mode === 'signUp' ? 'Enter an email address and password.' : 'Enter an email address.');
      return;
    }

    if (mode === 'signUp' && !nextUsername) {
      setErrorMessage('Enter a username.');
      return;
    }

    try {
      setIsSubmitting(true);
      setErrorMessage(null);
      setStatusMessage(null);
      setMissingSignUpFields([]);

      if (mode === 'signIn') {
        const result = await signInState.signIn.create(
          password
            ? {
                identifier: nextEmail,
                password,
              }
            : {
                identifier: nextEmail,
              },
        );

        if (result.status === 'complete' && result.createdSessionId && signInState.setActive) {
          await signInState.setActive({ session: result.createdSessionId });
          return;
        }

        if (result.status === 'needs_first_factor') {
          const didPrepareEmailCode = await prepareEmailCodeSignIn(result, signInState.signIn.prepareFirstFactor);

          if (didPrepareEmailCode) {
            setPendingVerification(true);
            setPendingVerificationFlow('signIn');
            setStatusMessage('Check your email and enter the sign-in code.');
            return;
          }
        }

        setErrorMessage(getUnsupportedSignInMessage(result));
        return;
      }

      const result = await signUpState.signUp.create({
        emailAddress: nextEmail,
        password,
        username: nextUsername,
        ...(nextFirstName ? { firstName: nextFirstName } : {}),
        ...(nextLastName ? { lastName: nextLastName } : {}),
      });

      if (result.status === 'complete' && result.createdSessionId && signUpState.setActive) {
        await signUpState.setActive({ session: result.createdSessionId });
        return;
      }

      if (result.unverifiedFields.includes('email_address')) {
        await signUpState.signUp.prepareEmailAddressVerification({ strategy: 'email_code' });
        setPendingVerification(true);
        setPendingVerificationFlow('signUp');
        setStatusMessage('Check your email and enter the verification code.');
        return;
      }

      if (result.status === 'complete') {
        setErrorMessage('Clerk created the account, but did not return a session to activate.');
        return;
      }

      setMissingSignUpFields(getMissingFields(result));
      setErrorMessage(getIncompleteSignUpMessage(result));
    } catch (error) {
      setErrorMessage(getAuthErrorMessage(error));
    } finally {
      setIsSubmitting(false);
    }
  };

  const submitVerification = async () => {
    if (!signUpState.isLoaded || !signInState.isLoaded || isSubmitting) {
      return;
    }

    if (!verificationCode.trim()) {
      setErrorMessage('Enter the verification code.');
      return;
    }

    try {
      setIsSubmitting(true);
      setErrorMessage(null);

      if (pendingVerificationFlow === 'signIn') {
        const result = await signInState.signIn.attemptFirstFactor({
          strategy: 'email_code',
          code: verificationCode.trim(),
        });

        if (result.status === 'complete' && result.createdSessionId && signInState.setActive) {
          await signInState.setActive({ session: result.createdSessionId });
          return;
        }

        setErrorMessage(getUnsupportedSignInMessage(result));
        return;
      }

      const result = await signUpState.signUp.attemptEmailAddressVerification({
        code: verificationCode.trim(),
      });

      if (result.status === 'complete' && result.createdSessionId && signUpState.setActive) {
        await signUpState.setActive({ session: result.createdSessionId });
        return;
      }

      if (result.status === 'complete') {
        setErrorMessage('Clerk verified the email, but did not return a session to activate.');
        return;
      }

      setMissingSignUpFields(getMissingFields(result));
      setErrorMessage(getIncompleteSignUpMessage(result));
    } catch (error) {
      setErrorMessage(getAuthErrorMessage(error));
    } finally {
      setIsSubmitting(false);
    }
  };

  const submitMissingRequirements = async () => {
    if (!signUpState.isLoaded || isSubmitting) {
      return;
    }

    const nextUsername = username.trim();
    const nextFirstName = firstName.trim();
    const nextLastName = lastName.trim();

    if (missingSignUpFields.includes('username') && !nextUsername) {
      setErrorMessage('Enter a username.');
      return;
    }

    try {
      setIsSubmitting(true);
      setErrorMessage(null);
      setStatusMessage(null);

      const result = await signUpState.signUp.update({
        ...(nextUsername ? { username: nextUsername } : {}),
        ...(nextFirstName ? { firstName: nextFirstName } : {}),
        ...(nextLastName ? { lastName: nextLastName } : {}),
      });

      if (result.status === 'complete' && result.createdSessionId && signUpState.setActive) {
        await signUpState.setActive({ session: result.createdSessionId });
        return;
      }

      if (result.unverifiedFields.includes('email_address')) {
        await signUpState.signUp.prepareEmailAddressVerification({ strategy: 'email_code' });
        setMissingSignUpFields([]);
        setPendingVerification(true);
        setPendingVerificationFlow('signUp');
        setStatusMessage('Check your email and enter the verification code.');
        return;
      }

      setMissingSignUpFields(getMissingFields(result));
      setErrorMessage(getIncompleteSignUpMessage(result));
    } catch (error) {
      setErrorMessage(getAuthErrorMessage(error));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <View style={[styles.safeArea, { paddingTop: insets.top }]}>
      <StatusBar style="light" />
      <TouchableWithoutFeedback onPress={Keyboard.dismiss} accessible={false}>
        <ScrollView
          ref={scrollViewRef}
          contentContainerStyle={[
            styles.screen,
            styles.authScreen,
            { paddingBottom: BOTTOM_NAV_HEIGHT + Math.max(insets.bottom, 10) + 140 },
          ]}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
        >
        <View style={styles.header}>
          <Text style={styles.heading}>Contributor access</Text>
          <Text style={styles.subtitle}>
            Prediction stays public. Sign in only when you want to upload dataset recordings.
          </Text>
        </View>

        <View style={styles.authPanel}>
          <View style={styles.authSwitchRow}>
            <TouchableOpacity
              activeOpacity={0.85}
              onPress={() => switchMode('signIn')}
              style={[styles.authModeButton, !isSignUp && styles.authModeButtonActive]}
            >
              <Text style={[styles.authModeText, !isSignUp && styles.authModeTextActive]}>Sign in</Text>
            </TouchableOpacity>
            <TouchableOpacity
              activeOpacity={0.85}
              onPress={() => switchMode('signUp')}
              style={[styles.authModeButton, isSignUp && styles.authModeButtonActive]}
            >
              <Text style={[styles.authModeText, isSignUp && styles.authModeTextActive]}>Register</Text>
            </TouchableOpacity>
          </View>

          {isSignUp && (!pendingVerification || missingSignUpFields.includes('username')) ? (
            <TextInput
              onLayout={registerInputPosition('username')}
              onFocus={() => focusInput('username')}
              value={username}
              onChangeText={setUsername}
              placeholder="Username"
              placeholderTextColor="#64748B"
              autoCapitalize="none"
              autoCorrect={false}
              textContentType="username"
              style={styles.input}
            />
          ) : null}

          {isSignUp && (!pendingVerification || hasMissingSignUpFields) ? (
            <View style={styles.nameRow}>
              <TextInput
                onLayout={registerInputPosition('firstName')}
                onFocus={() => focusInput('firstName')}
                value={firstName}
                onChangeText={setFirstName}
                placeholder="First name"
                placeholderTextColor="#64748B"
                autoCapitalize="words"
                textContentType="givenName"
                style={[styles.input, styles.nameInput]}
              />
              <TextInput
                onLayout={registerInputPosition('lastName')}
                onFocus={() => focusInput('lastName')}
                value={lastName}
                onChangeText={setLastName}
                placeholder="Last name"
                placeholderTextColor="#64748B"
                autoCapitalize="words"
                textContentType="familyName"
                style={[styles.input, styles.nameInput]}
              />
            </View>
          ) : null}

          <TextInput
            onLayout={registerInputPosition('email')}
            onFocus={() => focusInput('email')}
            value={email}
            onChangeText={setEmail}
            placeholder="Email"
            placeholderTextColor="#64748B"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            textContentType="emailAddress"
            style={styles.input}
          />
          <TextInput
            onLayout={registerInputPosition('password')}
            onFocus={() => focusInput('password')}
            value={password}
            onChangeText={setPassword}
            placeholder={isSignUp ? 'Password' : 'Password or leave empty for email code'}
            placeholderTextColor="#64748B"
            autoCapitalize="none"
            secureTextEntry
            textContentType={isSignUp ? 'newPassword' : 'password'}
            style={styles.input}
          />

          {pendingVerification ? (
            <TextInput
              onLayout={registerInputPosition('verificationCode')}
              onFocus={() => focusInput('verificationCode')}
              value={verificationCode}
              onChangeText={setVerificationCode}
              placeholder="Email verification code"
              placeholderTextColor="#64748B"
              autoCapitalize="none"
              keyboardType="number-pad"
              style={styles.input}
            />
          ) : null}

          {errorMessage ? (
            <View style={styles.errorBox}>
              <Text style={styles.messageTitle}>Authentication error</Text>
              <Text style={styles.messageBody}>{errorMessage}</Text>
            </View>
          ) : null}

          {statusMessage ? (
            <View style={styles.messageBox}>
              <Text style={styles.messageTitle}>Status</Text>
              <Text style={styles.messageBody}>{statusMessage}</Text>
            </View>
          ) : null}

          <TouchableOpacity
            activeOpacity={0.85}
            disabled={!isLoaded || isSubmitting}
            onPress={
              hasMissingSignUpFields
                ? submitMissingRequirements
                : pendingVerification
                  ? submitVerification
                  : submitAuth
            }
            style={[styles.primaryButton, (!isLoaded || isSubmitting) && styles.buttonDisabled]}
          >
            {isSubmitting ? (
              <ActivityIndicator size="small" color="#FFFFFF" />
            ) : (
              <Ionicons
                name={
                  hasMissingSignUpFields
                    ? 'person-add-outline'
                    : pendingVerification
                      ? 'mail-open-outline'
                      : 'person-circle-outline'
                }
                size={18}
                color="#FFFFFF"
              />
            )}
            <Text style={styles.primaryButtonText}>
              {isSubmitting
                ? 'Working...'
                : hasMissingSignUpFields
                  ? 'Complete registration'
                  : pendingVerification
                    ? 'Verify email'
                    : isSignUp
                      ? 'Create contributor account'
                      : 'Sign in'}
            </Text>
          </TouchableOpacity>
        </View>
        </ScrollView>
      </TouchableWithoutFeedback>
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
    padding: 20,
    paddingBottom: 36,
  },
  authScreen: {
    flexGrow: 1,
    justifyContent: 'center',
  },
  header: {
    marginBottom: 18,
  },
  heading: {
    color: '#F8FAFC',
    fontSize: 28,
    fontWeight: '700',
  },
  subtitle: {
    color: '#98A1C1',
    fontSize: 15,
    lineHeight: 21,
    marginTop: 6,
  },
  authPanel: {
    borderRadius: 8,
    backgroundColor: '#0B1220',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    padding: 14,
    gap: 12,
  },
  authSwitchRow: {
    minHeight: 44,
    borderRadius: 8,
    backgroundColor: '#05060A',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    flexDirection: 'row',
    padding: 4,
    gap: 4,
  },
  authModeButton: {
    flex: 1,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  authModeButtonActive: {
    backgroundColor: '#E2E8F0',
  },
  authModeText: {
    color: '#94A3B8',
    fontSize: 13,
    fontWeight: '700',
  },
  authModeTextActive: {
    color: '#0F172A',
  },
  input: {
    minHeight: 48,
    borderRadius: 8,
    backgroundColor: '#0B1220',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    color: '#E2E8F0',
    paddingHorizontal: 14,
    fontSize: 15,
  },
  nameRow: {
    flexDirection: 'row',
    gap: 10,
  },
  nameInput: {
    flex: 1,
    minWidth: 0,
  },
  primaryButton: {
    minHeight: 52,
    borderRadius: 8,
    backgroundColor: '#38BDF8',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 14,
  },
  primaryButtonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '800',
  },
  buttonDisabled: {
    opacity: 0.55,
  },
  messageBox: {
    borderRadius: 8,
    backgroundColor: 'rgba(56, 189, 248, 0.1)',
    borderWidth: 1,
    borderColor: 'rgba(56, 189, 248, 0.24)',
    padding: 12,
    gap: 5,
  },
  errorBox: {
    borderRadius: 8,
    backgroundColor: 'rgba(239, 68, 68, 0.1)',
    borderWidth: 1,
    borderColor: 'rgba(239, 68, 68, 0.28)',
    padding: 12,
    gap: 5,
  },
  messageTitle: {
    color: '#E2E8F0',
    fontSize: 13,
    fontWeight: '800',
  },
  messageBody: {
    color: '#CBD5E1',
    fontSize: 13,
    lineHeight: 18,
  },
});
