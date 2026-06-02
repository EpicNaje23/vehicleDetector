import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Easing,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { Ionicons } from '@expo/vector-icons';
import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from 'expo-audio';
import { BottomNav, BOTTOM_NAV_HEIGHT } from '@/components/BottomNav';

const DEFAULT_SERVER_URL = process.env.EXPO_PUBLIC_AUDIO_API_URL ?? '';

type Prediction = {
  id: string;
  vehicle: string;
  confidence?: string;
  probabilities?: Record<string, number>;
  waveformBars: number[];
  createdAt: number;
  raw: string;
};

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

function stringifyResponse(body: unknown) {
  if (typeof body === 'string') {
    return body;
  }

  try {
    return JSON.stringify(body, null, 2);
  } catch {
    return String(body);
  }
}

function findNestedValue(value: unknown, keys: string[]): unknown {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const record = value as Record<string, unknown>;

  for (const key of keys) {
    const found = record[key];
    if (typeof found === 'string' || typeof found === 'number') {
      return found;
    }
  }

  for (const nested of Object.values(record)) {
    const found = findNestedValue(nested, keys);
    if (found !== undefined) {
      return found;
    }
  }

  return undefined;
}

function getProbabilityMap(value: unknown) {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const probabilities = (value as Record<string, unknown>).probabilities;
  if (!probabilities || typeof probabilities !== 'object') {
    return undefined;
  }

  const entries = Object.entries(probabilities as Record<string, unknown>)
    .map(([label, score]) => [label, Number(score)] as const)
    .filter(([, score]) => Number.isFinite(score));

  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function generateWaveformBars(seed: string, count = 42) {
  let hash = 0;

  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
  }

  return Array.from({ length: count }, (_, index) => {
    const wave = Math.sin((index / count) * Math.PI * 4) * 0.28;
    hash = (hash * 1664525 + 1013904223) >>> 0;
    const random = (hash % 1000) / 1000;

    return Math.max(0.18, Math.min(1, 0.46 + wave + random * 0.38));
  });
}

function buildPrediction(body: unknown): Omit<Prediction, 'id' | 'createdAt'> {
  const raw = stringifyResponse(body);
  let parsed = body;

  if (typeof body === 'string') {
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = body;
    }
  }

  if (parsed && typeof parsed === 'object') {
    const vehicle = findNestedValue(parsed, [
      'vehicle',
      'vehicleType',
      'vehicle_type',
      'predicted_class',
      'class',
      'label',
      'prediction',
      'predicted',
      'result',
      'name',
    ]);
    const confidence = findNestedValue(parsed, [
      'confidence',
      'score',
      'probability',
      'prob',
      'accuracy',
    ]);

    return {
      vehicle: vehicle ? String(vehicle) : 'Prediction unavailable',
      confidence: confidence ? String(confidence) : undefined,
      probabilities: getProbabilityMap(parsed),
      waveformBars: generateWaveformBars(raw),
      raw,
    };
  }

  const cleaned = raw.trim();
  return {
    vehicle: cleaned || 'Prediction unavailable',
    waveformBars: generateWaveformBars(cleaned || raw),
    raw: cleaned || raw,
  };
}

export default function HomeScreen() {
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recorderState = useAudioRecorderState(recorder, 200);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isPreparing, setIsPreparing] = useState(false);
  const [recentPredictions, setRecentPredictions] = useState<Prediction[]>([]);
  const [selectedPrediction, setSelectedPrediction] = useState<Prediction | null>(null);
  const pulse = useRef(new Animated.Value(0)).current;
  const insets = useSafeAreaInsets();
  const isRecording = recorderState.isRecording;

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

  const statusText = useMemo(() => {
    if (isRecording) {
      return 'Listening…';
    }

    if (isPreparing) {
      return 'Preparing…';
    }

    if (isSubmitting) {
      return 'Predicting…';
    }

    return 'Tap to listen';
  }, [isPreparing, isRecording, isSubmitting]);

  const ensureMicrophonePermission = async () => {
    const permission = await requestRecordingPermissionsAsync();
    return permission.granted;
  };

  const uploadRecording = async (recordingUri: string, durationMillis: number) => {
    if (!DEFAULT_SERVER_URL.trim()) {
      throw new Error('Missing EXPO_PUBLIC_AUDIO_API_URL for predictions.');
    }

    const fileName = getFileName(recordingUri);
    const formData = new FormData();

    formData.append('file', {
      uri: recordingUri,
      name: fileName,
      type: getMimeType(fileName),
    } as unknown as Blob);
    formData.append('source', 'mobile-app');
    formData.append('durationMillis', String(durationMillis));

    const response = await fetch(DEFAULT_SERVER_URL.trim(), {
      method: 'POST',
      body: formData,
    });

    const contentType = response.headers.get('content-type') ?? '';
    const body = contentType.includes('application/json') ? await response.json() : await response.text();

    if (!response.ok) {
      throw new Error(stringifyResponse(body) || `Prediction failed with status ${response.status}.`);
    }

    const prediction = buildPrediction(body);
    const nextPrediction = {
      ...prediction,
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      createdAt: Date.now(),
    };

    setRecentPredictions((current) => [
      nextPrediction,
      ...current,
    ].slice(0, 20));
    setSelectedPrediction(nextPrediction);
  };

  const startRecording = async () => {
    try {
      setErrorMessage(null);
      setIsPreparing(true);

      const granted = await ensureMicrophonePermission();
      if (!granted) {
        setErrorMessage('Microphone permission is required to predict a vehicle.');
        return;
      }

      await setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
      });
      await recorder.prepareToRecordAsync();
      recorder.record();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to start recording.';
      setErrorMessage(message);
    } finally {
      setIsPreparing(false);
    }
  };

  const stopAndPredict = async () => {
    try {
      setErrorMessage(null);
      setIsPreparing(true);

      await recorder.stop();
      await setAudioModeAsync({ allowsRecording: false });

      const recordingUri = recorder.uri ?? recorderState.url;
      if (!recordingUri) {
        setErrorMessage('Recording finished, but no audio file was created.');
        return;
      }

      setIsPreparing(false);
      setIsSubmitting(true);
      await uploadRecording(recordingUri, recorderState.durationMillis);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to predict vehicle.';
      setErrorMessage(message);
    } finally {
      setIsPreparing(false);
      setIsSubmitting(false);
    }
  };

  const toggleRecording = async () => {
    if (isPreparing || isSubmitting) {
      return;
    }

    if (isRecording) {
      await stopAndPredict();
      return;
    }

    await startRecording();
  };

  return (
    <View style={[styles.safeArea, { paddingTop: insets.top }]}> 
      <StatusBar style="light" />
      <View style={[styles.screen, { paddingBottom: BOTTOM_NAV_HEIGHT + Math.max(insets.bottom, 10) + 18 }]}> 
        <Text style={styles.heading}>CarZam</Text>

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
                  outputRange: [0.34, 0],
                }),
              },
            ]}
          />
          <TouchableOpacity
            activeOpacity={0.86}
            style={[styles.listenButton, isRecording && styles.listenButtonActive]}
            onPress={toggleRecording}
          >
            {isPreparing || isSubmitting ? (
              <ActivityIndicator size="large" color="#FFFFFF" />
            ) : (
              <Ionicons name={isRecording ? 'stop' : 'mic-outline'} size={42} color="#FFFFFF" />
            )}
            <Text style={styles.listenTitle}>{statusText}</Text>
            <Text style={styles.durationText}>{isRecording ? formatDuration(recorderState.durationMillis) : '00:00'}</Text>
          </TouchableOpacity>
        </View>

        {errorMessage ? (
          <View style={styles.messageBoxError}>
            <Ionicons name="alert-circle-outline" size={18} color="#FECACA" />
            <Text style={styles.messageBody}>{errorMessage}</Text>
          </View>
        ) : null}

        <View style={styles.recentSection}>
          <View style={styles.recentHeader}>
            <Text style={styles.recentTitle}>Recently predicted</Text>
          </View>
          <ScrollView
            horizontal
            style={styles.recentList}
            contentContainerStyle={styles.recentListContent}
            showsHorizontalScrollIndicator={false}
            showsVerticalScrollIndicator={false}
          >
            {recentPredictions.length === 0 ? (
              <View style={styles.emptyState}>
                <Ionicons name="car-sport-outline" size={24} color="#64748B" />
                <Text style={styles.emptyText}>Predictions will appear here.</Text>
              </View>
            ) : (
              recentPredictions.map((prediction) => (
                <TouchableOpacity
                  key={prediction.id}
                  activeOpacity={0.84}
                  onPress={() => setSelectedPrediction(prediction)}
                  style={styles.predictionRow}
                >
                  <View style={styles.predictionIcon}>
                    <Ionicons name="car-sport-outline" size={18} color="#38BDF8" />
                  </View>
                  <View style={styles.predictionTextBlock}>
                    <Text numberOfLines={1} style={styles.predictionVehicle}>{prediction.vehicle}</Text>
                    <Text numberOfLines={1} style={styles.predictionRaw}>{prediction.confidence ? `Confidence ${prediction.confidence}` : prediction.raw}</Text>
                  </View>
                  <Text style={styles.predictionTime}>{new Date(prediction.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</Text>
                </TouchableOpacity>
              ))
            )}
          </ScrollView>
        </View>
      </View>
      <BottomNav />
      <Modal
        animationType="slide"
        visible={selectedPrediction !== null}
        presentationStyle="pageSheet"
        onRequestClose={() => setSelectedPrediction(null)}
      >
        <View style={styles.modalScreen}>
          <TouchableOpacity
            activeOpacity={0.82}
            onPress={() => setSelectedPrediction(null)}
            style={[styles.modalCloseButton, { top: insets.top + 14 }]}
          >
            <Ionicons name="close" size={24} color="#F8FAFC" />
          </TouchableOpacity>

          {selectedPrediction ? (
            <ScrollView
              contentContainerStyle={[
                styles.modalContent,
                {
                  paddingTop: insets.top + 88,
                  paddingBottom: Math.max(insets.bottom, 20) + 32,
                },
              ]}
              showsVerticalScrollIndicator={false}
            >
              <View style={styles.modalIcon}>
                <Ionicons name="car-sport-outline" size={42} color="#38BDF8" />
              </View>
              <Text style={styles.modalLabel}>Prediction result</Text>
              <Text numberOfLines={2} adjustsFontSizeToFit style={styles.modalVehicle}>
                {selectedPrediction.vehicle}
              </Text>
              {selectedPrediction.confidence ? (
                <Text style={styles.modalConfidence}>Confidence {selectedPrediction.confidence}</Text>
              ) : null}
              <Text style={styles.modalTime}>
                {new Date(selectedPrediction.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </Text>

              <View style={styles.detailSection}>
                <Text style={styles.detailTitle}>Waveform</Text>
                <View style={styles.waveformCard}>
                  {selectedPrediction.waveformBars.map((height, index) => (
                    <View
                      key={`${selectedPrediction.id}-wave-${index}`}
                      style={[styles.waveformBar, { height: 18 + height * 66 }]}
                    />
                  ))}
                </View>
              </View>

              <View style={styles.detailSection}>
                <Text style={styles.detailTitle}>Class scores</Text>
                <View style={styles.scoreCard}>
                  {Object.entries(selectedPrediction.probabilities ?? {})
                    .sort(([, left], [, right]) => right - left)
                    .map(([label, score]) => (
                      <View key={label} style={styles.scoreRow}>
                        <Text style={styles.scoreLabel}>{label}</Text>
                        <View style={styles.scoreTrack}>
                          <View style={[styles.scoreFill, { width: `${Math.round(score * 100)}%` }]} />
                        </View>
                        <Text style={styles.scoreValue}>{Math.round(score * 100)}%</Text>
                      </View>
                    ))}
                  {!selectedPrediction.probabilities ? (
                    <Text style={styles.scoreEmpty}>No class scores returned.</Text>
                  ) : null}
                </View>
              </View>
            </ScrollView>
          ) : null}
        </View>
      </Modal>
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
    alignItems: 'center',
    paddingTop: 26,
  },
  heading: {
    color: '#F8FAFC',
    fontSize: 31,
    fontWeight: '800',
    letterSpacing: 0.4,
    marginBottom: 24,
  },
  captureSection: {
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 24,
  },
  listenHalo: {
    position: 'absolute',
    width: 260,
    height: 260,
    borderRadius: 130,
    backgroundColor: '#38BDF8',
  },
  listenButton: {
    width: 226,
    height: 226,
    borderRadius: 113,
    backgroundColor: '#111827',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
    gap: 12,
    shadowColor: '#38BDF8',
    shadowOpacity: 0.12,
    shadowRadius: 28,
    shadowOffset: { width: 0, height: 14 },
    elevation: 5,
  },
  listenButtonActive: {
    backgroundColor: '#1E293B',
    borderColor: '#38BDF8',
  },
  listenTitle: {
    color: '#F8FAFC',
    fontSize: 20,
    fontWeight: '800',
  },
  durationText: {
    color: '#94A3B8',
    fontSize: 17,
    fontVariant: ['tabular-nums'],
    fontWeight: '700',
    letterSpacing: 1,
  },
  messageBoxError: {
    width: '100%',
    maxWidth: 380,
    borderRadius: 16,
    backgroundColor: 'rgba(127, 29, 29, 0.34)',
    borderWidth: 1,
    borderColor: 'rgba(248, 113, 113, 0.38)',
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 14,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
  },
  messageBody: {
    flex: 1,
    color: '#FEE2E2',
    fontSize: 14,
    lineHeight: 20,
  },
  recentSection: {
    width: '100%',
    maxWidth: 390,
    height: 156,
    marginTop: 'auto',
  },
  recentHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  recentTitle: {
    color: '#E2E8F0',
    fontSize: 16,
    fontWeight: '800',
  },
  recentList: {
    height: 110,
  },
  recentListContent: {
    gap: 10,
    paddingRight: 8,
  },
  emptyState: {
    width: 330,
    height: 100,
    borderRadius: 18,
    backgroundColor: '#0B1220',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  emptyText: {
    color: '#64748B',
    fontSize: 14,
    fontWeight: '600',
  },
  predictionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    width: 330,
    height: 96,
    gap: 12,
    borderRadius: 20,
    backgroundColor: '#0B1220',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
    paddingHorizontal: 14,
  },
  predictionIcon: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(56, 189, 248, 0.12)',
  },
  predictionTextBlock: {
    flex: 1,
    minWidth: 0,
  },
  predictionVehicle: {
    color: '#F8FAFC',
    fontSize: 15,
    fontWeight: '800',
  },
  predictionRaw: {
    color: '#64748B',
    fontSize: 12,
    marginTop: 3,
  },
  predictionTime: {
    color: '#64748B',
    fontSize: 11,
    fontWeight: '700',
  },
  modalScreen: {
    flex: 1,
    backgroundColor: '#05060A',
  },
  modalCloseButton: {
    position: 'absolute',
    left: 18,
    zIndex: 2,
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#111827',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
  },
  modalContent: {
    alignItems: 'center',
    paddingHorizontal: 28,
  },
  modalIcon: {
    width: 96,
    height: 96,
    borderRadius: 48,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(56, 189, 248, 0.12)',
    borderWidth: 1,
    borderColor: 'rgba(56, 189, 248, 0.26)',
    marginBottom: 26,
  },
  modalLabel: {
    color: '#64748B',
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    marginBottom: 10,
  },
  modalVehicle: {
    color: '#F8FAFC',
    fontSize: 54,
    fontWeight: '900',
    textAlign: 'center',
  },
  modalConfidence: {
    color: '#BAE6FD',
    fontSize: 18,
    fontWeight: '800',
    marginTop: 12,
  },
  modalTime: {
    color: '#64748B',
    fontSize: 14,
    fontWeight: '700',
    marginTop: 20,
  },
  detailSection: {
    width: '100%',
    marginTop: 34,
  },
  detailTitle: {
    color: '#E2E8F0',
    fontSize: 16,
    fontWeight: '800',
    marginBottom: 12,
  },
  waveformCard: {
    minHeight: 128,
    borderRadius: 22,
    backgroundColor: '#0B1220',
    borderWidth: 1,
    borderColor: 'rgba(56, 189, 248, 0.18)',
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 3,
  },
  waveformBar: {
    flex: 1,
    maxWidth: 5,
    borderRadius: 999,
    backgroundColor: '#38BDF8',
    opacity: 0.86,
  },
  scoreCard: {
    borderRadius: 22,
    backgroundColor: '#0B1220',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    padding: 14,
    gap: 14,
  },
  scoreRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  scoreLabel: {
    width: 54,
    color: '#F8FAFC',
    fontSize: 14,
    fontWeight: '800',
  },
  scoreTrack: {
    flex: 1,
    height: 9,
    borderRadius: 999,
    overflow: 'hidden',
    backgroundColor: '#111827',
  },
  scoreFill: {
    height: '100%',
    borderRadius: 999,
    backgroundColor: '#38BDF8',
  },
  scoreValue: {
    width: 42,
    color: '#94A3B8',
    fontSize: 12,
    fontWeight: '800',
    textAlign: 'right',
  },
  scoreEmpty: {
    color: '#64748B',
    fontSize: 14,
    fontWeight: '600',
  },
});
