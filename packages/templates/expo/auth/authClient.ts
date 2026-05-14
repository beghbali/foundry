/**
 * Supabase Auth helpers.
 * Replace `SUPABASE_URL` / `SUPABASE_ANON_KEY` with your project values
 * or import from your existing `lib/supabase.ts`.
 */

// import { supabase } from '@/lib/supabase';

export async function signInWithEmail(email: string): Promise<void> {
  // const { error } = await supabase.auth.signInWithOtp({ email });
  // if (error) throw error;
  console.log('[auth] magic link sent to', email);
}

export async function signInWithApple(): Promise<void> {
  // const { error } = await supabase.auth.signInWithOAuth({ provider: 'apple' });
  // if (error) throw error;
  console.log('[auth] Apple sign-in initiated');
}

export async function signInWithGoogle(): Promise<void> {
  // const { error } = await supabase.auth.signInWithOAuth({ provider: 'google' });
  // if (error) throw error;
  console.log('[auth] Google sign-in initiated');
}

export async function signOut(): Promise<void> {
  // const { error } = await supabase.auth.signOut();
  // if (error) throw error;
  console.log('[auth] signed out');
}
