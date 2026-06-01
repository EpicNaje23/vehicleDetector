import { useRef, useState } from 'react';
import {
  ActivityIndicator,
  Keyboard,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  TouchableWithoutFeedback,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth, useClerk, useSignIn, useSignUp, useUser } from '@clerk/clerk-expo';
import { StatusBar } from 'expo-status-bar';
import { Ionicons } from '@expo/vector-icons';
import { CameraView, useCameraPermissions, useMicrophonePermissions } from 'expo-camera';
import * as Device from 'expo-device';
import * as FileSystem from 'expo-file-system/legacy';
import * as Location from 'expo-location';
import { useConvexAuth, useMutation, useQuery } from 'convex/react';

import { api } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';

const CONVEX_URL = process.env.EXPO_PUBLIC_CONVEX_URL;
const CLERK_PUBLISHABLE_KEY = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY;
const MAX_SESSION_SECONDS = 30 * 60;
const CONVEX_AUTH_SETUP_MESSAGE =
  'Convex is not receiving your Clerk sign-in token. In Clerk, create or update the JWT template named "convex" with audience "convex", then sign out and sign back in.';

type SessionDraft = {
  sessionId: string;
  startedAt: string;
  endedAt: string;
  durationMillis: number;
  latitude?: number;
  longitude?: number;
  locationAccuracy?: number;
};

type UploadProgress = {
  sentBytes: number;
  totalBytes: number;
  percent: number;
};

type SignUpAttemptResult = {
  status: string | null;
  createdSessionId: string | null;
  missingFields?: string[];
  unverifiedFields?: string[];
};

type CollectScreenContentProps = {
  contributorName: string;
  contributorEmail?: string;
  onSignOut: () => void;
  isSigningOut: boolean;
};

function formatDuration(durationMillis: number) {
  const totalSeconds = Math.max(0, Math.floor(durationMillis / 1000));
  const minutes = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, '0');
  const seconds = (totalSeconds % 60).toString().padStart(2, '0');

  return `${minutes}:${seconds}`;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const megabytes = bytes / (1024 * 1024);
  if (megabytes >= 1) {
    return `${megabytes.toFixed(1)} MB`;
  }

  return `${(bytes / 1024).toFixed(1)} KB`;
}

function makeSessionId() {
  return `session-${new Date().toISOString().replace(/[:.]/g, '-')}`;
}

function getVideoFileName(sessionId: string) {
  return `${sessionId}.mov`;
}

function getDeviceLabel() {
  const model = Device.modelName ?? Device.modelId ?? Device.productName ?? Device.designName ?? 'Unknown device';
  const maker = Device.manufacturer ?? Device.brand;
  const os = [Device.osName, Device.osVersion].filter(Boolean).join(' ');

  return [maker, model, os].filter(Boolean).join(' · ');
}

export default function CollectScreen() {
  if (!CONVEX_URL) {
    return <MissingConvexConfig />;
  }

  if (!CLERK_PUBLISHABLE_KEY) {
    return <MissingAuthConfig />;
  }

  return <AuthenticatedCollectScreen />;
}

function MissingConvexConfig() {
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.safeArea, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <StatusBar style="light" />
      <View style={styles.screen}>
        <Text style={styles.heading}>Dataset collection</Text>
        <View style={styles.messageBox}>
          <Text style={styles.messageTitle}>Convex is not configured</Text>
          <Text style={styles.messageBody}>
            Add EXPO_PUBLIC_CONVEX_URL to .env, then restart Expo with pnpm start --clear.
          </Text>
        </View>
      </View>
    </View>
  );
}

function MissingAuthConfig() {
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.safeArea, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <StatusBar style="light" />
      <View style={styles.screen}>
        <Text style={styles.heading}>Dataset collection</Text>
        <View style={styles.messageBox}>
          <Text style={styles.messageTitle}>Contributor login is not configured</Text>
          <Text style={styles.messageBody}>
            Add EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY to .env, then restart Expo with pnpm start --clear.
          </Text>
        </View>
      </View>
    </View>
  );
}

function AuthenticatedCollectScreen() {
  const { isLoaded, userId } = useAuth();
  const { signOut } = useClerk();
  const { user } = useUser();
  const [isSigningOut, setIsSigningOut] = useState(false);
  const contributorEmail = user?.primaryEmailAddress?.emailAddress;
  const contributorName = user?.fullName ?? contributorEmail ?? 'Contributor';

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

  if (!isLoaded) {
    return <LoadingScreen title="Checking contributor session" />;
  }

  if (!userId) {
    return <ContributorAuthGate />;
  }

  return (
    <CollectScreenContent
      contributorName={contributorName}
      contributorEmail={contributorEmail}
      onSignOut={handleSignOut}
      isSigningOut={isSigningOut}
    />
  );
}

function LoadingScreen({ title }: { title: string }) {
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.safeArea, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <StatusBar style="light" />
      <View style={[styles.screen, styles.centeredScreen]}>
        <ActivityIndicator size="small" color="#38BDF8" />
        <Text style={styles.loadingText}>{title}</Text>
      </View>
    </View>
  );
}

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

function ContributorAuthGate() {
  const insets = useSafeAreaInsets();
  const signInState = useSignIn();
  const signUpState = useSignUp();
  const [mode, setMode] = useState<'signIn' | 'signUp'>('signIn');
  const [username, setUsername] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [verificationCode, setVerificationCode] = useState('');
  const [pendingVerification, setPendingVerification] = useState(false);
  const [missingSignUpFields, setMissingSignUpFields] = useState<string[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const isSignUp = mode === 'signUp';
  const isLoaded = signInState.isLoaded && signUpState.isLoaded;
  const hasMissingSignUpFields = missingSignUpFields.length > 0;

  const switchMode = (nextMode: 'signIn' | 'signUp') => {
    setMode(nextMode);
    setPendingVerification(false);
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
    if (!nextEmail || !password) {
      setErrorMessage('Enter an email address and password.');
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
        const result = await signInState.signIn.create({
          identifier: nextEmail,
          password,
        });

        if (result.status === 'complete' && result.createdSessionId && signInState.setActive) {
          await signInState.setActive({ session: result.createdSessionId });
          return;
        }

        throw new Error('This account requires another sign-in step that is not enabled in the app yet.');
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
        setStatusMessage('Check your email and enter the verification code.');
        return;
      }

      if (result.status === 'complete') {
        throw new Error('Clerk created the account, but did not return a session to activate.');
      }

      setMissingSignUpFields(getMissingFields(result));
      throw new Error(getIncompleteSignUpMessage(result));
    } catch (error) {
      setErrorMessage(getAuthErrorMessage(error));
    } finally {
      setIsSubmitting(false);
    }
  };

  const submitVerification = async () => {
    if (!signUpState.isLoaded || isSubmitting) {
      return;
    }

    if (!verificationCode.trim()) {
      setErrorMessage('Enter the verification code.');
      return;
    }

    try {
      setIsSubmitting(true);
      setErrorMessage(null);

      const result = await signUpState.signUp.attemptEmailAddressVerification({
        code: verificationCode.trim(),
      });

      if (result.status === 'complete' && result.createdSessionId && signUpState.setActive) {
        await signUpState.setActive({ session: result.createdSessionId });
        return;
      }

      if (result.status === 'complete') {
        throw new Error('Clerk verified the email, but did not return a session to activate.');
      }

      setMissingSignUpFields(getMissingFields(result));
      throw new Error(getIncompleteSignUpMessage(result));
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
        setStatusMessage('Check your email and enter the verification code.');
        return;
      }

      setMissingSignUpFields(getMissingFields(result));
      throw new Error(getIncompleteSignUpMessage(result));
    } catch (error) {
      setErrorMessage(getAuthErrorMessage(error));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <View style={[styles.safeArea, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <StatusBar style="light" />
      <ScrollView contentContainerStyle={[styles.screen, styles.authScreen]}>
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
                value={firstName}
                onChangeText={setFirstName}
                placeholder="First name"
                placeholderTextColor="#64748B"
                autoCapitalize="words"
                textContentType="givenName"
                style={[styles.input, styles.nameInput]}
              />
              <TextInput
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
            value={password}
            onChangeText={setPassword}
            placeholder="Password"
            placeholderTextColor="#64748B"
            autoCapitalize="none"
            secureTextEntry
            textContentType={isSignUp ? 'newPassword' : 'password'}
            style={styles.input}
          />

          {pendingVerification ? (
            <TextInput
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
            onPress={hasMissingSignUpFields ? submitMissingRequirements : pendingVerification ? submitVerification : submitAuth}
            style={[styles.primaryButton, (!isLoaded || isSubmitting) && styles.buttonDisabled]}
          >
            {isSubmitting ? (
              <ActivityIndicator size="small" color="#FFFFFF" />
            ) : (
              <Ionicons
                name={hasMissingSignUpFields ? 'person-add-outline' : pendingVerification ? 'mail-open-outline' : 'person-circle-outline'}
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
    </View>
  );
}

function CollectScreenContent({
  contributorName,
  contributorEmail,
  onSignOut,
  isSigningOut,
}: CollectScreenContentProps) {
  const insets = useSafeAreaInsets();
  const convexAuth = useConvexAuth();
  const scrollViewRef = useRef<ScrollView>(null);
  const cameraRef = useRef<CameraView>(null);
  const locationInputY = useRef(0);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [microphonePermission, requestMicrophonePermission] = useMicrophonePermissions();
  const generateUploadUrl = useMutation(api.dataset.generateUploadUrl);
  const createSession = useMutation(api.dataset.createSession);
  const recentSessions = useQuery(api.dataset.listRecentSessions, convexAuth.isAuthenticated ? {} : 'skip');
  const [locationName, setLocationName] = useState('');
  const [videoUri, setVideoUri] = useState<string | null>(null);
  const [sessionDraft, setSessionDraft] = useState<SessionDraft | null>(null);
  const [elapsedMillis, setElapsedMillis] = useState(0);
  const [isRecording, setIsRecording] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const hasCameraAccess = cameraPermission?.granted ?? false;
  const hasMicrophoneAccess = microphonePermission?.granted ?? false;

  const ensurePermissions = async () => {
    const nextCamera = hasCameraAccess ? cameraPermission : await requestCameraPermission();
    const nextMicrophone = hasMicrophoneAccess ? microphonePermission : await requestMicrophonePermission();
    const nextLocation = await Location.requestForegroundPermissionsAsync();

    if (!nextCamera?.granted) {
      throw new Error('Camera permission is required to record dataset sessions.');
    }

    if (!nextMicrophone?.granted) {
      throw new Error('Microphone permission is required to record dataset sessions.');
    }

    if (!nextLocation.granted) {
      throw new Error('Location permission is required to save dataset coordinates.');
    }
  };

  const startSession = async () => {
    if (isRecording || isUploading) {
      return;
    }

    try {
      setErrorMessage(null);
      setSuccessMessage(null);
      setUploadProgress(null);
      setVideoUri(null);
      setSessionDraft(null);
      setElapsedMillis(0);

      await ensurePermissions();
      const location = await Location.getCurrentPositionAsync({});
      const startedAtDate = new Date();
      const startedAtMs = startedAtDate.getTime();
      const sessionId = makeSessionId();

      setIsRecording(true);
      setIsStopping(false);
      const elapsedTimer = setInterval(() => {
        setElapsedMillis(Date.now() - startedAtMs);
      }, 500);

      const recording = await cameraRef.current?.recordAsync({
        maxDuration: MAX_SESSION_SECONDS,
      });
      const endedAtDate = new Date();
      clearInterval(elapsedTimer);

      if (!recording?.uri) {
        throw new Error('Recording stopped, but no video file was created.');
      }

      setVideoUri(recording.uri);
      setElapsedMillis(endedAtDate.getTime() - startedAtMs);
      setSessionDraft({
        sessionId,
        startedAt: startedAtDate.toISOString(),
        endedAt: endedAtDate.toISOString(),
        durationMillis: endedAtDate.getTime() - startedAtMs,
        latitude: location.coords.latitude,
        longitude: location.coords.longitude,
        locationAccuracy: location.coords.accuracy ?? undefined,
      });
      setSuccessMessage('Session saved locally. Upload it when the network is stable.');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to record dataset session.';
      setErrorMessage(message);
    } finally {
      setIsRecording(false);
      setIsStopping(false);
    }
  };

  const stopSession = () => {
    if (!isRecording || isStopping) {
      return;
    }

    setIsStopping(true);
    cameraRef.current?.stopRecording();
  };

  const scrollToLocationInput = () => {
    setTimeout(() => {
      scrollViewRef.current?.scrollTo({
        y: Math.max(locationInputY.current - 80, 0),
        animated: true,
      });
    }, 160);
  };

  const uploadSession = async () => {
    if (!videoUri || !sessionDraft) {
      setErrorMessage('Record a session before uploading.');
      return;
    }

    const trimmedLocationName = locationName.trim();
    if (!trimmedLocationName) {
      setErrorMessage('Location name is required before uploading.');
      return;
    }

    try {
      setErrorMessage(null);
      setSuccessMessage(null);

      if (convexAuth.isLoading) {
        setErrorMessage('Still connecting your contributor account to Convex. Try again in a moment.');
        return;
      }

      if (!convexAuth.isAuthenticated) {
        throw new Error(CONVEX_AUTH_SETUP_MESSAGE);
      }

      setIsUploading(true);
      setUploadProgress({ sentBytes: 0, totalBytes: 0, percent: 0 });

      const fileType = 'video/quicktime';
      const fileName = getVideoFileName(sessionDraft.sessionId);
      const fileInfo = await FileSystem.getInfoAsync(videoUri);
      const fileSizeBytes = fileInfo.exists ? fileInfo.size : undefined;
      setUploadProgress({
        sentBytes: 0,
        totalBytes: fileSizeBytes ?? 0,
        percent: 0,
      });
      const uploadUrl = await generateUploadUrl();
      const uploadTask = FileSystem.createUploadTask(uploadUrl, videoUri, {
        httpMethod: 'POST',
        uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
        headers: {
          'Content-Type': fileType,
        },
        sessionType: FileSystem.FileSystemSessionType.BACKGROUND,
      }, (progress) => {
        const totalBytes = Math.max(progress.totalBytesExpectedToSend, fileSizeBytes ?? 0, 0);
        const percent = totalBytes > 0
          ? Math.min(100, Math.round((progress.totalBytesSent / totalBytes) * 100))
          : 0;

        setUploadProgress({
          sentBytes: progress.totalBytesSent,
          totalBytes,
          percent,
        });
      });
      const uploadResponse = await uploadTask.uploadAsync();

      if (!uploadResponse) {
        throw new Error('Convex storage upload did not return a response.');
      }

      if (uploadResponse.status < 200 || uploadResponse.status >= 300) {
        throw new Error(`Convex storage upload failed with status ${uploadResponse.status}.`);
      }

      const { storageId } = JSON.parse(uploadResponse.body) as { storageId: string };

      await createSession({
        ...sessionDraft,
        storageId: storageId as Id<'_storage'>,
        fileName,
        fileType,
        locationName: trimmedLocationName,
        device: getDeviceLabel(),
        fileSizeBytes,
        uploadedAt: Date.now(),
      });

      setUploadProgress({ sentBytes: fileSizeBytes ?? 0, totalBytes: fileSizeBytes ?? 0, percent: 100 });
      setSuccessMessage('Dataset session uploaded to Convex.');
      setVideoUri(null);
      setSessionDraft(null);
      setElapsedMillis(0);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to upload dataset session.';
      setErrorMessage(message);
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <View style={[styles.safeArea, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <StatusBar style="light" />
      <TouchableWithoutFeedback onPress={Keyboard.dismiss} accessible={false}>
        <ScrollView
          ref={scrollViewRef}
          contentContainerStyle={styles.screen}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
        >
          <View style={styles.header}>
            <Text style={styles.heading}>Collect dataset</Text>
            <Text style={styles.subtitle}>Record long video sessions now. Annotate the vehicles later.</Text>
          </View>

        <View style={styles.contributorCard}>
          <View style={styles.contributorIcon}>
            <Ionicons name="person-outline" size={18} color="#38BDF8" />
          </View>
          <View style={styles.contributorTextBlock}>
            <Text style={styles.contributorLabel}>Signed in contributor</Text>
            <Text numberOfLines={1} style={styles.contributorName}>{contributorName}</Text>
            {contributorEmail ? (
              <Text numberOfLines={1} style={styles.contributorEmail}>{contributorEmail}</Text>
            ) : null}
          </View>
          <TouchableOpacity
            activeOpacity={0.85}
            disabled={isRecording || isUploading || isSigningOut}
            onPress={onSignOut}
            style={[styles.signOutButton, (isRecording || isUploading || isSigningOut) && styles.buttonDisabled]}
          >
            {isSigningOut ? (
              <ActivityIndicator size="small" color="#E2E8F0" />
            ) : (
              <Ionicons name="log-out-outline" size={18} color="#E2E8F0" />
            )}
          </TouchableOpacity>
        </View>

        <View style={styles.previewFrame}>
          <CameraView
            ref={cameraRef}
            style={styles.camera}
            facing="back"
            mode="video"
            videoQuality="480p"
          />
          <View style={styles.recordingBadge}>
            <View style={[styles.recordingDot, isRecording && styles.recordingDotActive]} />
            <Text style={styles.recordingText}>{isRecording ? 'Recording' : 'Ready'}</Text>
          </View>
        </View>

        <View
          style={styles.formPanel}
          onLayout={(event) => {
            locationInputY.current = event.nativeEvent.layout.y;
          }}
        >
          <TextInput
            value={locationName}
            onChangeText={setLocationName}
            onFocus={scrollToLocationInput}
            placeholder="Location name *"
            placeholderTextColor="#64748B"
            style={styles.input}
          />
        </View>

        <View style={styles.metricsRow}>
          <View style={styles.metricPill}>
            <Text style={styles.metricLabel}>Duration</Text>
            <Text style={styles.metricValue}>{formatDuration(elapsedMillis)}</Text>
          </View>
          <View style={styles.metricPill}>
            <Text style={styles.metricLabel}>Coordinates</Text>
            <Text numberOfLines={1} style={styles.metricValue}>
              {sessionDraft?.latitude && sessionDraft.longitude
                ? `${sessionDraft.latitude.toFixed(5)}, ${sessionDraft.longitude.toFixed(5)}`
                : 'pending'}
            </Text>
          </View>
        </View>

        {(isUploading || uploadProgress) ? (
          <View style={styles.uploadProgressPanel}>
            <View style={styles.uploadProgressHeader}>
              <Text style={styles.uploadProgressTitle}>
                {isUploading
                  ? uploadProgress?.totalBytes
                    ? `Uploading ${uploadProgress.percent}%`
                    : 'Preparing upload'
                  : uploadProgress?.percent === 100
                    ? 'Upload complete'
                    : 'Upload stopped'}
              </Text>
              <Text style={styles.uploadProgressBytes}>
                {uploadProgress
                  ? `${formatBytes(uploadProgress.sentBytes)}${
                      uploadProgress.totalBytes > 0 ? ` / ${formatBytes(uploadProgress.totalBytes)}` : ''
                    }`
                  : '0 B'}
              </Text>
            </View>
            <View style={styles.progressTrack}>
              <View style={[styles.progressFill, { width: `${uploadProgress?.percent ?? 0}%` }]} />
            </View>
          </View>
        ) : null}

        <View style={styles.actionsRow}>
          <TouchableOpacity
            activeOpacity={0.85}
            disabled={isUploading || isStopping}
            onPress={isRecording ? stopSession : startSession}
            style={[styles.primaryButton, isRecording && styles.stopButton, isUploading && styles.buttonDisabled]}
          >
            {isStopping ? (
              <ActivityIndicator size="small" color="#FFFFFF" />
            ) : (
              <Ionicons name={isRecording ? 'stop' : 'videocam-outline'} size={18} color="#FFFFFF" />
            )}
            <Text style={styles.primaryButtonText}>
              {isStopping ? 'Stopping...' : isRecording ? 'Stop session' : 'Start session'}
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            activeOpacity={0.85}
            disabled={!videoUri || isRecording || isUploading}
            onPress={uploadSession}
            style={[styles.secondaryButton, (!videoUri || isRecording || isUploading) && styles.buttonDisabled]}
          >
            {isUploading ? (
              <ActivityIndicator size="small" color="#0F172A" />
            ) : (
              <Ionicons name="cloud-upload-outline" size={18} color="#0F172A" />
            )}
            <Text style={styles.secondaryButtonText}>
              {isUploading ? `${uploadProgress?.percent ?? 0}%` : 'Upload'}
            </Text>
          </TouchableOpacity>
        </View>

        {errorMessage ? (
          <View style={styles.errorBox}>
            <Text style={styles.messageTitle}>Error</Text>
            <Text style={styles.messageBody}>{errorMessage}</Text>
          </View>
        ) : null}

        {successMessage ? (
          <View style={styles.messageBox}>
            <Text style={styles.messageTitle}>Status</Text>
            <Text style={styles.messageBody}>{successMessage}</Text>
          </View>
        ) : null}

        <View style={styles.sessionsPanel}>
          <Text style={styles.panelLabel}>Recent Convex sessions</Text>
          {!convexAuth.isAuthenticated ? (
            <Text style={styles.emptyText}>Contributor session is not connected to Convex.</Text>
          ) : recentSessions === undefined ? (
            <ActivityIndicator size="small" color="#38BDF8" />
          ) : recentSessions.length === 0 ? (
            <Text style={styles.emptyText}>No sessions uploaded yet.</Text>
          ) : (
            recentSessions.map((session) => {
              const contributorLabel =
                session.contributorUsername ?? session.contributorName ?? session.contributorEmail ?? 'Unknown contributor';
              const contributorDetail =
                session.contributorEmail && session.contributorEmail !== contributorLabel
                  ? session.contributorEmail
                  : session.contributorClerkUserId;

              return (
                <View key={session._id} style={styles.sessionRow}>
                  <View style={styles.sessionInfo}>
                    <Text style={styles.sessionTitle}>{session.locationName || session.sessionId}</Text>
                    <Text numberOfLines={1} style={styles.sessionContributor}>
                      {contributorDetail ? `${contributorLabel} · ${contributorDetail}` : contributorLabel}
                    </Text>
                    <Text style={styles.sessionMeta}>{formatDuration(session.durationMillis)} · {session.device}</Text>
                  </View>
                  <Text style={styles.sessionDate}>{new Date(session.createdAt).toLocaleDateString()}</Text>
                </View>
              );
            })
          )}
        </View>
        </ScrollView>
      </TouchableWithoutFeedback>
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
  centeredScreen: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
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
  loadingText: {
    color: '#CBD5E1',
    fontSize: 14,
    fontWeight: '600',
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
  contributorCard: {
    minHeight: 72,
    borderRadius: 8,
    backgroundColor: '#0B1220',
    borderWidth: 1,
    borderColor: 'rgba(56, 189, 248, 0.22)',
    padding: 12,
    marginBottom: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  contributorIcon: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(56, 189, 248, 0.12)',
  },
  contributorTextBlock: {
    flex: 1,
    minWidth: 0,
  },
  contributorLabel: {
    color: '#64748B',
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    marginBottom: 3,
  },
  contributorName: {
    color: '#F8FAFC',
    fontSize: 15,
    fontWeight: '700',
  },
  contributorEmail: {
    color: '#94A3B8',
    fontSize: 12,
    marginTop: 2,
  },
  signOutButton: {
    width: 42,
    height: 42,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#111827',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  previewFrame: {
    height: 360,
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: '#111827',
    marginBottom: 16,
  },
  camera: {
    flex: 1,
  },
  recordingBadge: {
    position: 'absolute',
    top: 12,
    left: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(15, 23, 42, 0.78)',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  recordingDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#64748B',
  },
  recordingDotActive: {
    backgroundColor: '#EF4444',
  },
  recordingText: {
    color: '#F8FAFC',
    fontSize: 13,
    fontWeight: '700',
  },
  formPanel: {
    gap: 10,
    marginBottom: 14,
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
  metricsRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 14,
  },
  metricPill: {
    flex: 1,
    borderRadius: 8,
    backgroundColor: '#0B1220',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    padding: 12,
  },
  metricLabel: {
    color: '#64748B',
    fontSize: 11,
    textTransform: 'uppercase',
    marginBottom: 4,
  },
  metricValue: {
    color: '#E2E8F0',
    fontSize: 14,
    fontWeight: '700',
  },
  actionsRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 14,
  },
  primaryButton: {
    flex: 1,
    minHeight: 52,
    borderRadius: 8,
    backgroundColor: '#0EA5E9',
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  stopButton: {
    backgroundColor: '#DC2626',
  },
  primaryButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
  },
  secondaryButton: {
    minHeight: 52,
    borderRadius: 8,
    backgroundColor: '#38BDF8',
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 18,
  },
  secondaryButtonText: {
    color: '#0F172A',
    fontSize: 14,
    fontWeight: '700',
  },
  buttonDisabled: {
    opacity: 0.45,
  },
  uploadProgressPanel: {
    borderRadius: 8,
    backgroundColor: '#0B1220',
    borderWidth: 1,
    borderColor: 'rgba(56, 189, 248, 0.28)',
    padding: 14,
    marginBottom: 14,
  },
  uploadProgressHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
    marginBottom: 10,
  },
  uploadProgressTitle: {
    color: '#E0F2FE',
    fontSize: 14,
    fontWeight: '700',
  },
  uploadProgressBytes: {
    color: '#94A3B8',
    fontSize: 12,
    fontWeight: '600',
  },
  progressTrack: {
    height: 8,
    borderRadius: 999,
    backgroundColor: '#1E293B',
    overflow: 'hidden',
  },
  progressFill: {
    height: 8,
    borderRadius: 999,
    backgroundColor: '#38BDF8',
  },
  messageBox: {
    borderRadius: 8,
    backgroundColor: 'rgba(14, 116, 144, 0.28)',
    borderWidth: 1,
    borderColor: 'rgba(56, 189, 248, 0.35)',
    padding: 14,
    marginBottom: 14,
  },
  errorBox: {
    borderRadius: 8,
    backgroundColor: 'rgba(127, 29, 29, 0.35)',
    borderWidth: 1,
    borderColor: 'rgba(248, 113, 113, 0.4)',
    padding: 14,
    marginBottom: 14,
  },
  messageTitle: {
    color: '#F8FAFC',
    fontSize: 13,
    fontWeight: '700',
    marginBottom: 4,
  },
  messageBody: {
    color: '#D8E1F2',
    fontSize: 14,
    lineHeight: 20,
  },
  sessionsPanel: {
    borderRadius: 8,
    backgroundColor: '#0B1220',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    padding: 14,
  },
  panelLabel: {
    color: '#E2E8F0',
    fontSize: 13,
    fontWeight: '700',
    marginBottom: 10,
    textTransform: 'uppercase',
  },
  emptyText: {
    color: '#94A3B8',
    fontSize: 14,
  },
  sessionRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.06)',
  },
  sessionInfo: {
    flex: 1,
    minWidth: 0,
  },
  sessionTitle: {
    color: '#F8FAFC',
    fontSize: 14,
    fontWeight: '700',
  },
  sessionContributor: {
    color: '#CBD5E1',
    fontSize: 12,
    marginTop: 3,
  },
  sessionMeta: {
    color: '#94A3B8',
    fontSize: 12,
    marginTop: 3,
  },
  sessionDate: {
    color: '#64748B',
    fontSize: 12,
  },
});
