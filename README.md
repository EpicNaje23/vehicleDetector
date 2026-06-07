# CarZam

CarZam is an Expo / React Native app for vehicle audio prediction and dataset collection.

## What The App Does

- Predicts a vehicle class from a short audio recording using `EXPO_PUBLIC_AUDIO_API_URL`.
- Lets signed-in contributors record longer video/audio sessions for dataset collection.
- Uploads collection sessions to Convex Storage with metadata, approximate location, and contributor identity.
- Shows anonymized collection points on a dataset map.
- Provides support contact details in the Account tab.

## Required Services

- Expo / EAS for native Android and iOS builds.
- Clerk for contributor authentication.
- Convex for dataset metadata and storage.
- A permanently hosted prediction backend for public prediction testing.

Do not use a laptop URL or temporary tunnel for broad tester distribution. Dataset collection can work through Convex, but prediction needs a stable hosted API.

## Environment Variables

App environment:

```bash
EXPO_PUBLIC_AUDIO_API_URL=https://your-prediction-api.example.com/predict
EXPO_PUBLIC_CONVEX_URL=https://your-deployment.convex.cloud
EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_live_or_test_...
```

Convex environment:

```bash
CLERK_FRONTEND_API_URL=https://your-clerk-instance.clerk.accounts.dev
```

Clerk must include a JWT template named `convex` with audience `convex`.

## Local Verification

```bash
pnpm install
pnpm exec tsc --noEmit
pnpm lint
pnpm exec expo install --check
```

Start local development:

```bash
pnpm start
```

Run with a development build:

```bash
npx expo start --dev-client
```

## Native Build Profiles

Android development build:

```bash
npx eas build --profile development --platform android
```

iOS development build:

```bash
npx eas build --profile development --platform ios
```

Preview builds for testers:

```bash
npx eas build --profile preview --platform android
npx eas build --profile preview --platform ios
```

Production builds:

```bash
npx eas build --profile production --platform android
npx eas build --profile production --platform ios
```

## Data Collection Guidance For Testers

- Record vehicles only in safe public or outdoor areas.
- Avoid filming faces, private spaces, license plates, or sensitive information when possible.
- Use clear location names such as city, street, station, or road area.
- Keep the phone stable and avoid covering the microphone.
- Prefer recordings with clear vehicle sound and limited conversation/background noise.
- Stop recording if anyone nearby asks not to be recorded.

Collection uploads include video, audio, approximate location, device information, and contributor account metadata. Contributors can contact support from the Account tab.

## Pre-Deployment Checklist

- Confirm final production backend URL is set in `EXPO_PUBLIC_AUDIO_API_URL`.
- Confirm Clerk production keys and the Convex JWT template work.
- Confirm Convex production environment has `CLERK_FRONTEND_API_URL`.
- Test sign up, sign in, prediction, collection upload, map pins, and support links on real Android and iPhone devices.
- Confirm camera, microphone, and location denial states are understandable.
- Confirm Convex Storage capacity and cost expectations for video collection.
- Prepare a tester onboarding message with install links, collection guidance, and support contact.

## Known Limitations

- Push notifications are intentionally on hold.
- Broad iOS testing requires Apple Developer / TestFlight setup.
- Broad Android testing should use APK/internal testing or Play Store internal testing.
- The app stores collection locations for dataset mapping; map coordinates are rounded before display.
