import { ClerkProvider, useAuth } from "@clerk/clerk-expo";
import { tokenCache } from "@clerk/clerk-expo/token-cache";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { ConvexProviderWithClerk } from "convex/react-clerk";
import { Stack } from "expo-router";
import { SafeAreaProvider } from "react-native-safe-area-context";

const convexUrl = process.env.EXPO_PUBLIC_CONVEX_URL;
const clerkPublishableKey = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY;
const convex = convexUrl
  ? new ConvexReactClient(convexUrl, { unsavedChangesWarning: false })
  : null;

export default function RootLayout() {
  const content = (
    <SafeAreaProvider>
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: "#121212" },
        }}
      />
    </SafeAreaProvider>
  );

  if (!convex) {
    return content;
  }

  if (clerkPublishableKey) {
    return (
      <ClerkProvider publishableKey={clerkPublishableKey} tokenCache={tokenCache}>
        <ConvexProviderWithClerk client={convex} useAuth={useAuth}>
          {content}
        </ConvexProviderWithClerk>
      </ClerkProvider>
    );
  }

  return <ConvexProvider client={convex}>{content}</ConvexProvider>;
}
