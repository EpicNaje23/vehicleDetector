import { useEffect, useRef, useState } from 'react';
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
import * as DocumentPicker from 'expo-document-picker';
import { RecordingPresets, requestRecordingPermissionsAsync, setAudioModeAsync, useAudioRecorder } from 'expo-audio';
import { useConvex, useConvexAuth, useQuery } from 'convex/react';
import { BottomNav, BOTTOM_NAV_HEIGHT } from '@/components/BottomNav';
import { api } from '@/convex/_generated/api';
import type { Id } from '@/convex/_generated/dataModel';

const DEFAULT_SERVER_URL = process.env.EXPO_PUBLIC_AUDIO_API_URL ?? '';

type Prediction = {
  id: string;
  vehicle: string;
  confidence?: number;
  scores?: PredictionScore[];
  audio?: PredictionAudio;
  waveform?: PredictionWaveform;
  modelVersion?: string;
  createdAt: number;
  raw: string;
};

type PredictionScore = {
  label: string;
  confidence: number;
};

type PredictionAudio = {
  durationSeconds: number;
  sampleRate: number;
  channels: number;
};

type PredictionWaveform = {
  version: 1;
  type: 'peak_pairs';
  points: number;
  min: number[];
  max: number[];
};

function getFileName(uri: string, fallbackName?: string | null) {
  if (fallbackName?.trim()) {
    return fallbackName.trim();
  }

  const fromUri = uri.split('/').pop();

  if (fromUri && fromUri.includes('.')) {
    return fromUri;
  }

  return `recording-${Date.now()}.m4a`;
}

function getMimeType(fileName: string) {
  const normalizedFileName = fileName.toLowerCase();

  if (normalizedFileName.endsWith('.webm')) {
    return 'audio/webm';
  }

  if (normalizedFileName.endsWith('.wav')) {
    return 'audio/wav';
  }

  if (normalizedFileName.endsWith('.mp3')) {
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

function normalizeConfidence(value: unknown) {
  const confidence = Number(value);
  return Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : undefined;
}

function getNestedRecord(value: unknown, key: string) {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const nested = (value as Record<string, unknown>)[key];
  return nested && typeof nested === 'object' ? nested as Record<string, unknown> : undefined;
}

function getPredictionLabel(value: unknown) {
  const prediction = getNestedRecord(value, 'prediction');
  const label = prediction?.label;

  if (typeof label === 'string' && label.trim()) {
    return label.trim();
  }

  return undefined;
}

function getPredictionConfidence(value: unknown) {
  const prediction = getNestedRecord(value, 'prediction');
  return normalizeConfidence(prediction?.confidence);
}

function getPredictionAudio(value: unknown): PredictionAudio | undefined {
  const audio = getNestedRecord(value, 'audio');
  if (!audio) {
    return undefined;
  }

  const durationSeconds = Number(audio.durationSeconds);
  const sampleRate = Number(audio.sampleRate);
  const channels = Number(audio.channels);

  if (!Number.isFinite(durationSeconds) || !Number.isFinite(sampleRate) || !Number.isFinite(channels)) {
    return undefined;
  }

  return {
    durationSeconds,
    sampleRate,
    channels,
  };
}

function normalizeWaveformValue(value: unknown) {
  const amplitude = Number(value);
  return Number.isFinite(amplitude) ? Math.max(-1, Math.min(1, amplitude)) : undefined;
}

function getPredictionWaveform(value: unknown): PredictionWaveform | undefined {
  const waveform = getNestedRecord(value, 'waveform');
  if (!waveform || waveform.type !== 'peak_pairs' || waveform.version !== 1) {
    return undefined;
  }

  if (!Array.isArray(waveform.min) || !Array.isArray(waveform.max)) {
    return undefined;
  }

  const min = waveform.min.map(normalizeWaveformValue).filter((item) => item !== undefined);
  const max = waveform.max.map(normalizeWaveformValue).filter((item) => item !== undefined);
  const points = Math.min(min.length, max.length, Number(waveform.points) || min.length);

  if (points <= 0) {
    return undefined;
  }

  return {
    version: 1,
    type: 'peak_pairs',
    points,
    min: min.slice(0, points),
    max: max.slice(0, points),
  };
}

function getPredictionScores(value: unknown): PredictionScore[] | undefined {
  const responseScores = value && typeof value === 'object' ? (value as Record<string, unknown>).scores : undefined;

  if (Array.isArray(responseScores)) {
    const scores = responseScores
      .map((score) => {
        if (!score || typeof score !== 'object') {
          return undefined;
        }

        const record = score as Record<string, unknown>;
        const label = typeof record.label === 'string' ? record.label.trim() : '';
        const confidence = normalizeConfidence(record.confidence);

        return label && confidence !== undefined ? { label, confidence } : undefined;
      })
      .filter((score) => score !== undefined)
      .sort((left, right) => right.confidence - left.confidence);

    return scores.length > 0 ? scores : undefined;
  }

  const probabilities = getProbabilityMap(value);
  if (!probabilities) {
    return undefined;
  }

  return Object.entries(probabilities)
    .map(([label, confidence]) => ({ label, confidence: normalizeConfidence(confidence) ?? 0 }))
    .sort((left, right) => right.confidence - left.confidence);
}

function getModelVersion(value: unknown) {
  const meta = getNestedRecord(value, 'meta');
  const modelVersion = meta?.modelVersion;

  return typeof modelVersion === 'string' && modelVersion.trim() ? modelVersion.trim() : undefined;
}

function formatConfidence(confidence: number) {
  return `${Math.round(confidence * 100)}%`;
}

function formatDuration(durationMillis: number) {
  const totalSeconds = Math.max(0, Math.floor(durationMillis / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = (totalSeconds % 60).toString().padStart(2, '0');

  return `${minutes}:${seconds}`;
}

function formatBytes(bytes?: number | null) {
  if (bytes === undefined || bytes === null) {
    return '';
  }

  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const megabytes = bytes / (1024 * 1024);
  if (megabytes >= 1) {
    return `${megabytes.toFixed(1)} MB`;
  }

  return `${(bytes / 1024).toFixed(1)} KB`;
}

function getSessionDisplayName(session: { startedAt?: string; sessionId: string }) {
  const timestamp = session.startedAt ? new Date(session.startedAt) : null;

  if (timestamp && Number.isFinite(timestamp.getTime())) {
    return `Session ${timestamp.toLocaleDateString([], { day: '2-digit', month: 'short' })}, ${timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  }

  return session.sessionId;
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
    const legacyVehicle = findNestedValue(parsed, [
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
    const legacyConfidence = findNestedValue(parsed, [
      'confidence',
      'score',
      'probability',
      'prob',
      'accuracy',
    ]);

    return {
      vehicle: getPredictionLabel(parsed) ?? (legacyVehicle ? String(legacyVehicle) : 'Prediction unavailable'),
      confidence: getPredictionConfidence(parsed) ?? normalizeConfidence(legacyConfidence),
      scores: getPredictionScores(parsed),
      audio: getPredictionAudio(parsed),
      waveform: getPredictionWaveform(parsed),
      modelVersion: getModelVersion(parsed),
      raw,
    };
  }

  const cleaned = raw.trim();
  return {
    vehicle: cleaned || 'Prediction unavailable',
    raw: cleaned || raw,
  };
}

function WaveformEnvelope({ waveform }: { waveform?: PredictionWaveform }) {
  if (!waveform) {
    return (
      <View style={[styles.waveformCard, styles.waveformEmptyCard]}>
        <Ionicons name="pulse-outline" size={22} color="#64748B" />
        <Text style={styles.waveformEmptyText}>No waveform returned.</Text>
      </View>
    );
  }

  return (
    <View style={styles.waveformCard}>
      <View style={styles.waveformCenterLine} />
      {waveform.min.map((minValue, index) => {
        const maxValue = waveform.max[index] ?? 0;
        const top = Math.max(0, (1 - Math.max(maxValue, 0)) * 50);
        const bottom = Math.max(0, (1 - Math.abs(Math.min(minValue, 0))) * 50);

        return (
          <View key={`wave-${index}`} style={styles.waveformColumn}>
            <View
              style={[
                styles.waveformPeak,
                {
                  top: `${top}%`,
                  bottom: `${bottom}%`,
                },
              ]}
            />
          </View>
        );
      })}
    </View>
  );
}

export default function HomeScreen() {
  const convex = useConvex();
  const convexAuth = useConvexAuth();
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const predictionSessions = useQuery(api.dataset.listPredictionSessions, convexAuth.isAuthenticated ? {} : 'skip');
  const pulseAnim = useRef(new Animated.Value(0)).current;
  const recordingStartedAtRef = useRef<number | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isRecordingAudio, setIsRecordingAudio] = useState(false);
  const [recordingElapsedMillis, setRecordingElapsedMillis] = useState(0);
  const [isSessionPickerVisible, setIsSessionPickerVisible] = useState(false);
  const [recentPredictions, setRecentPredictions] = useState<Prediction[]>([]);
  const [selectedPrediction, setSelectedPrediction] = useState<Prediction | null>(null);
  const insets = useSafeAreaInsets();

  useEffect(() => {
    if (!isRecordingAudio) {
      pulseAnim.stopAnimation();
      pulseAnim.setValue(0);
      recordingStartedAtRef.current = null;
      setRecordingElapsedMillis(0);
      return undefined;
    }

    recordingStartedAtRef.current = Date.now();
    setRecordingElapsedMillis(0);

    const timer = setInterval(() => {
      if (recordingStartedAtRef.current !== null) {
        setRecordingElapsedMillis(Date.now() - recordingStartedAtRef.current);
      }
    }, 250);

    const pulseLoop = Animated.loop(
      Animated.timing(pulseAnim, {
        toValue: 1,
        duration: 1500,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
    );
    pulseLoop.start();

    return () => {
      clearInterval(timer);
      pulseLoop.stop();
      pulseAnim.setValue(0);
    };
  }, [isRecordingAudio, pulseAnim]);

  const savePrediction = (body: unknown) => {
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

  const uploadAudioFile = async (audioUri: string, fileName?: string | null, mimeType?: string | null) => {
    if (!DEFAULT_SERVER_URL.trim()) {
      throw new Error('Missing EXPO_PUBLIC_AUDIO_API_URL for predictions.');
    }

    const resolvedFileName = getFileName(audioUri, fileName);
    const formData = new FormData();

    formData.append('file', {
      uri: audioUri,
      name: resolvedFileName,
      type: mimeType ?? getMimeType(resolvedFileName),
    } as unknown as Blob);
    formData.append('source', 'mobile-app');

    const response = await fetch(DEFAULT_SERVER_URL.trim(), {
      method: 'POST',
      body: formData,
    });

    const contentType = response.headers.get('content-type') ?? '';
    const body = contentType.includes('application/json') ? await response.json() : await response.text();

    if (!response.ok) {
      throw new Error(stringifyResponse(body) || `Prediction failed with status ${response.status}.`);
    }

    savePrediction(body);
  };

  const predictFromSourceUrl = async (sourceUrl: string, fileName: string, mimeType: string) => {
    if (!DEFAULT_SERVER_URL.trim()) {
      throw new Error('Missing EXPO_PUBLIC_AUDIO_API_URL for predictions.');
    }

    const response = await fetch(DEFAULT_SERVER_URL.trim(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        source: 'convex-session',
        sourceUrl,
        fileName,
        mimeType,
      }),
    });

    const contentType = response.headers.get('content-type') ?? '';
    const body = contentType.includes('application/json') ? await response.json() : await response.text();

    if (!response.ok) {
      throw new Error(
        `Prediction from collected sessions requires backend support for signed media URLs. Server returned ${response.status}: ${stringifyResponse(body)}`,
      );
    }

    savePrediction(body);
  };

  const pickAndPredict = async () => {
    if (isSubmitting) {
      return;
    }

    try {
      setErrorMessage(null);
      const result = await DocumentPicker.getDocumentAsync({
        type: 'audio/*',
        copyToCacheDirectory: true,
        multiple: false,
      });

      if (result.canceled) {
        return;
      }

      setIsSubmitting(true);
      const [asset] = result.assets;
      await uploadAudioFile(asset.uri, asset.name, asset.mimeType);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to predict vehicle.';
      setErrorMessage(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const startAudioPredictionRecording = async () => {
    if (isSubmitting || isRecordingAudio) {
      return;
    }

    try {
      setErrorMessage(null);
      const permission = await requestRecordingPermissionsAsync();
      if (!permission.granted) {
        setErrorMessage('Microphone permission is required to record an audio sample.');
        return;
      }

      await setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
      });
      await recorder.prepareToRecordAsync();
      recorder.record();
      setIsRecordingAudio(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to start audio recording.';
      setErrorMessage(message);
      setIsRecordingAudio(false);
    }
  };

  const stopAudioPredictionRecording = async () => {
    if (!isRecordingAudio || isSubmitting) {
      return;
    }

    try {
      setErrorMessage(null);
      setIsSubmitting(true);
      await recorder.stop();
      const uri = recorder.uri;
      if (!uri) {
        throw new Error('Audio recording stopped, but no file was created.');
      }

      await uploadAudioFile(uri, getFileName(uri, 'recorded-sample.m4a'), 'audio/mp4');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to predict recorded audio.';
      setErrorMessage(message);
    } finally {
      setIsRecordingAudio(false);
      setIsSubmitting(false);
      await setAudioModeAsync({
        allowsRecording: false,
        playsInSilentMode: true,
      }).catch(() => {});
    }
  };

  const predictFromCollectedSession = async (sessionId: Id<'sessions'>) => {
    if (isSubmitting) {
      return;
    }

    try {
      setErrorMessage(null);
      setIsSubmitting(true);
      setIsSessionPickerVisible(false);
      const sessionFile = await convex.query(api.dataset.getSessionPredictionUrl, { sessionId });
      await predictFromSourceUrl(sessionFile.url, sessionFile.fileName, sessionFile.fileType);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to predict from collected session.';
      setErrorMessage(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <View style={[styles.safeArea, { paddingTop: insets.top }]}> 
      <StatusBar style="light" />
      <View style={[styles.screen, { paddingBottom: BOTTOM_NAV_HEIGHT + Math.max(insets.bottom, 10) + 18 }]}> 
        <Text style={styles.heading}>CarZam</Text>

        <View style={styles.captureSection}>
          <View style={styles.listenButtonWrap}>
            {isRecordingAudio ? (
              <>
                <Animated.View
                  pointerEvents="none"
                  style={[
                    styles.recordingPulse,
                    {
                      opacity: pulseAnim.interpolate({
                        inputRange: [0, 0.7, 1],
                        outputRange: [0.48, 0.12, 0],
                      }),
                      transform: [
                        {
                          scale: pulseAnim.interpolate({
                            inputRange: [0, 1],
                            outputRange: [1, 1.42],
                          }),
                        },
                      ],
                    },
                  ]}
                />
                <Animated.View
                  pointerEvents="none"
                  style={[
                    styles.recordingPulse,
                    styles.recordingPulseDelayed,
                    {
                      opacity: pulseAnim.interpolate({
                        inputRange: [0, 0.35, 1],
                        outputRange: [0, 0.38, 0],
                      }),
                      transform: [
                        {
                          scale: pulseAnim.interpolate({
                            inputRange: [0, 0.35, 1],
                            outputRange: [0.9, 1, 1.28],
                          }),
                        },
                      ],
                    },
                  ]}
                />
              </>
            ) : null}
            <TouchableOpacity
              activeOpacity={0.86}
              disabled={isSubmitting}
              style={[
                styles.listenButton,
                isRecordingAudio && styles.listenButtonRecording,
                isSubmitting && styles.listenButtonDisabled,
              ]}
              onPress={isRecordingAudio ? stopAudioPredictionRecording : startAudioPredictionRecording}
            >
              {isSubmitting ? (
                <ActivityIndicator size="large" color="#FFFFFF" />
              ) : (
                <Ionicons name={isRecordingAudio ? 'stop' : 'mic-outline'} size={44} color="#FFFFFF" />
              )}
              <Text style={styles.listenTitle}>
                {isSubmitting ? 'Predicting…' : isRecordingAudio ? 'Stop and predict' : 'Record sample'}
              </Text>
              <Text style={[styles.durationText, isRecordingAudio && styles.recordingTimerText]}>
                {isRecordingAudio ? formatDuration(recordingElapsedMillis) : 'Tap to record'}
              </Text>
            </TouchableOpacity>
          </View>
          {!isRecordingAudio ? (
            <View style={styles.predictionActions}>
              <TouchableOpacity
                activeOpacity={0.86}
                disabled={isSubmitting}
                onPress={pickAndPredict}
                style={[
                  styles.predictionActionButton,
                  isSubmitting && styles.predictionActionButtonDisabled,
                ]}
              >
                <Ionicons name="cloud-upload-outline" size={18} color="#F8FAFC" />
                <Text style={styles.predictionActionText}>Upload audio</Text>
              </TouchableOpacity>
              <TouchableOpacity
                activeOpacity={0.86}
                disabled={isSubmitting || !convexAuth.isAuthenticated}
                onPress={() => setIsSessionPickerVisible(true)}
                style={[
                  styles.predictionActionButton,
                  (!convexAuth.isAuthenticated || isSubmitting) && styles.predictionActionButtonDisabled,
                ]}
              >
                <Ionicons name="albums-outline" size={18} color="#F8FAFC" />
                <Text style={styles.predictionActionText}>Collected session</Text>
              </TouchableOpacity>
            </View>
          ) : null}
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
                    <Text numberOfLines={1} style={styles.predictionRaw}>
                      {prediction.confidence !== undefined ? `Confidence ${formatConfidence(prediction.confidence)}` : prediction.raw}
                    </Text>
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
        visible={isSessionPickerVisible}
        presentationStyle="pageSheet"
        onRequestClose={() => setIsSessionPickerVisible(false)}
      >
        <View style={styles.modalScreen}>
          <TouchableOpacity
            activeOpacity={0.82}
            onPress={() => setIsSessionPickerVisible(false)}
            style={[styles.modalCloseButton, { top: insets.top + 14 }]}
          >
            <Ionicons name="close" size={24} color="#F8FAFC" />
          </TouchableOpacity>
          <ScrollView
            contentContainerStyle={[
              styles.sessionPickerContent,
              {
                paddingTop: insets.top + 88,
                paddingBottom: Math.max(insets.bottom, 20) + 32,
              },
            ]}
          >
            <Text style={styles.modalLabel}>Choose collected session</Text>
            <Text style={styles.sessionPickerHelp}>
              Select one of your uploaded collection recordings. The prediction backend must support signed Convex media URLs.
            </Text>
            {predictionSessions === undefined ? (
              <ActivityIndicator size="small" color="#38BDF8" />
            ) : predictionSessions.length === 0 ? (
              <View style={styles.sessionPickerEmpty}>
                <Ionicons name="albums-outline" size={26} color="#64748B" />
                <Text style={styles.emptyText}>No uploaded collection sessions yet.</Text>
              </View>
            ) : (
              predictionSessions.map((session) => (
                <TouchableOpacity
                  key={session.id}
                  activeOpacity={0.86}
                  disabled={isSubmitting}
                  onPress={() => {
                    void predictFromCollectedSession(session.id);
                  }}
                  style={styles.sessionPickerRow}
                >
                  <View style={styles.predictionIcon}>
                    <Ionicons name="videocam-outline" size={18} color="#38BDF8" />
                  </View>
                  <View style={styles.sessionPickerTextBlock}>
                    <Text numberOfLines={1} style={styles.sessionPickerTitle}>{getSessionDisplayName(session)}</Text>
                    <Text numberOfLines={1} style={styles.sessionPickerMeta}>
                      {formatDuration(session.durationMillis)}
                      {session.fileSizeBytes ? ` · ${formatBytes(session.fileSizeBytes)}` : ''}
                    </Text>
                  </View>
                  <Ionicons name="chevron-forward" size={18} color="#64748B" />
                </TouchableOpacity>
              ))
            )}
          </ScrollView>
        </View>
      </Modal>
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
              {selectedPrediction.confidence !== undefined ? (
                <Text style={styles.modalConfidence}>Confidence {formatConfidence(selectedPrediction.confidence)}</Text>
              ) : null}
              <Text style={styles.modalTime}>
                {new Date(selectedPrediction.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </Text>
              {selectedPrediction.modelVersion ? (
                <Text style={styles.modalModel}>Model {selectedPrediction.modelVersion}</Text>
              ) : null}

              <View style={styles.detailSection}>
                <Text style={styles.detailTitle}>Waveform</Text>
                <WaveformEnvelope waveform={selectedPrediction.waveform} />
                {selectedPrediction.audio ? (
                  <Text style={styles.audioMeta}>
                    {selectedPrediction.audio.durationSeconds.toFixed(2)}s · {selectedPrediction.audio.sampleRate} Hz · {selectedPrediction.audio.channels} channel
                    {selectedPrediction.audio.channels === 1 ? '' : 's'}
                  </Text>
                ) : null}
              </View>

              <View style={styles.detailSection}>
                <Text style={styles.detailTitle}>Class scores</Text>
                <View style={styles.scoreCard}>
                  {selectedPrediction.scores
                    ?.map(({ label, confidence }) => (
                      <View key={label} style={styles.scoreRow}>
                        <Text style={styles.scoreLabel}>{label}</Text>
                        <View style={styles.scoreTrack}>
                          <View style={[styles.scoreFill, { width: `${Math.round(confidence * 100)}%` }]} />
                        </View>
                        <Text style={styles.scoreValue}>{Math.round(confidence * 100)}%</Text>
                      </View>
                    ))}
                  {!selectedPrediction.scores ? (
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
  listenButtonWrap: {
    width: 276,
    height: 276,
    alignItems: 'center',
    justifyContent: 'center',
  },
  recordingPulse: {
    position: 'absolute',
    width: 226,
    height: 226,
    borderRadius: 113,
    backgroundColor: 'rgba(239, 68, 68, 0.26)',
    borderWidth: 1,
    borderColor: 'rgba(248, 113, 113, 0.34)',
  },
  recordingPulseDelayed: {
    backgroundColor: 'rgba(56, 189, 248, 0.18)',
    borderColor: 'rgba(56, 189, 248, 0.26)',
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
  listenButtonDisabled: {
    backgroundColor: '#1E293B',
    borderColor: '#38BDF8',
    opacity: 0.78,
  },
  listenButtonRecording: {
    backgroundColor: '#7F1D1D',
    borderColor: 'rgba(248, 113, 113, 0.48)',
    shadowColor: '#EF4444',
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
  recordingTimerText: {
    color: '#FECACA',
    fontSize: 22,
    fontWeight: '900',
  },
  predictionActions: {
    width: '100%',
    maxWidth: 390,
    flexDirection: 'row',
    gap: 10,
    marginTop: 18,
  },
  predictionActionButton: {
    flex: 1,
    minHeight: 48,
    borderRadius: 14,
    backgroundColor: '#111827',
    borderWidth: 1,
    borderColor: 'rgba(56, 189, 248, 0.22)',
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 10,
  },
  predictionActionButtonRecording: {
    backgroundColor: 'rgba(239, 68, 68, 0.18)',
    borderColor: 'rgba(248, 113, 113, 0.44)',
  },
  predictionActionButtonDisabled: {
    opacity: 0.48,
  },
  predictionActionText: {
    color: '#F8FAFC',
    fontSize: 12,
    fontWeight: '800',
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
  sessionPickerContent: {
    paddingHorizontal: 24,
    gap: 12,
  },
  sessionPickerHelp: {
    color: '#94A3B8',
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 4,
  },
  sessionPickerEmpty: {
    minHeight: 140,
    borderRadius: 20,
    backgroundColor: '#0B1220',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  sessionPickerRow: {
    minHeight: 72,
    borderRadius: 18,
    backgroundColor: '#0B1220',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    padding: 14,
  },
  sessionPickerTextBlock: {
    flex: 1,
    minWidth: 0,
  },
  sessionPickerTitle: {
    color: '#F8FAFC',
    fontSize: 15,
    fontWeight: '800',
  },
  sessionPickerMeta: {
    color: '#94A3B8',
    fontSize: 12,
    fontWeight: '700',
    marginTop: 4,
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
  modalModel: {
    color: '#475569',
    fontSize: 12,
    fontWeight: '700',
    marginTop: 8,
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
    paddingVertical: 16,
    flexDirection: 'row',
    alignItems: 'center',
    overflow: 'hidden',
  },
  waveformEmptyCard: {
    justifyContent: 'center',
    gap: 8,
  },
  waveformEmptyText: {
    color: '#64748B',
    fontSize: 14,
    fontWeight: '700',
  },
  waveformCenterLine: {
    position: 'absolute',
    left: 14,
    right: 14,
    top: '50%',
    height: 1,
    backgroundColor: 'rgba(148, 163, 184, 0.18)',
  },
  waveformColumn: {
    flex: 1,
    height: 96,
    justifyContent: 'center',
  },
  waveformPeak: {
    position: 'absolute',
    left: 0,
    right: 0,
    borderRadius: 999,
    backgroundColor: '#38BDF8',
    opacity: 0.72,
  },
  audioMeta: {
    color: '#64748B',
    fontSize: 12,
    fontWeight: '700',
    marginTop: 10,
    textAlign: 'center',
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
