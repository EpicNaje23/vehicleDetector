import { ClerkProvider, useAuth } from "@clerk/clerk-expo";
import { tokenCache } from "@clerk/clerk-expo/token-cache";
import { ConvexProvider, ConvexProviderWithAuth, ConvexReactClient } from "convex/react";
import { Stack } from "expo-router";
import { useCallback, useMemo } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { EnsureConvexUser } from "@/components/EnsureConvexUser";

const convexUrl = process.env.EXPO_PUBLIC_CONVEX_URL
const clerkPublishableKey = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY;
const convex = convexUrl
  ? new ConvexReactClient(convexUrl, { unsavedChangesWarning: false })
  : null;


// Costom Hook  che permette a Convex di usare l’autenticazione Clerk.
function useConvexAuthFromClerk() {
    const { isLoaded, isSignedIn, getToken, orgId, orgRole } = useAuth();

    //Ponte tra Clerk e Convex per ottenere un token di accesso.
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
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [orgId, orgRole],
    );


    //Oggetto che viene restituito a Convex per indicare lo stato di autenticazione e fornire il metodo per ottenere il token di accesso.
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
          <EnsureConvexUser />
          {content}
        </ConvexProviderWithAuth>
      </ClerkProvider>
    );
  }

  return <ConvexProvider client={convex}>{content}</ConvexProvider>;
}
