import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth, useUser } from '@clerk/clerk-expo';
import { StatusBar } from 'expo-status-bar';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { CameraView, useCameraPermissions, useMicrophonePermissions } from 'expo-camera';
import * as Device from 'expo-device';
import * as FileSystem from 'expo-file-system/legacy';
import * as Location from 'expo-location';
import * as SecureStore from 'expo-secure-store';
import { useConvexAuth, useMutation, useQuery } from 'convex/react';

import { BottomNav, BOTTOM_NAV_HEIGHT } from '@/components/BottomNav';
import { api } from '@/convex/_generated/api';
import type { Id } from '@/convex/_generated/dataModel';

const CONVEX_URL = process.env.EXPO_PUBLIC_CONVEX_URL;
const CLERK_PUBLISHABLE_KEY = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY;
const MAX_SESSION_SECONDS = 20 * 60;
const COLLECTION_VIDEO_BITRATE = 500_000;
const MAX_UPLOAD_BYTES = 150 * 1024 * 1024;
const UPLOAD_TIMEOUT_MS = 5 * 60 * 1000;
const COLLECTION_CONSENT_KEY = 'carzam_collection_consent_v1';
const PENDING_SESSIONS_FOLDER = 'carzam-sessions';
const PENDING_SESSIONS_MANIFEST = 'pending-sessions.json';
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

type PendingUploadStatus = 'pending' | 'uploading' | 'failed';

type PendingSession = SessionDraft & {
  videoUri: string;
  fileName: string;
  fileType: string;
  device: string;
  fileSizeBytes?: number;
  savedAt: string;
  status: PendingUploadStatus;
  lastError?: string;
};

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMillis: number,
  message: string,
  onTimeout?: () => void,
) {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      onTimeout?.();
      reject(new Error(message));
    }, timeoutMillis);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

type CollectScreenContentProps = {
  contributorName: string;
  contributorEmail?: string;
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

function getRecordingExtension(recordingUri: string) {
  const uriWithoutQuery = recordingUri.split('?')[0];
  const extension = uriWithoutQuery.match(/\.([a-zA-Z0-9]+)$/)?.[1]?.toLowerCase();

  return extension === 'mp4' || extension === 'mov' ? extension : 'mov';
}

function getVideoFileName(sessionId: string, extension: 'mp4' | 'mov') {
  return `${sessionId}.${extension}`;
}

function getVideoFileType(extension: 'mp4' | 'mov') {
  return extension === 'mp4' ? 'video/mp4' : 'video/quicktime';
}

function getPendingSessionsDirectory() {
  if (!FileSystem.documentDirectory) {
    throw new Error('Local document storage is not available on this device.');
  }

  return `${FileSystem.documentDirectory}${PENDING_SESSIONS_FOLDER}/`;
}

function getPendingSessionsManifestUri() {
  return `${getPendingSessionsDirectory()}${PENDING_SESSIONS_MANIFEST}`;
}

async function ensurePendingSessionsDirectory() {
  const directory = getPendingSessionsDirectory();
  const directoryInfo = await FileSystem.getInfoAsync(directory);

  if (!directoryInfo.exists) {
    await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
  }

  return directory;
}

function isPendingUploadStatus(value: unknown): value is PendingUploadStatus {
  return value === 'pending' || value === 'uploading' || value === 'failed';
}

function parsePendingSession(value: unknown): PendingSession | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = value as Record<string, unknown>;
  if (
    typeof record.sessionId !== 'string' ||
    typeof record.videoUri !== 'string' ||
    typeof record.fileName !== 'string' ||
    typeof record.fileType !== 'string' ||
    typeof record.device !== 'string' ||
    typeof record.startedAt !== 'string' ||
    typeof record.endedAt !== 'string' ||
    typeof record.durationMillis !== 'number' ||
    typeof record.savedAt !== 'string'
  ) {
    return null;
  }

  return {
    sessionId: record.sessionId,
    videoUri: record.videoUri,
    fileName: record.fileName,
    fileType: record.fileType,
    device: record.device,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    durationMillis: record.durationMillis,
    savedAt: record.savedAt,
    status: isPendingUploadStatus(record.status) && record.status !== 'uploading' ? record.status : 'pending',
    latitude: typeof record.latitude === 'number' ? record.latitude : undefined,
    longitude: typeof record.longitude === 'number' ? record.longitude : undefined,
    locationAccuracy: typeof record.locationAccuracy === 'number' ? record.locationAccuracy : undefined,
    fileSizeBytes: typeof record.fileSizeBytes === 'number' ? record.fileSizeBytes : undefined,
    lastError: typeof record.lastError === 'string' ? record.lastError : undefined,
  };
}

async function readPendingSessionsManifest() {
  try {
    await ensurePendingSessionsDirectory();
    const manifestUri = getPendingSessionsManifestUri();
    const manifestInfo = await FileSystem.getInfoAsync(manifestUri);

    if (!manifestInfo.exists) {
      return [];
    }

    const manifest = await FileSystem.readAsStringAsync(manifestUri);
    const parsed = JSON.parse(manifest) as unknown;

    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.map(parsePendingSession).filter((session): session is PendingSession => session !== null);
  } catch {
    return [];
  }
}

async function writePendingSessionsManifest(sessions: PendingSession[]) {
  await ensurePendingSessionsDirectory();
  await FileSystem.writeAsStringAsync(getPendingSessionsManifestUri(), JSON.stringify(sessions, null, 2));
}

function getDeviceLabel() {
  const model = Device.modelName ?? Device.modelId ?? Device.productName ?? Device.designName ?? 'Unknown device';
  const maker = Device.manufacturer ?? Device.brand;
  const os = [Device.osName, Device.osVersion].filter(Boolean).join(' ');

  return [maker, model, os].filter(Boolean).join(' · ');
}

function getSessionDisplayName(session: { startedAt?: string; sessionId: string }) {
  const timestamp = session.startedAt ? new Date(session.startedAt) : null;

  if (timestamp && Number.isFinite(timestamp.getTime())) {
    return `Session ${timestamp.toLocaleDateString([], { day: '2-digit', month: 'short' })}, ${timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  }

  return session.sessionId;
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
  const { user } = useUser();
  const contributorEmail = user?.primaryEmailAddress?.emailAddress;
  const contributorName = user?.fullName ?? contributorEmail ?? 'Contributor';

  useEffect(() => {
    if (isLoaded && !userId) {
      router.replace('/account');
    }
  }, [isLoaded, userId]);

  if (!isLoaded) {
    return <LoadingScreen title="Checking contributor session" />;
  }

  if (!userId) {
    return <LoadingScreen title="Opening account" />;
  }

  return <CollectScreenContent contributorName={contributorName} contributorEmail={contributorEmail} />;
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

function CollectScreenContent({ contributorName, contributorEmail }: CollectScreenContentProps) {
  const insets = useSafeAreaInsets();
  const convexAuth = useConvexAuth();
  const scrollViewRef = useRef<ScrollView>(null);
  const cameraRef = useRef<CameraView>(null);
  const hasAutoRequestedMediaPermissions = useRef(false);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [microphonePermission, requestMicrophonePermission] = useMicrophonePermissions();
  const generateUploadUrl = useMutation(api.dataset.generateUploadUrl);
  const createSession = useMutation(api.dataset.createSession);
  const recentSessions = useQuery(api.dataset.listRecentSessions, convexAuth.isAuthenticated ? {} : 'skip');
  const [sessionDraft, setSessionDraft] = useState<SessionDraft | null>(null);
  const pendingSessionsRef = useRef<PendingSession[]>([]);
  const [pendingSessions, setPendingSessions] = useState<PendingSession[]>([]);
  const [isPendingSessionsLoaded, setIsPendingSessionsLoaded] = useState(false);
  const [elapsedMillis, setElapsedMillis] = useState(0);
  const [isRecording, setIsRecording] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [isUploadingAll, setIsUploadingAll] = useState(false);
  const [activeUploadSessionId, setActiveUploadSessionId] = useState<string | null>(null);
  const [isRequestingMediaPermissions, setIsRequestingMediaPermissions] = useState(false);
  const [hasAcceptedCollectionConsent, setHasAcceptedCollectionConsent] = useState(false);
  const [isConsentLoaded, setIsConsentLoaded] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null);
  const [uploadPhase, setUploadPhase] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const hasCameraAccess = cameraPermission?.granted ?? false;
  const hasMicrophoneAccess = microphonePermission?.granted ?? false;
  const mediaPermissionsLoaded = cameraPermission !== null && microphonePermission !== null;
  const hasMediaAccess = hasCameraAccess && hasMicrophoneAccess;
  const canStartSession =
    hasMediaAccess &&
    hasAcceptedCollectionConsent &&
    isPendingSessionsLoaded &&
    !isUploading &&
    !isUploadingAll &&
    !isStopping;

  const uploadablePendingSessions = pendingSessions.filter((session) => session.status !== 'uploading');

  useEffect(() => {
    pendingSessionsRef.current = pendingSessions;
  }, [pendingSessions]);

  useEffect(() => {
    let isMounted = true;

    readPendingSessionsManifest()
      .then((storedSessions) => {
        if (isMounted) {
          setPendingSessions(storedSessions);
        }
      })
      .catch((error) => {
        if (isMounted) {
          const message = error instanceof Error ? error.message : 'Unable to load saved recordings.';
          setErrorMessage(message);
        }
      })
      .finally(() => {
        if (isMounted) {
          setIsPendingSessionsLoaded(true);
        }
      });

    return () => {
      isMounted = false;
    };
  }, []);

  const persistPendingSessions = useCallback(async (nextSessions: PendingSession[]) => {
    await writePendingSessionsManifest(nextSessions);
    pendingSessionsRef.current = nextSessions;
    setPendingSessions(nextSessions);
  }, []);

  const updatePendingSession = useCallback(
    async (sessionId: string, updates: Partial<PendingSession>) => {
      const nextSessions = pendingSessionsRef.current.map((session) =>
        session.sessionId === sessionId ? { ...session, ...updates } : session,
      );
      await persistPendingSessions(nextSessions);
    },
    [persistPendingSessions],
  );

  const deletePendingSession = useCallback(
    async (pendingSession: PendingSession) => {
      try {
        setErrorMessage(null);
        setSuccessMessage(null);

        await FileSystem.deleteAsync(pendingSession.videoUri, { idempotent: true });
        await persistPendingSessions(
          pendingSessionsRef.current.filter((session) => session.sessionId !== pendingSession.sessionId),
        );
        setSuccessMessage('Pending recording deleted from this device.');
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unable to delete pending recording.';
        setErrorMessage(message);
      }
    },
    [persistPendingSessions],
  );

  const confirmDeletePendingSession = useCallback(
    (pendingSession: PendingSession) => {
      if (activeUploadSessionId === pendingSession.sessionId) {
        setErrorMessage('Wait for the current upload to finish before deleting this recording.');
        return;
      }

      Alert.alert(
        'Delete pending recording?',
        'This removes the local video from this device. It cannot be uploaded later.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Delete',
            style: 'destructive',
            onPress: () => {
              void deletePendingSession(pendingSession);
            },
          },
        ],
      );
    },
    [activeUploadSessionId, deletePendingSession],
  );

  useEffect(() => {
    let isMounted = true;

    SecureStore.getItemAsync(COLLECTION_CONSENT_KEY)
      .then((storedConsent) => {
        if (isMounted) {
          setHasAcceptedCollectionConsent(storedConsent === 'accepted');
        }
      })
      .finally(() => {
        if (isMounted) {
          setIsConsentLoaded(true);
        }
      });

    return () => {
      isMounted = false;
    };
  }, []);

  const acceptCollectionConsent = async () => {
    setHasAcceptedCollectionConsent(true);
    await SecureStore.setItemAsync(COLLECTION_CONSENT_KEY, 'accepted');
  };

  const requestMediaPermissions = useCallback(async () => {
    if (isRequestingMediaPermissions) {
      return;
    }

    try {
      setIsRequestingMediaPermissions(true);
      setErrorMessage(null);
      const nextCamera = hasCameraAccess ? cameraPermission : await requestCameraPermission();
      const nextMicrophone = hasMicrophoneAccess ? microphonePermission : await requestMicrophonePermission();

      if (!nextCamera?.granted) {
        setErrorMessage('Camera permission is required to record dataset sessions.');
        return;
      }

      if (!nextMicrophone?.granted) {
        setErrorMessage('Microphone permission is required to record dataset sessions.');
      }
    } finally {
      setIsRequestingMediaPermissions(false);
    }
  }, [
    cameraPermission,
    hasCameraAccess,
    hasMicrophoneAccess,
    isRequestingMediaPermissions,
    microphonePermission,
    requestCameraPermission,
    requestMicrophonePermission,
  ]);

  useEffect(() => {
    if (mediaPermissionsLoaded && !hasMediaAccess && !hasAutoRequestedMediaPermissions.current) {
      hasAutoRequestedMediaPermissions.current = true;
      void requestMediaPermissions();
    }
  }, [mediaPermissionsLoaded, hasMediaAccess, requestMediaPermissions]);

  const ensureMediaPermissions = async () => {
    const nextCamera = hasCameraAccess ? cameraPermission : await requestCameraPermission();
    const nextMicrophone = hasMicrophoneAccess ? microphonePermission : await requestMicrophonePermission();

    if (!nextCamera?.granted) {
      return 'Camera permission is required to record dataset sessions.';
    }

    if (!nextMicrophone?.granted) {
      return 'Microphone permission is required to record dataset sessions.';
    }

    return null;
  };

  const getOptionalRecordingLocation = async () => {
    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (!permission.granted) {
        return null;
      }

      return await Location.getCurrentPositionAsync({});
    } catch {
      return null;
    }
  };

  const saveRecordingToOutbox = useCallback(
    async (recordingUri: string, draft: SessionDraft) => {
      const sourceInfo = await FileSystem.getInfoAsync(recordingUri);

      if (!sourceInfo.exists) {
        throw new Error('Recording stopped, but the local video file could not be found.');
      }

      const directory = await ensurePendingSessionsDirectory();
      const extension = getRecordingExtension(recordingUri);
      const fileName = getVideoFileName(draft.sessionId, extension);
      const persistentUri = `${directory}${fileName}`;
      const existingPersistentFile = await FileSystem.getInfoAsync(persistentUri);

      if (existingPersistentFile.exists) {
        await FileSystem.deleteAsync(persistentUri, { idempotent: true });
      }

      await FileSystem.copyAsync({
        from: recordingUri,
        to: persistentUri,
      });

      const persistedInfo = await FileSystem.getInfoAsync(persistentUri);
      if (!persistedInfo.exists) {
        throw new Error('Recording could not be saved to local app storage.');
      }

      const fileSizeBytes = 'size' in persistedInfo && typeof persistedInfo.size === 'number'
        ? persistedInfo.size
        : undefined;
      const pendingSession: PendingSession = {
        ...draft,
        videoUri: persistentUri,
        fileName,
        fileType: getVideoFileType(extension),
        device: getDeviceLabel(),
        fileSizeBytes,
        savedAt: new Date().toISOString(),
        status: 'pending',
      };
      const nextSessions = [
        pendingSession,
        ...pendingSessionsRef.current.filter((session) => session.sessionId !== pendingSession.sessionId),
      ];

      await persistPendingSessions(nextSessions);

      if (recordingUri !== persistentUri) {
        await FileSystem.deleteAsync(recordingUri, { idempotent: true });
      }

      return pendingSession;
    },
    [persistPendingSessions],
  );

  const startSession = async () => {
    if (isRecording || isUploading || isUploadingAll) {
      return;
    }

    if (!hasAcceptedCollectionConsent) {
      setErrorMessage('Review and accept the data collection notice before recording.');
      return;
    }

    let elapsedTimer: ReturnType<typeof setInterval> | null = null;

    try {
      setErrorMessage(null);
      setSuccessMessage(null);
      setUploadProgress(null);
      setUploadPhase(null);
      setSessionDraft(null);
      setElapsedMillis(0);

      const permissionError = await ensureMediaPermissions();
      if (permissionError) {
        setErrorMessage(permissionError);
        return;
      }

      const startedAtDate = new Date();
      const startedAtMs = startedAtDate.getTime();
      const sessionId = makeSessionId();

      setIsRecording(true);
      setIsStopping(false);
      elapsedTimer = setInterval(() => {
        setElapsedMillis(Date.now() - startedAtMs);
      }, 500);

      const recordingPromise = cameraRef.current?.recordAsync({
        maxDuration: MAX_SESSION_SECONDS,
        ...(Platform.OS === 'ios' ? { codec: 'avc1' as const } : {}),
      });
      const locationPromise = getOptionalRecordingLocation();
      const recording = await recordingPromise;
      const endedAtDate = new Date();
      clearInterval(elapsedTimer);
      elapsedTimer = null;

      if (!recording?.uri) {
        setErrorMessage('Recording stopped, but no video file was created.');
        return;
      }

      const location = await locationPromise;
      const draft = {
        sessionId,
        startedAt: startedAtDate.toISOString(),
        endedAt: endedAtDate.toISOString(),
        durationMillis: endedAtDate.getTime() - startedAtMs,
        latitude: location?.coords.latitude,
        longitude: location?.coords.longitude,
        locationAccuracy: location?.coords.accuracy ?? undefined,
      };

      await saveRecordingToOutbox(recording.uri, draft);
      setElapsedMillis(draft.durationMillis);
      setSessionDraft(draft);
      setSuccessMessage('Session saved locally. Upload it when the network is stable.');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to record dataset session.';
      setErrorMessage(message);
    } finally {
      if (elapsedTimer) {
        clearInterval(elapsedTimer);
      }

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

  const uploadPendingSession = useCallback(async (pendingSession: PendingSession) => {
    try {
      setErrorMessage(null);
      setSuccessMessage(null);

      if (convexAuth.isLoading) {
        setErrorMessage('Still connecting your contributor account to Convex. Try again in a moment.');
        return;
      }

      if (!convexAuth.isAuthenticated) {
        setErrorMessage(CONVEX_AUTH_SETUP_MESSAGE);
        return;
      }

      setIsUploading(true);
      setActiveUploadSessionId(pendingSession.sessionId);
      setUploadProgress({ sentBytes: 0, totalBytes: 0, percent: 0 });
      setUploadPhase('Preparing upload');
      await updatePendingSession(pendingSession.sessionId, { status: 'uploading', lastError: undefined });

      const fileInfo = await FileSystem.getInfoAsync(pendingSession.videoUri);
      if (!fileInfo.exists) {
        throw new Error('The local video file is missing. The recording may have been removed from this device.');
      }

      const fileSizeBytes = 'size' in fileInfo && typeof fileInfo.size === 'number'
        ? fileInfo.size
        : pendingSession.fileSizeBytes;
      if (fileSizeBytes !== undefined && fileSizeBytes > MAX_UPLOAD_BYTES) {
        throw new Error(
          `This recording is too large to upload (${formatBytes(fileSizeBytes)}). The current upload limit is ${formatBytes(MAX_UPLOAD_BYTES)}. Record again with the new low-bitrate settings.`,
        );
      }

      setUploadProgress({
        sentBytes: 0,
        totalBytes: fileSizeBytes ?? 0,
        percent: 0,
      });
      const uploadUrl = await withTimeout(
        generateUploadUrl(),
        UPLOAD_TIMEOUT_MS,
        'Upload timed out while preparing Convex storage. Check your connection and try again.',
      );
      setUploadPhase('Uploading recording');
      const uploadTask = FileSystem.createUploadTask(uploadUrl, pendingSession.videoUri, {
        httpMethod: 'POST',
        uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
        headers: {
          'Content-Type': pendingSession.fileType,
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
        setUploadPhase(totalBytes > 0 ? `Uploading ${percent}%` : 'Uploading recording');
      });
      const uploadResponse = await withTimeout(
        uploadTask.uploadAsync(),
        UPLOAD_TIMEOUT_MS,
        'Upload timed out. Check your connection and try again.',
        () => {
          void uploadTask.cancelAsync().catch(() => {});
        },
      );

      if (!uploadResponse) {
        throw new Error('Convex storage upload did not return a response.');
      }

      if (uploadResponse.status < 200 || uploadResponse.status >= 300) {
        throw new Error(`Convex storage upload failed with status ${uploadResponse.status}.`);
      }

      const { storageId } = JSON.parse(uploadResponse.body) as { storageId: string };
      if (!storageId) {
        throw new Error('Convex storage upload did not return a storage ID.');
      }

      setUploadPhase('Saving session metadata');
      await withTimeout(
        createSession({
          sessionId: pendingSession.sessionId,
          startedAt: pendingSession.startedAt,
          endedAt: pendingSession.endedAt,
          durationMillis: pendingSession.durationMillis,
          latitude: pendingSession.latitude,
          longitude: pendingSession.longitude,
          locationAccuracy: pendingSession.locationAccuracy,
          storageId: storageId as Id<'_storage'>,
          fileName: pendingSession.fileName,
          fileType: pendingSession.fileType,
          device: pendingSession.device,
          fileSizeBytes,
          uploadedAt: Date.now(),
        }),
        UPLOAD_TIMEOUT_MS,
        'Upload timed out while saving session metadata. Check your connection and try again.',
      );

      setUploadProgress({ sentBytes: fileSizeBytes ?? 0, totalBytes: fileSizeBytes ?? 0, percent: 100 });
      setUploadPhase('Upload complete');
      await persistPendingSessions(
        pendingSessionsRef.current.filter((session) => session.sessionId !== pendingSession.sessionId),
      );

      try {
        await FileSystem.deleteAsync(pendingSession.videoUri, { idempotent: true });
      } catch {
        // Upload is already durable in Convex; local cleanup can fail without blocking the user.
      }

      setSuccessMessage('Dataset session uploaded to Convex.');
      setElapsedMillis(0);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to upload dataset session.';
      await updatePendingSession(pendingSession.sessionId, { status: 'failed', lastError: message });
      setErrorMessage(message);
      return false;
    } finally {
      setIsUploading(false);
      setActiveUploadSessionId(null);
      setUploadPhase(null);
    }
  }, [
    convexAuth.isAuthenticated,
    convexAuth.isLoading,
    createSession,
    generateUploadUrl,
    persistPendingSessions,
    updatePendingSession,
  ]);

  const uploadAllPendingSessions = async () => {
    if (isUploading || isUploadingAll) {
      return;
    }

    const sessionsToUpload = pendingSessionsRef.current.filter((session) => session.status !== 'uploading');
    if (sessionsToUpload.length === 0) {
      return;
    }

    setIsUploadingAll(true);
    let uploadedCount = 0;
    let failedCount = 0;

    try {
      for (const pendingSession of sessionsToUpload) {
        const wasUploaded = await uploadPendingSession(pendingSession);

        if (wasUploaded) {
          uploadedCount += 1;
        } else {
          failedCount += 1;
        }
      }

      if (uploadedCount > 0) {
        setSuccessMessage(`${uploadedCount} saved session${uploadedCount === 1 ? '' : 's'} uploaded to Convex.`);
      }

      if (failedCount > 0) {
        const failedSession = pendingSessionsRef.current.find((session) => session.status === 'failed');
        setErrorMessage(
          failedSession?.lastError ??
            `${failedCount} saved session${failedCount === 1 ? '' : 's'} could not be uploaded. Retry later.`,
        );
      }
    } finally {
      setIsUploadingAll(false);
    }
  };

  return (
    <View style={[styles.safeArea, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <StatusBar style="light" />
      <ScrollView
        ref={scrollViewRef}
        contentContainerStyle={[
          styles.screen,
          { paddingBottom: BOTTOM_NAV_HEIGHT + Math.max(insets.bottom, 10) + 140 },
        ]}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      >
          <View style={styles.header}>
            <Text style={styles.heading}>Collect dataset</Text>
            <Text style={styles.subtitle}>Record continuous 20-minute low-bitrate sessions. Annotate the vehicles later.</Text>
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
        </View>

        <View style={styles.previewFrame}>
          {hasMediaAccess ? (
            <CameraView
              ref={cameraRef}
              style={styles.camera}
              facing="back"
              mode="video"
              videoBitrate={COLLECTION_VIDEO_BITRATE}
              videoQuality="4:3"
            />
          ) : (
            <View style={styles.cameraPlaceholder}>
              <Ionicons name="camera-outline" size={34} color="#38BDF8" />
              <Text style={styles.cameraPlaceholderTitle}>Camera permission needed</Text>
              <Text style={styles.cameraPlaceholderBody}>Enable camera and microphone access to preview and record.</Text>
              <TouchableOpacity
                activeOpacity={0.85}
                disabled={isRequestingMediaPermissions}
                onPress={requestMediaPermissions}
                style={[styles.permissionButton, isRequestingMediaPermissions && styles.buttonDisabled]}
              >
                {isRequestingMediaPermissions ? (
                  <ActivityIndicator size="small" color="#0F172A" />
                ) : (
                  <Ionicons name="shield-checkmark-outline" size={18} color="#0F172A" />
                )}
                <Text style={styles.permissionButtonText}>
                  {isRequestingMediaPermissions ? 'Requesting...' : 'Enable camera'}
                </Text>
              </TouchableOpacity>
            </View>
          )}
          <View style={styles.recordingBadge}>
            <View style={[styles.recordingDot, isRecording && styles.recordingDotActive]} />
            <Text style={styles.recordingText}>{isRecording ? 'Recording' : hasMediaAccess ? 'Ready' : 'Permission needed'}</Text>
          </View>
        </View>

        {!hasAcceptedCollectionConsent ? (
          <View style={styles.guidanceCard}>
            <View style={styles.guidanceHeader}>
              <View style={styles.guidanceIcon}>
                <Ionicons name="shield-checkmark-outline" size={18} color="#38BDF8" />
              </View>
              <View style={styles.guidanceTextBlock}>
                <Text style={styles.guidanceTitle}>Collection notice</Text>
                <Text style={styles.guidanceBody}>
                  CarZam collects traffic video and audio to build an academic vehicle sound dataset and improve vehicle sound classification.
                </Text>
              </View>
            </View>
            <View style={styles.guidanceList}>
              <Text style={styles.guidanceItem}>Collected data: video, audio, approximate GPS coordinates, GPS accuracy, timestamps, duration, file size, device information, and your contributor account.</Text>
              <Text style={styles.guidanceItem}>Purpose: dataset collection, manual annotation, model evaluation, and improving the vehicle classifier.</Text>
              <Text style={styles.guidanceItem}>Privacy: avoid filming faces, private spaces, sensitive locations, and license plates when possible.</Text>
              <Text style={styles.guidanceItem}>Control: completed recordings stay pending on this device until you upload them, and you can delete pending recordings before upload.</Text>
            </View>
            <TouchableOpacity
              activeOpacity={0.85}
              disabled={!isConsentLoaded}
              onPress={acceptCollectionConsent}
              style={[styles.consentButton, !isConsentLoaded && styles.buttonDisabled]}
            >
              <Ionicons name="ellipse-outline" size={18} color="#0F172A" />
              <Text style={styles.consentButtonText}>I understand and agree</Text>
            </TouchableOpacity>
          </View>
        ) : null}

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
                {uploadPhase ??
                  (isUploading
                    ? uploadProgress?.totalBytes
                      ? `Uploading ${uploadProgress.percent}%`
                      : 'Preparing upload'
                    : uploadProgress?.percent === 100
                      ? 'Upload complete'
                      : 'Upload stopped')}
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
            disabled={isRecording ? isStopping : !canStartSession}
            onPress={isRecording ? stopSession : startSession}
            style={[
              styles.primaryButton,
              isRecording && styles.stopButton,
              !isRecording && !canStartSession && styles.buttonDisabled,
            ]}
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
          <View style={styles.panelHeaderRow}>
            <Text style={[styles.panelLabel, styles.panelLabelInHeader]}>Pending uploads</Text>
            {uploadablePendingSessions.length > 0 ? (
              <TouchableOpacity
                activeOpacity={0.85}
                disabled={isUploading || isUploadingAll || isRecording}
                onPress={uploadAllPendingSessions}
                style={[
                  styles.uploadAllButton,
                  (isUploading || isUploadingAll || isRecording) && styles.buttonDisabled,
                ]}
              >
                {isUploadingAll ? (
                  <ActivityIndicator size="small" color="#0F172A" />
                ) : (
                  <Ionicons name="cloud-upload-outline" size={15} color="#0F172A" />
                )}
                <Text style={styles.uploadAllButtonText}>
                  {isUploadingAll ? 'Uploading...' : `Upload all (${uploadablePendingSessions.length})`}
                </Text>
              </TouchableOpacity>
            ) : null}
          </View>
          {!isPendingSessionsLoaded ? (
            <ActivityIndicator size="small" color="#38BDF8" />
          ) : pendingSessions.length === 0 ? (
            <Text style={styles.emptyText}>Completed recordings waiting for upload will appear here.</Text>
          ) : (
            pendingSessions.map((pendingSession) => {
              const isSessionUploading = activeUploadSessionId === pendingSession.sessionId;
              const statusLabel = isSessionUploading
                ? 'uploading'
                : pendingSession.status === 'failed'
                  ? 'failed'
                  : 'pending';

              return (
                <View key={pendingSession.sessionId} style={styles.pendingSessionRow}>
                  <View style={styles.sessionInfo}>
                    <View style={styles.pendingSessionTitleRow}>
                      <Text numberOfLines={1} style={styles.sessionTitle}>{getSessionDisplayName(pendingSession)}</Text>
                      <Text style={[
                        styles.pendingStatus,
                        statusLabel === 'failed' && styles.pendingStatusFailed,
                        statusLabel === 'uploading' && styles.pendingStatusUploading,
                      ]}>
                        {statusLabel}
                      </Text>
                    </View>
                    <Text style={styles.sessionMeta}>
                      {formatDuration(pendingSession.durationMillis)}
                      {pendingSession.fileSizeBytes ? ` · ${formatBytes(pendingSession.fileSizeBytes)}` : ''}
                      {' · saved locally'}
                    </Text>
                    {pendingSession.lastError ? (
                      <Text numberOfLines={2} style={styles.pendingError}>{pendingSession.lastError}</Text>
                    ) : null}
                  </View>
                  <View style={styles.pendingActions}>
                    <TouchableOpacity
                      activeOpacity={0.85}
                      disabled={isUploading || isUploadingAll || isRecording}
                      onPress={() => {
                        void uploadPendingSession(pendingSession);
                      }}
                      style={[
                        styles.pendingUploadButton,
                        (isUploading || isUploadingAll || isRecording) && styles.buttonDisabled,
                      ]}
                    >
                      {isSessionUploading ? (
                        <ActivityIndicator size="small" color="#0F172A" />
                      ) : (
                        <Ionicons name="cloud-upload-outline" size={16} color="#0F172A" />
                      )}
                      <Text style={styles.pendingUploadButtonText}>
                        {isSessionUploading ? `${uploadProgress?.percent ?? 0}%` : 'Upload'}
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      accessibilityLabel="Delete pending recording"
                      activeOpacity={0.85}
                      disabled={isUploading || isUploadingAll || isRecording}
                      onPress={() => {
                        confirmDeletePendingSession(pendingSession);
                      }}
                      style={[
                        styles.pendingDeleteButton,
                        (isUploading || isUploadingAll || isRecording) && styles.buttonDisabled,
                      ]}
                    >
                      <Ionicons name="trash-outline" size={17} color="#FCA5A5" />
                    </TouchableOpacity>
                  </View>
                </View>
              );
            })
          )}
        </View>

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
                    <Text style={styles.sessionTitle}>{getSessionDisplayName(session)}</Text>
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
      {isRecording ? null : <BottomNav />}
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
  cameraPlaceholder: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    gap: 10,
    backgroundColor: '#0B1220',
  },
  cameraPlaceholderTitle: {
    color: '#F8FAFC',
    fontSize: 17,
    fontWeight: '800',
    textAlign: 'center',
  },
  cameraPlaceholderBody: {
    color: '#94A3B8',
    fontSize: 13,
    lineHeight: 18,
    textAlign: 'center',
    maxWidth: 260,
  },
  permissionButton: {
    minHeight: 44,
    borderRadius: 8,
    backgroundColor: '#38BDF8',
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 16,
    marginTop: 8,
  },
  permissionButtonText: {
    color: '#0F172A',
    fontSize: 13,
    fontWeight: '800',
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
  guidanceCard: {
    borderRadius: 8,
    backgroundColor: '#0B1220',
    borderWidth: 1,
    borderColor: 'rgba(56, 189, 248, 0.2)',
    padding: 14,
    marginBottom: 14,
    gap: 12,
  },
  guidanceHeader: {
    flexDirection: 'row',
    gap: 12,
  },
  guidanceIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(56, 189, 248, 0.12)',
  },
  guidanceTextBlock: {
    flex: 1,
    minWidth: 0,
    gap: 4,
  },
  guidanceTitle: {
    color: '#F8FAFC',
    fontSize: 15,
    fontWeight: '800',
  },
  guidanceBody: {
    color: '#94A3B8',
    fontSize: 13,
    lineHeight: 18,
  },
  guidanceList: {
    gap: 6,
  },
  guidanceItem: {
    color: '#CBD5E1',
    fontSize: 12,
    lineHeight: 17,
  },
  consentButton: {
    minHeight: 46,
    borderRadius: 8,
    backgroundColor: '#38BDF8',
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 14,
  },
  consentButtonAccepted: {
    backgroundColor: 'rgba(34, 197, 94, 0.14)',
    borderWidth: 1,
    borderColor: 'rgba(134, 239, 172, 0.28)',
  },
  consentButtonText: {
    color: '#0F172A',
    fontSize: 14,
    fontWeight: '800',
  },
  consentButtonTextAccepted: {
    color: '#86EFAC',
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
    marginBottom: 14,
  },
  panelHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    marginBottom: 10,
  },
  panelLabel: {
    color: '#E2E8F0',
    fontSize: 13,
    fontWeight: '700',
    marginBottom: 10,
    textTransform: 'uppercase',
  },
  panelLabelInHeader: {
    marginBottom: 0,
  },
  emptyText: {
    color: '#94A3B8',
    fontSize: 14,
  },
  uploadAllButton: {
    minHeight: 34,
    borderRadius: 8,
    backgroundColor: '#38BDF8',
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 6,
    paddingHorizontal: 10,
  },
  uploadAllButtonText: {
    color: '#0F172A',
    fontSize: 12,
    fontWeight: '800',
  },
  pendingSessionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.06)',
  },
  pendingSessionTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  pendingStatus: {
    overflow: 'hidden',
    borderRadius: 999,
    backgroundColor: 'rgba(56, 189, 248, 0.14)',
    color: '#BAE6FD',
    fontSize: 10,
    fontWeight: '800',
    paddingHorizontal: 8,
    paddingVertical: 3,
    textTransform: 'uppercase',
  },
  pendingStatusFailed: {
    backgroundColor: 'rgba(239, 68, 68, 0.14)',
    color: '#FCA5A5',
  },
  pendingStatusUploading: {
    backgroundColor: 'rgba(34, 197, 94, 0.14)',
    color: '#86EFAC',
  },
  pendingError: {
    color: '#FCA5A5',
    fontSize: 12,
    lineHeight: 16,
    marginTop: 5,
  },
  pendingActions: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  pendingUploadButton: {
    minHeight: 38,
    minWidth: 86,
    borderRadius: 8,
    backgroundColor: '#38BDF8',
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 6,
    paddingHorizontal: 10,
  },
  pendingUploadButtonText: {
    color: '#0F172A',
    fontSize: 12,
    fontWeight: '800',
  },
  pendingDeleteButton: {
    minHeight: 38,
    minWidth: 38,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(248, 113, 113, 0.28)',
    backgroundColor: 'rgba(239, 68, 68, 0.1)',
    alignItems: 'center',
    justifyContent: 'center',
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
