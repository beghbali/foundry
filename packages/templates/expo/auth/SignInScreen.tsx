import { useState } from 'react';
import { Alert, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';

interface Props {
  onEmailSignIn: (email: string) => Promise<void>;
  onAppleSignIn?: () => Promise<void>;
  onGoogleSignIn?: () => Promise<void>;
}

/**
 * Minimal sign-in screen with email magic link + optional social providers.
 * Adapt styling and branding to your app.
 */
export function SignInScreen({ onEmailSignIn, onAppleSignIn, onGoogleSignIn }: Props) {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);

  const handleEmail = async () => {
    if (!email.trim()) return;
    setLoading(true);
    try {
      await onEmailSignIn(email.trim());
      setSent(true);
    } catch (e: any) {
      Alert.alert('Error', e?.message ?? 'Could not send sign-in link.');
    } finally {
      setLoading(false);
    }
  };

  if (sent) {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>Check your email</Text>
        <Text style={styles.subtitle}>We sent a sign-in link to {email}</Text>
        <TouchableOpacity onPress={() => setSent(false)} style={styles.linkBtn}>
          <Text style={styles.linkText}>Use a different email</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Welcome</Text>
      <Text style={styles.subtitle}>Sign in to continue</Text>

      <TextInput
        style={styles.input}
        placeholder="Email address"
        placeholderTextColor="#999"
        value={email}
        onChangeText={setEmail}
        keyboardType="email-address"
        autoCapitalize="none"
        autoCorrect={false}
      />
      <TouchableOpacity
        onPress={handleEmail}
        disabled={loading || !email.trim()}
        style={[styles.primaryBtn, (loading || !email.trim()) && styles.disabledBtn]}
      >
        <Text style={styles.primaryText}>{loading ? 'Sending...' : 'Continue with email'}</Text>
      </TouchableOpacity>

      {(onAppleSignIn || onGoogleSignIn) && (
        <>
          <View style={styles.divider}>
            <View style={styles.dividerLine} />
            <Text style={styles.dividerText}>or</Text>
            <View style={styles.dividerLine} />
          </View>

          {onAppleSignIn && (
            <TouchableOpacity onPress={onAppleSignIn} style={styles.socialBtn}>
              <Text style={styles.socialText}>Continue with Apple</Text>
            </TouchableOpacity>
          )}
          {onGoogleSignIn && (
            <TouchableOpacity onPress={onGoogleSignIn} style={styles.socialBtn}>
              <Text style={styles.socialText}>Continue with Google</Text>
            </TouchableOpacity>
          )}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', paddingHorizontal: 24, backgroundColor: '#fff' },
  title: { fontSize: 28, fontWeight: '700', color: '#111', marginBottom: 4 },
  subtitle: { fontSize: 16, color: '#666', marginBottom: 24 },
  input: {
    backgroundColor: '#f5f5f5',
    borderRadius: 12,
    padding: 14,
    fontSize: 16,
    color: '#111',
    borderWidth: 1,
    borderColor: '#e0e0e0',
    marginBottom: 12,
  },
  primaryBtn: { backgroundColor: '#2d6a4f', paddingVertical: 14, borderRadius: 12, alignItems: 'center' },
  disabledBtn: { backgroundColor: '#ccc' },
  primaryText: { fontSize: 16, fontWeight: '600', color: '#fff' },
  divider: { flexDirection: 'row', alignItems: 'center', marginVertical: 20 },
  dividerLine: { flex: 1, height: 1, backgroundColor: '#e0e0e0' },
  dividerText: { marginHorizontal: 12, color: '#999', fontSize: 14 },
  socialBtn: {
    borderWidth: 1,
    borderColor: '#e0e0e0',
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    marginBottom: 10,
  },
  socialText: { fontSize: 16, fontWeight: '500', color: '#111' },
  linkBtn: { marginTop: 16, alignItems: 'center' },
  linkText: { fontSize: 14, color: '#2d6a4f' },
});
