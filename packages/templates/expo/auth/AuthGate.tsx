import type { ReactNode } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

interface Props {
  isLoading: boolean;
  isAuthenticated: boolean;
  children: ReactNode;
  fallback: ReactNode;
}

/**
 * Wraps the app tree to enforce authentication.
 * Shows `fallback` (e.g. SignInScreen) when unauthenticated.
 *
 * Usage in _layout.tsx:
 * ```tsx
 * <AuthGate
 *   isLoading={authStore.isLoading}
 *   isAuthenticated={authStore.isAuthenticated}
 *   fallback={<SignInScreen />}
 * >
 *   <Stack />
 * </AuthGate>
 * ```
 */
export function AuthGate({ isLoading, isAuthenticated, children, fallback }: Props) {
  if (isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" />
      </View>
    );
  }
  return <>{isAuthenticated ? children : fallback}</>;
}

const styles = StyleSheet.create({
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
});
