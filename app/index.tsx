import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Easing,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { Link } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from 'expo-audio';

const STATUS_COPY = {
  idle: {
    eyebrow: 'Ready to record',
    title: 'Capture audio',
    hint: 'Record a short sample, then send it to your server.',
    badge: 'ready',
  },
  recording: {
    eyebrow: 'Microphone live',
    title: 'Recording…',
    hint: 'Tap again to stop and prepare the upload.',
    badge: 'recording',
  },
  recorded: {
    eyebrow: 'Clip saved',
    title: 'Ready to send',
    hint: 'Review the endpoint and upload the recording.',
    badge: 'recorded',
  },
};

const DEFAULT_SERVER_URL = process.env.EXPO_PUBLIC_AUDIO_API_URL ?? '';

type PermissionState = 'unknown' | 'granted' | 'denied';

function formatDuration(durationMillis: number) {
  const totalSeconds = Math.max(0, Math.floor(durationMillis / 1000));
  const minutes = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, '0');
  const seconds = (totalSeconds % 60).toString().padStart(2, '0');

  return `${minutes}:${seconds}`;
}

function getFileName(uri: string) {
  const fromUri = uri.split('/').pop();

  if (fromUri && fromUri.includes('.')) {
    return fromUri;
  }

  return `recording-${Date.now()}.m4a`;
}

function getMimeType(fileName: string) {
  if (fileName.endsWith('.webm')) {
    return 'audio/webm';
  }

  if (fileName.endsWith('.wav')) {
    return 'audio/wav';
  }

  if (fileName.endsWith('.mp3')) {
    return 'audio/mpeg';
  }

  return 'audio/mp4';
}

export default function HomeScreen() {
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recorderState = useAudioRecorderState(recorder, 200);
  const [permissionState, setPermissionState] = useState<PermissionState>('unknown');
  const [recordingUri, setRecordingUri] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [serverResponse, setServerResponse] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isPreparing, setIsPreparing] = useState(false);
  const pulse = useRef(new Animated.Value(0)).current;
  const insets = useSafeAreaInsets();
  const isRecording = recorderState.isRecording;
  const hasRecording = Boolean(recordingUri);

  useEffect(() => {
    let loop: Animated.CompositeAnimation | null = null;

    if (isRecording) {
      pulse.setValue(0);
      loop = Animated.loop(
        Animated.sequence([
          Animated.timing(pulse, {
            toValue: 1,
            duration: 1400,
            easing: Easing.out(Easing.quad),
            useNativeDriver: true,
          }),
          Animated.timing(pulse, {
            toValue: 0,
            duration: 1400,
            easing: Easing.in(Easing.quad),
            useNativeDriver: true,
          }),
        ])
      );
      loop.start();
    } else {
      pulse.setValue(0);
    }

    return () => {
      loop?.stop();
    };
  }, [isRecording, pulse]);

  const status = isRecording
    ? STATUS_COPY.recording
    : hasRecording
      ? STATUS_COPY.recorded
      : STATUS_COPY.idle;

  const ensureMicrophonePermission = async () => {
    const permission = await requestRecordingPermissionsAsync();
    setPermissionState(permission.granted ? 'granted' : 'denied');
    return permission.granted;
  };

  const startRecording = async () => {
    try {
      setErrorMessage(null);
      setServerResponse(null);
      setIsPreparing(true);

      const granted = await ensureMicrophonePermission();
      if (!granted) {
        setErrorMessage('Microphone permission was denied.');
        return;
      }

      await setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
      });
      await recorder.prepareToRecordAsync();
      recorder.record();
      setRecordingUri(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to start recording.';
      setErrorMessage(message);
    } finally {
      setIsPreparing(false);
    }
  };

  const stopRecording = async () => {
    try {
      setErrorMessage(null);
      setIsPreparing(true);

      await recorder.stop();
      await setAudioModeAsync({
        allowsRecording: false,
      });

      const nextUri = recorder.uri ?? recorderState.url;
      if (!nextUri) {
        throw new Error('Recording finished, but no audio file was created.');
      }

      setRecordingUri(nextUri);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to stop recording.';
      setErrorMessage(message);
    } finally {
      setIsPreparing(false);
    }
  };

  const toggleRecording = async () => {
    if (isPreparing || isSubmitting) {
      return;
    }

    if (isRecording) {
      await stopRecording();
      return;
    }

    await startRecording();
  };

  const uploadRecording = async () => {
    if (!recordingUri) {
      setErrorMessage('Record audio before uploading.');
      return;
    }

    if (!DEFAULT_SERVER_URL.trim()) {
      setErrorMessage('Missing EXPO_PUBLIC_AUDIO_API_URL for uploads.');
      return;
    }

    try {
      setErrorMessage(null);
      setServerResponse(null);
      setIsSubmitting(true);

      const fileName = getFileName(recordingUri);
      const formData = new FormData();

      formData.append('file', {
        uri: recordingUri,
        name: fileName,
        type: getMimeType(fileName),
      } as unknown as Blob);
      formData.append('source', 'mobile-app');
      formData.append('durationMillis', String(recorderState.durationMillis));

      const response = await fetch(DEFAULT_SERVER_URL.trim(), {
        method: 'POST',
        body: formData,
      });

      const contentType = response.headers.get('content-type') ?? '';
      const body = contentType.includes('application/json')
        ? JSON.stringify(await response.json(), null, 2)
        : await response.text();

      if (!response.ok) {
        throw new Error(body || `Upload failed with status ${response.status}.`);
      }

      setServerResponse(body || 'Upload complete. The server returned an empty body.');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to upload recording.';
      setErrorMessage(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const clearRecording = () => {
    if (isRecording || isPreparing || isSubmitting) {
      return;
    }

    setRecordingUri(null);
    setServerResponse(null);
    setErrorMessage(null);
  };

  return (
    <View
      style={[
        styles.safeArea,
        { paddingTop: insets.top, paddingBottom: insets.bottom },
      ]}
    >
      <StatusBar style="light" />
      <View style={styles.screen}>
        <Text style={styles.heading}>CarZam</Text>
        <Text style={styles.subtitle}>Record audio, send it to your server, and show the reply here.</Text>
        <Link href={'/collect' as never} asChild>
          <TouchableOpacity activeOpacity={0.85} style={styles.collectionLink}>
            <Ionicons name="videocam-outline" size={17} color="#38BDF8" />
            <Text style={styles.collectionLinkText}>Collect dataset sessions</Text>
          </TouchableOpacity>
        </Link>

        <View style={styles.captureSection}>
          <Animated.View
            style={[
              styles.listenHalo,
              {
                transform: [
                  {
                    scale: pulse.interpolate({
                      inputRange: [0, 1],
                      outputRange: [1, 1.5],
                    }),
                  },
                ],
                opacity: pulse.interpolate({
                  inputRange: [0, 1],
                  outputRange: [0.35, 0],
                }),
              },
            ]}
          />
          <TouchableOpacity
            activeOpacity={0.85}
            style={[styles.listenButton, isRecording && styles.listenButtonActive]}
            onPress={toggleRecording}
          >
            <View style={styles.listenIconRow}>
              <Ionicons name="mic-outline" size={24} color="#FFFFFF" />
              <Text style={styles.listenBadge}>{status.badge}</Text>
            </View>
            <Text style={styles.statusEyebrow}>{status.eyebrow}</Text>
            <Text style={styles.listenTitle}>{status.title}</Text>
            <Text style={styles.listenHint}>{status.hint}</Text>
            <Text style={styles.durationText}>
              {isRecording || hasRecording ? formatDuration(recorderState.durationMillis) : '00:00'}
            </Text>
            <View style={styles.ctaPill}>
              {isPreparing ? (
                <ActivityIndicator size="small" color="#0F172A" />
              ) : (
                <Ionicons
                  name={isRecording ? 'stop' : 'radio-button-on'}
                  size={18}
                  color="#0F172A"
                />
              )}
              <Text style={styles.ctaText}>{isRecording ? 'Stop recording' : 'Start recording'}</Text>
            </View>
          </TouchableOpacity>
        </View>

        <View style={styles.actionsRow}>
          <TouchableOpacity
            activeOpacity={0.85}
            disabled={!hasRecording || isRecording || isSubmitting || isPreparing}
            onPress={uploadRecording}
            style={[
              styles.secondaryButton,
              (!hasRecording || isRecording || isSubmitting || isPreparing) && styles.buttonDisabled,
            ]}
          >
            {isSubmitting ? (
              <ActivityIndicator size="small" color="#F8FAFC" />
            ) : (
              <>
                <Ionicons name="cloud-upload-outline" size={18} color="#F8FAFC" />
                <Text style={styles.secondaryButtonText}>Send to server</Text>
              </>
            )}
          </TouchableOpacity>

          <TouchableOpacity
            activeOpacity={0.85}
            disabled={!hasRecording || isRecording || isSubmitting || isPreparing}
            onPress={clearRecording}
            style={[
              styles.ghostButton,
              (!hasRecording || isRecording || isSubmitting || isPreparing) && styles.buttonDisabled,
            ]}
          >
            <Ionicons name="refresh-outline" size={18} color="#CBD5E1" />
            <Text style={styles.ghostButtonText}>Reset</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.metaRow}>
          <View style={styles.metaPill}>
            <Text style={styles.metaLabel}>Permission</Text>
            <Text style={styles.metaValue}>{permissionState}</Text>
          </View>
          <View style={styles.metaPill}>
            <Text style={styles.metaLabel}>File</Text>
            <Text numberOfLines={1} style={styles.metaValue}>
              {recordingUri ? getFileName(recordingUri) : 'none'}
            </Text>
          </View>
        </View>

        {errorMessage ? (
          <View style={styles.messageBoxError}>
            <Text style={styles.messageTitle}>Error</Text>
            <Text style={styles.messageBody}>{errorMessage}</Text>
          </View>
        ) : null}

        <View style={styles.responseSection}>
          <Text style={styles.panelLabel}>Server response</Text>
          <ScrollView contentContainerStyle={styles.responseBody} style={styles.responseBox}>
            <Text style={styles.responseText}>
              {serverResponse ?? 'The server response will appear here after upload.'}
            </Text>
          </ScrollView>
        </View>
      </View>
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
    padding: 24,
    alignItems: 'center',
    justifyContent: 'flex-start',
    paddingTop: "20%",
  },
  brand: {
    color: '#6C7394',
    fontSize: 14,
    textTransform: 'uppercase',
    letterSpacing: 2,
    marginBottom: 6,
  },
  heading: {
    color: '#F8FAFC',
    fontSize: 28,
    fontWeight: '700',
  },
  subtitle: {
    color: '#98A1C1',
    fontSize: 15,
    textAlign: 'center',
    marginTop: 6,
    marginBottom: 12,
    maxWidth: 320,
  },
  collectionLink: {
    minHeight: 40,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(56, 189, 248, 0.35)',
    backgroundColor: 'rgba(14, 165, 233, 0.10)',
    paddingHorizontal: 14,
    marginBottom: 24,
  },
  collectionLinkText: {
    color: '#BAE6FD',
    fontSize: 13,
    fontWeight: '700',
  },
  captureSection: {
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 28,
  },
  listenHalo: {
    position: 'absolute',
    width: 260,
    height: 260,
    borderRadius: 130,
    backgroundColor: '#38BDF8',
    opacity: 0.35,
  },
  listenButton: {
    width: 220,
    height: 220,
    borderRadius: 110,
    backgroundColor: '#111827',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
    gap: 10,
  },
  listenButtonActive: {
    backgroundColor: '#1E293B',
    borderColor: '#38BDF8',
  },
  statusEyebrow: {
    color: '#38BDF8',
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: 1.4,
  },
  listenIconRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  listenBadge: {
    color: '#E5E7EB',
    textTransform: 'uppercase',
    letterSpacing: 1,
    fontSize: 12,
  },
  listenTitle: {
    color: '#F8FAFC',
    fontSize: 24,
    fontWeight: '700',
  },
  listenHint: {
    color: '#A0AEC0',
    fontSize: 13,
    textAlign: 'center',
  },
  durationText: {
    color: '#F8FAFC',
    fontSize: 28,
    fontVariant: ['tabular-nums'],
    fontWeight: '700',
    letterSpacing: 1,
  },
  ctaPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#38BDF8',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
  },
  ctaText: {
    color: '#0F172A',
    fontWeight: '700',
    fontSize: 13,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  panelLabel: {
    color: '#E2E8F0',
    fontSize: 13,
    fontWeight: '700',
    marginBottom: 8,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  actionsRow: {
    width: '100%',
    maxWidth: 360,
    flexDirection: 'row',
    gap: 12,
    marginBottom: 18,
  },
  secondaryButton: {
    flex: 1,
    minHeight: 52,
    borderRadius: 18,
    backgroundColor: '#0EA5E9',
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 16,
  },
  secondaryButtonText: {
    color: '#F8FAFC',
    fontSize: 14,
    fontWeight: '700',
  },
  ghostButton: {
    minHeight: 52,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    backgroundColor: '#111827',
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 16,
  },
  ghostButtonText: {
    color: '#CBD5E1',
    fontSize: 14,
    fontWeight: '600',
  },
  buttonDisabled: {
    opacity: 0.45,
  },
  metaRow: {
    width: '100%',
    maxWidth: 360,
    flexDirection: 'row',
    gap: 12,
    marginBottom: 18,
  },
  metaPill: {
    flex: 1,
    borderRadius: 18,
    backgroundColor: '#0B1220',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  metaLabel: {
    color: '#64748B',
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 4,
  },
  metaValue: {
    color: '#E2E8F0',
    fontSize: 14,
    fontWeight: '600',
  },
  messageBoxError: {
    width: '100%',
    maxWidth: 360,
    borderRadius: 18,
    backgroundColor: 'rgba(127, 29, 29, 0.35)',
    borderWidth: 1,
    borderColor: 'rgba(248, 113, 113, 0.4)',
    padding: 14,
    marginBottom: 18,
  },
  messageTitle: {
    color: '#FECACA',
    fontSize: 13,
    fontWeight: '700',
    marginBottom: 4,
  },
  messageBody: {
    color: '#FEE2E2',
    fontSize: 14,
    lineHeight: 20,
  },
  responseSection: {
    width: '100%',
    maxWidth: 360,
    flex: 1,
    minHeight: 180,
    paddingBottom: 24,
  },
  responseBox: {
    flex: 1,
    borderRadius: 20,
    backgroundColor: '#0B1120',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
  },
  responseBody: {
    padding: 16,
  },
  responseText: {
    color: '#D8E1F2',
    fontSize: 14,
    lineHeight: 21,
    fontFamily: 'monospace',
  },
});
