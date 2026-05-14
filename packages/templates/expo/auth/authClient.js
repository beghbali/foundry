/**
 * Supabase Auth helpers.
 * Replace `SUPABASE_URL` / `SUPABASE_ANON_KEY` with your project values
 * or import from your existing `lib/supabase.ts`.
 */
// import { supabase } from '@/lib/supabase';
export async function signInWithEmail(email) {
    // const { error } = await supabase.auth.signInWithOtp({ email });
    // if (error) throw error;
    console.log('[auth] magic link sent to', email);
}
export async function signInWithApple() {
    // const { error } = await supabase.auth.signInWithOAuth({ provider: 'apple' });
    // if (error) throw error;
    console.log('[auth] Apple sign-in initiated');
}
export async function signInWithGoogle() {
    // const { error } = await supabase.auth.signInWithOAuth({ provider: 'google' });
    // if (error) throw error;
    console.log('[auth] Google sign-in initiated');
}
export async function signOut() {
    // const { error } = await supabase.auth.signOut();
    // if (error) throw error;
    console.log('[auth] signed out');
}
