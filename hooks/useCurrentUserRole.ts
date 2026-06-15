import { useAuth } from '@clerk/clerk-expo';
import { useQuery } from 'convex/react';

import { api } from '@/convex/_generated/api';

export function useCurrentUserRole() {
  const { isLoaded, userId } = useAuth();
  const currentUser = useQuery(api.users.getMe, isLoaded && userId ? {} : 'skip');
  const isLoading = !isLoaded || (Boolean(userId) && currentUser === undefined);
  const role = currentUser?.role;

  return {
    currentUser: currentUser ?? null,
    isLoading,
    isRegisteredUser: role === 'user',
    isAdmin: role === 'admin',
  };
}
