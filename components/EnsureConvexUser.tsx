import { useEffect, useRef } from 'react';
import { useAuth } from '@clerk/clerk-expo';
import { useMutation } from 'convex/react';

import { api } from '@/convex/_generated/api';

export function EnsureConvexUser() {
  const { isLoaded, userId } = useAuth();
  const createOrGetCurrentUser = useMutation(api.users.createOrGetCurrentUser);
  const lastEnsuredUserId = useRef<string | null>(null);

  useEffect(() => {
    if (!isLoaded || !userId || lastEnsuredUserId.current === userId) {
      return;
    }

    lastEnsuredUserId.current = userId;
    createOrGetCurrentUser({}).catch(() => {
      lastEnsuredUserId.current = null;
    });
  }, [createOrGetCurrentUser, isLoaded, userId]);

  return null;
}
