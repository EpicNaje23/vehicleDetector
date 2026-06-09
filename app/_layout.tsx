import { ClerkProvider, useAuth } from "@clerk/clerk-expo";
import { tokenCache } from "@clerk/clerk-expo/token-cache";
import { ConvexProvider, ConvexProviderWithAuth, ConvexReactClient } from "convex/react";
import { Stack } from "expo-router";
import { useCallback, useMemo } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

const convexUrl = process.env.EXPO_PUBLIC_CONVEX_URL;
const clerkPublishableKey = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY;
const convex = convexUrl
  ? new ConvexReactClient(convexUrl, { unsavedChangesWarning: false })
  : null;

function useConvexAuthFromClerk() {
  const { isLoaded, isSignedIn, getToken, orgId, orgRole } = useAuth();

  const fetchAccessToken = useCallback(
    async ({ forceRefreshToken }: { forceRefreshToken: boolean }) => {
      try {
        // Always request the custom Clerk JWT template so Convex receives profile claims.
        return await getToken({
          template: "convex",
          skipCache: forceRefreshToken,
        });
      } catch {
        return null;
      }
    },
    // Clerk Expo's getToken is not memoized; match Convex's official Clerk wrapper behavior.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [orgId, orgRole],
  );

  return useMemo(
    () => ({
      isLoading: !isLoaded,
      isAuthenticated: isSignedIn ?? false,
      fetchAccessToken,
    }),
    [isLoaded, isSignedIn, fetchAccessToken],
  );
}

export default function RootLayout() {
  const content = (
    <SafeAreaProvider>
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: "#05060A" },
          animation: "fade",
          animationDuration: 180,
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
        <ConvexProviderWithAuth client={convex} useAuth={useConvexAuthFromClerk}>
          {content}
        </ConvexProviderWithAuth>
      </ClerkProvider>
    );
  }

  return <ConvexProvider client={convex}>{content}</ConvexProvider>;
}
