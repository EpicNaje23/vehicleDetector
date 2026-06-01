# vehicleDetector

A React Native / Expo app that classifies vehicles using only their engine sound using machine learning.

## Features

- Upload or record vehicle engine sound
- Classify the vehicle based on audio only (no images)
- Designed to support idle and moving recordings

## Tech Stack

- React Native / Expo
- TypeScript
- (Planned) Machine learning model for audio classification

## Getting Started

Set `EXPO_PUBLIC_AUDIO_API_URL` before starting the app so uploads know where to go:

```bash
EXPO_PUBLIC_AUDIO_API_URL=http://192.168.x.x:8000/predict pnpm start
```

The app records audio with `expo-audio`, uploads it as multipart form data under the `file` field, and renders either a JSON or plain-text response from the server.
